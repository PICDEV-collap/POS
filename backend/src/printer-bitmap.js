// Bitmap-mode receipts: render Thai with a real TTF, threshold to 1-bit,
// and encode as ESC/POS raster (GS v 0). Use this for printers whose built-in
// Thai font is broken (sara/maitaikhu placement off).

const fs = require('fs');
const path = require('path');
const canvasLib = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const { paymentQrMeta } = require('./lib/thaiQrPayment');

const ESC = 0x1b;
const GS  = 0x1d;
const INIT       = Buffer.from([ESC, 0x40]);
const ALIGN_C    = Buffer.from([ESC, 0x61, 0x01]);
const ALIGN_L    = Buffer.from([ESC, 0x61, 0x00]);
const CUT_FULL   = Buffer.from([GS, 0x56, 0x00]);
const CUT_PARTIAL= Buffer.from([GS, 0x56, 0x01]);

function feedLines(opts = {}) {
  const configured = Number(opts.feedLines ?? process.env.PRINTER_FEED_LINES);
  const lines = Number.isFinite(configured) ? configured : 4;
  const clamped = Math.max(0, Math.min(24, Math.floor(lines)));
  return clamped > 0 ? Buffer.from([ESC, 0x64, clamped]) : Buffer.alloc(0);
}

function cutCommand(opts = {}, fallback = 'partial') {
  const mode = String(opts.cutMode || opts.cut_mode || fallback || 'partial').toLowerCase();
  if (mode === 'none') return Buffer.alloc(0);
  return mode === 'full' ? CUT_FULL : CUT_PARTIAL;
}

function bottomFeedPx(opts = {}) {
  const configured = Number(
    opts.bottomFeedPx ??
    process.env.PRINTER_BITMAP_BOTTOM_FEED_PX ??
    process.env.PRINTER_BOTTOM_FEED_PX
  );
  const px = Number.isFinite(configured) ? configured : 80;
  return Math.max(0, Math.min(1200, Math.floor(px)));
}

function rasterBandHeight(opts = {}) {
  const configured = Number(opts.rasterBandHeight ?? process.env.PRINTER_RASTER_BAND_HEIGHT);
  const px = Number.isFinite(configured) ? configured : 128;
  return Math.max(64, Math.min(256, Math.floor(px)));
}

function orderSequence(order) { return order?.daily_seq || order?.id; }
function orderQueueLabel(order) { return `ลำดับที่ ${orderSequence(order)}`; }
function itemFulfillmentType(order, item) {
  return item?.fulfillment_type === 'takeaway' ? 'takeaway' : (order?.order_type === 'takeaway' ? 'takeaway' : 'dine-in');
}
function fulfillmentText(type) { return type === 'takeaway' ? 'กลับบ้าน' : 'ทานที่ร้าน'; }
function fulfillmentSummary(order) {
  const types = new Set((order?.items || []).map((it) => itemFulfillmentType(order, it)));
  if (types.size > 1) return 'mixed';
  return types.has('takeaway') ? 'takeaway' : 'dine-in';
}
function orderModeLabel(order) {
  const summary = order?.fulfillment_summary || fulfillmentSummary(order);
  if (summary === 'mixed') return 'ทานที่ร้าน + กลับบ้าน';
  return fulfillmentText(summary);
}
function orderLocationLabel(order) {
  const summary = order?.fulfillment_summary || fulfillmentSummary(order);
  if (summary === 'mixed') {
    return `${order?.table_name || `Table ${order?.table_id}`} / มีรับกลับบ้าน`;
  }
  if (summary === 'takeaway') {
    return order.customer_name ? `กลับบ้าน: ${order.customer_name}` : 'สั่งกลับบ้าน';
  }
  return order.table_name || `Table ${order.table_id}`;
}
function kitchenSections(order) {
  const indexed = (order?.items || []).map((item, index) => ({
    item,
    index,
    type: itemFulfillmentType(order, item),
  }));
  const hasDineIn = indexed.some((x) => x.type === 'dine-in');
  const hasTakeaway = indexed.some((x) => x.type === 'takeaway');
  if (!hasDineIn || !hasTakeaway) {
    return [{ type: hasTakeaway ? 'takeaway' : 'dine-in', label: fulfillmentText(hasTakeaway ? 'takeaway' : 'dine-in'), items: indexed }];
  }
  return [
    { type: 'dine-in', label: 'ทานที่ร้าน', items: indexed.filter((x) => x.type === 'dine-in') },
    { type: 'takeaway', label: 'กลับบ้าน', items: indexed.filter((x) => x.type === 'takeaway') },
  ];
}

let _fontRegistered = false;
function ensureFont(fontPath) {
  if (_fontRegistered) return true;
  const tryPaths = [
    fontPath,
    process.env.PRINTER_FONT_PATH,
    'C:/Windows/Fonts/tahoma.ttf',
    'C:/Windows/Fonts/leelawui.ttf',
    '/usr/share/fonts/truetype/tlwg/Sarabun-Regular.ttf',
    '/System/Library/Fonts/Supplemental/Tahoma.ttf',
  ].filter(Boolean);
  for (const p of tryPaths) {
    try {
      if (fs.existsSync(p)) {
        canvasLib.GlobalFonts.registerFromPath(p, 'PosThai');
        _fontRegistered = true;
        console.log(`[printer-bitmap] font: ${p}`);
        return true;
      }
    } catch (e) { /* try next */ }
  }
  console.error('[printer-bitmap] no Thai font found — set PRINTER_FONT_PATH');
  return false;
}

function qrRenderInfo(payload, width, requestedSize) {
  const qr = QRCode.create(String(payload), { errorCorrectionLevel: 'M' });
  const quiet = 4;
  const matrixSize = qr.modules.size;
  const maxSize = Math.max(120, Math.min(requestedSize || Math.floor(width * 0.68), width - 24));
  const cell = Math.max(2, Math.floor(maxSize / (matrixSize + quiet * 2)));
  const pixelSize = cell * (matrixSize + quiet * 2);
  return { qr, quiet, matrixSize, cell, pixelSize };
}

// Render an array of {text, size, bold, align} lines to a canvas, return ImageData
function renderLines(lines, width, opts) {
  const lineSpacing = opts.lineSpacing || 1.2;
  // First pass: measure total height
  const dummy = canvasLib.createCanvas(1, 1).getContext('2d');
  let totalH = opts.padTop || 8;
  const sized = lines.map((l) => {
    if (l.qr) {
      const qr = qrRenderInfo(l.qr, width, l.sizePx);
      return { ...l, _qr: qr, _h: qr.pixelSize + (l.marginBottom ?? 10) };
    }
    const size = l.size || 22;
    dummy.font = `${l.bold ? 'bold ' : ''}${size}px PosThai`;
    return { ...l, size, _h: Math.ceil(size * lineSpacing) };
  });
  for (const s of sized) totalH += s._h;
  totalH += opts.padBottom || 8;

  const canvas = canvasLib.createCanvas(width, totalH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, width, totalH);
  ctx.fillStyle = 'black';
  ctx.textBaseline = 'top';

  let y = opts.padTop || 8;
  for (const s of sized) {
    if (s.qr) {
      const q = s._qr;
      const x = Math.max(0, Math.floor((width - q.pixelSize) / 2));
      ctx.fillStyle = 'white';
      ctx.fillRect(x, y, q.pixelSize, q.pixelSize);
      ctx.fillStyle = 'black';
      for (let row = 0; row < q.matrixSize; row++) {
        for (let col = 0; col < q.matrixSize; col++) {
          const dark = typeof q.qr.modules.get === 'function'
            ? q.qr.modules.get(row, col)
            : q.qr.modules.data[row * q.matrixSize + col];
          if (dark) {
            ctx.fillRect(
              x + (col + q.quiet) * q.cell,
              y + (row + q.quiet) * q.cell,
              q.cell,
              q.cell
            );
          }
        }
      }
      y += s._h;
      continue;
    }
    ctx.font = `${s.bold ? 'bold ' : ''}${s.size}px PosThai`;
    if (s.rule) {
      // horizontal rule
      const lineY = y + Math.floor(s._h / 2);
      const dashChar = s.rule;
      let row = '';
      while (ctx.measureText(row + dashChar).width < width - 8) row += dashChar;
      ctx.fillText(row, 4, y);
    } else {
      const text = s.text || '';
      let x = 4;
      if (s.align === 'center') {
        const w = ctx.measureText(text).width;
        x = Math.max(0, Math.floor((width - w) / 2));
      } else if (s.align === 'right') {
        const w = ctx.measureText(text).width;
        x = Math.max(0, width - 4 - Math.ceil(w));
      } else if (s.right) {
        // pair: left text + right text on same line
        ctx.fillText(text, 4, y);
        const rw = ctx.measureText(s.right).width;
        ctx.fillText(s.right, Math.max(0, width - 4 - Math.ceil(rw)), y);
        y += s._h;
        continue;
      }
      ctx.fillText(text, x, y);
    }
    y += s._h;
  }
  return ctx.getImageData(0, 0, width, totalH);
}

// Convert RGBA ImageData → 1-bit packed monochrome bitmap (MSB-first).
// Returns { data: Buffer, widthBytes, height, width }.
// Pure raw bitmap — no protocol header. Use rasterFromImageData for ESC/POS.
function rawBitmapFromImageData(img, startY = 0, bandHeight = img.height) {
  const W = img.width;
  const H = Math.max(0, Math.min(bandHeight, img.height - startY));
  const widthBytes = Math.ceil(W / 8);
  const padW = widthBytes * 8;
  const out = Buffer.alloc(widthBytes * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < padW; x++) {
      let dark = 0;
      if (x < W) {
        const i = ((startY + y) * W + x) * 4;
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        const lum = (r * 0.299 + g * 0.587 + b * 0.114);
        dark = lum < 128 ? 1 : 0;
      }
      if (dark) {
        const byteIdx = y * widthBytes + (x >> 3);
        out[byteIdx] |= (0x80 >> (x & 7));
      }
    }
  }
  return { data: out, widthBytes, height: H, width: W };
}

// ESC/POS raster GS v 0 m=0 — wraps raw bitmap with ESC/POS header.
function rasterBandFromImageData(img, startY, bandHeight) {
  const r = rawBitmapFromImageData(img, startY, bandHeight);
  const xL = r.widthBytes & 0xff;
  const xH = (r.widthBytes >> 8) & 0xff;
  const yL = r.height & 0xff;
  const yH = (r.height >> 8) & 0xff;
  return Buffer.concat([
    Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]),
    r.data,
  ]);
}

function rasterFromImageData(img, opts = {}) {
  const bandH = rasterBandHeight(opts);
  const parts = [];
  for (let y = 0; y < img.height; y += bandH) {
    parts.push(rasterBandFromImageData(img, y, Math.min(bandH, img.height - y)));
  }
  return Buffer.concat(parts);
}

// ─── Receipt builders ────────────────────────────────────────────────────
function buildKitchenBitmap(order, opts = {}) {
  ensureFont(opts.fontPath);
  // Width in pixels: 58mm=384, 80mm=576. Char width ~42 with default font.
  const widthPx = opts.widthPx || (opts.width >= 48 ? 576 : 384);

  const lines = [];
  lines.push({ text: `** ${opts.stationLabel || opts.station_label || 'KITCHEN'} **`, size: 34, bold: true, align: 'center' });
  lines.push({ text: orderQueueLabel(order), size: 34, bold: true, align: 'center' });
  lines.push({ text: orderLocationLabel(order), size: 32, bold: true, align: 'center' });
  lines.push({ text: orderModeLabel(order), size: 28, bold: true, align: 'center' });
  lines.push({ text: `Order #${order.id}    ${new Date(order.created_at).toLocaleString('th-TH')}`, size: 20 });
  if (order.source) lines.push({ text: `source: ${order.source}`, size: 18 });
  lines.push({ rule: '-', size: 20 });

  for (const section of kitchenSections(order)) {
    lines.push({ text: `-- ${section.label} --`, size: 28, bold: true });
    for (const { item: it, index } of section.items) {
      const variantSuffix = it.variant_name ? ` (${it.variant_name})` : '';
      lines.push({ text: `${index + 1}. ${it.quantity} x ${it.product_name}${variantSuffix}`, size: 30, bold: true });
      if (Array.isArray(it.options_selected) && it.options_selected.length) {
        lines.push({ text: `   > ${it.options_selected.map((o) => o.value).join(' · ')}`, size: 22 });
      }
      if (it.note) lines.push({ text: `   *${it.note}`, size: 22 });
    }
  }
  lines.push({ rule: '-', size: 20 });
  if (order.note) {
    lines.push({ text: `NOTE: ${order.note}`, size: 24, bold: true });
    lines.push({ rule: '-', size: 20 });
  }

  const img = renderLines(lines, widthPx, { padTop: 8, padBottom: bottomFeedPx(opts) });
  return Buffer.concat([INIT, ALIGN_L, rasterFromImageData(img, opts), feedLines(opts), cutCommand(opts, 'partial')]);
}

function buildReceiptBitmap(order, opts = {}) {
  ensureFont(opts.fontPath);
  const widthPx = opts.widthPx || (opts.width >= 48 ? 576 : 384);
  const restaurantName = opts.restaurantName || 'POS V2';

  const lines = [];
  lines.push({ text: restaurantName, size: 34, bold: true, align: 'center' });
  lines.push({ text: '--- ใบเสร็จ / RECEIPT ---', size: 20, align: 'center' });
  lines.push({ text: orderQueueLabel(order), right: orderLocationLabel(order), size: 20 });
  lines.push({ text: `Order #${order.id}`, size: 18 });
  lines.push({ text: new Date(order.created_at).toLocaleString('th-TH'), size: 18 });
  lines.push({ rule: '-', size: 20 });

  for (const [index, it] of order.items.entries()) {
    const variantSuffix = it.variant_name ? ` (${it.variant_name})` : '';
    lines.push({ text: `${index + 1}. ${it.quantity} x ${it.product_name}${variantSuffix}`, size: 24 });
    lines.push({ text: `  [${fulfillmentText(itemFulfillmentType(order, it))}]`, size: 17 });
    const lineTotal = (Number(it.unit_price) * it.quantity).toFixed(2);
    lines.push({ text: `  @${Number(it.unit_price).toFixed(2)}`, right: lineTotal, size: 18 });
    if (Array.isArray(it.options_selected) && it.options_selected.length) {
      lines.push({ text: `  > ${it.options_selected.map((o) => o.value).join(' · ')}`, size: 17 });
    }
    if (it.note) lines.push({ text: `  *${it.note}`, size: 17 });
  }
  lines.push({ rule: '-', size: 20 });
  lines.push({ text: 'TOTAL', right: Number(order.total_amount).toFixed(2), size: 30, bold: true });
  lines.push({ rule: '=', size: 20 });
  const paymentQr = paymentQrMeta(order, opts.paymentSettings || opts);
  if (paymentQr) {
    lines.push({ text: paymentQr.label, size: 24, bold: true, align: 'center' });
    lines.push({ qr: paymentQr.payload, sizePx: Math.min(300, widthPx - 48) });
    if (paymentQr.accountName) lines.push({ text: paymentQr.accountName, size: 18, align: 'center' });
    if (paymentQr.accountId) lines.push({ text: `รหัส: ${paymentQr.accountId}`, size: 18, align: 'center' });
    if (paymentQr.includeAmount) {
      lines.push({ text: `ยอดชำระ ${Number(order.total_amount).toFixed(2)} บาท`, size: 20, bold: true, align: 'center' });
    }
    lines.push({ rule: '-', size: 18 });
  }
  lines.push({ text: 'ขอบคุณที่ใช้บริการ', size: 22, align: 'center' });
  lines.push({ text: 'Thank you', size: 18, align: 'center' });

  const img = renderLines(lines, widthPx, { padTop: 8, padBottom: bottomFeedPx(opts) });
  return Buffer.concat([INIT, ALIGN_L, rasterFromImageData(img, opts), feedLines(opts), cutCommand(opts, 'full')]);
}

function buildTestBitmap(opts = {}) {
  ensureFont(opts.fontPath);
  const widthPx = opts.widthPx || 384;
  const lines = [
    { text: 'PRINT TEST (BITMAP)', size: 32, bold: true, align: 'center' },
    { text: '--- ทดสอบภาษาไทย ---', size: 24, align: 'center' },
    { text: 'สวัสดีครับ ปริ้นเตอร์ทำงานปกติ', size: 28, bold: true },
    { text: 'พยัญชนะ สระ วรรณยุกต์ พ่อ แม่ ปี่', size: 26 },
    { text: 'ABC 123 abc !@#$%', size: 22 },
    { rule: '-', size: 20 },
  ];
  const img = renderLines(lines, widthPx, { padTop: 8, padBottom: bottomFeedPx(opts) });
  return Buffer.concat([INIT, ALIGN_L, rasterFromImageData(img, opts), feedLines(opts), cutCommand(opts, 'partial')]);
}

module.exports = {
  buildKitchenBitmap,
  buildReceiptBitmap,
  buildTestBitmap,
  rasterFromImageData,
  rawBitmapFromImageData,
  renderLines,
  ensureFont,
  bottomFeedPx,
  rasterBandHeight,
};

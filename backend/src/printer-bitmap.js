// Bitmap-mode receipts: render Thai with a real TTF, threshold to 1-bit,
// and encode as ESC/POS raster (GS v 0). Use this for printers whose built-in
// Thai font is broken (sara/maitaikhu placement off).

const fs = require('fs');
const path = require('path');
const canvasLib = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const { paymentQrMeta } = require('./lib/thaiQrPayment');
const { CODE128_PATTERNS, code128BValues } = require('./lib/code128');
const {
  barcodeLabelTextScale,
  barcodeRasterHeightPx,
  isTinyBarcodeLabel,
} = require('./lib/barcodeLabelScale');

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

/** ESC/POS tail: continuous receipt rolls must not partial-cut (A70 gap sensor hunts). */
function escposBitmapFooter(opts = {}, defaultCut = 'partial') {
  const continuous = opts.paperType === 'continuous';
  const cut = continuous ? 'none' : defaultCut;
  const feedOpts = continuous
    ? { ...opts, feedLines: Math.min(6, Math.max(2, Number(opts.feedLines) || 3)) }
    : opts;
  return Buffer.concat([feedLines(feedOpts), cutCommand({ ...opts, cutMode: cut }, defaultCut)]);
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

function barcodeRenderInfo(barcode, width, requestedHeightPx) {
  const values = code128BValues(barcode);
  const moduleSum = values
    .map((v) => CODE128_PATTERNS[v])
    .join('')
    .split('')
    .reduce((sum, n) => sum + Number(n), 0);
  const tiny = width <= 168;
  const sideMargin = tiny ? 2 : 8;
  const innerWidth = tiny ? Math.max(width - sideMargin * 2, 48) : Math.max(width - 16, 100);
  const quietModules = tiny ? 2 : 10;
  let moduleWidth = Math.max(
    1,
    Math.floor((innerWidth - quietModules * 2) / moduleSum) || 1,
  );
  let quietPx = moduleWidth * quietModules;
  let totalWidth = moduleSum * moduleWidth + quietPx * 2;
  if (totalWidth > width - 2) {
    moduleWidth = Math.max(1, Math.floor((width - 4) / (moduleSum + quietModules * 2)) || 1);
    quietPx = moduleWidth * quietModules;
    totalWidth = moduleSum * moduleWidth + quietPx * 2;
  }
  const reqH = Number(requestedHeightPx) || (tiny ? 28 : 80);
  const barHeight = tiny
    ? Math.max(16, Math.min(reqH, 140))
    : Math.max(40, Math.min(140, reqH));
  return { values, moduleWidth, quietPx, totalWidth, barHeight, totalHeight: barHeight };
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

function thaiClusters(text) {
  const marks = /[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/;
  const out = [];
  for (const ch of Array.from(String(text ?? ''))) {
    if (marks.test(ch) && out.length) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

function wrapMeasuredText(text, ctx, maxWidth) {
  const max = Math.max(24, Number(maxWidth) || 24);
  const result = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    const tokens = paragraph.split(/(\s+)/).filter((token) => token.length > 0);
    let current = '';
    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        if (current && !current.endsWith(' ')) current += ' ';
        continue;
      }
      const candidate = current ? current + token : token;
      if (ctx.measureText(candidate).width <= max) {
        current = candidate;
        continue;
      }
      if (current.trim()) {
        result.push(current.trimEnd());
        current = '';
      }
      let chunk = '';
      for (const cluster of thaiClusters(token)) {
        const next = chunk + cluster;
        if (ctx.measureText(next).width > max && chunk) {
          result.push(chunk);
          chunk = cluster;
        } else {
          chunk = next;
        }
      }
      current = chunk;
    }
    if (current.trim()) result.push(current.trimEnd());
  }
  return result.length ? result : [''];
}

// Render an array of {text, size, bold, align} lines to a canvas, return ImageData
function renderLines(lines, width, opts) {
  const lineSpacing = opts.lineSpacing || 1.2;
  // First pass: measure total height
  const dummy = canvasLib.createCanvas(1, 1).getContext('2d');
  let totalH = opts.padTop || 8;
  const expanded = [];
  for (const l of lines) {
    if (l.wrap && l.text && !l.right && !l.qr && !l.rule) {
      const size = l.size || 22;
      dummy.font = `${l.bold ? 'bold ' : ''}${size}px PosThai`;
      for (const text of wrapMeasuredText(l.text, dummy, l.maxWidth || width - 8)) {
        expanded.push({ ...l, text });
      }
    } else {
      expanded.push(l);
    }
  }
  const sized = expanded.map((l) => {
    if (l.qr) {
      const qr = qrRenderInfo(l.qr, width, l.sizePx);
      return { ...l, _qr: qr, _h: qr.pixelSize + (l.marginBottom ?? 10) };
    }
    if (l.barcode) {
      const info = barcodeRenderInfo(l.barcode, width, l.heightPx);
      return { ...l, _bc: info, _h: info.totalHeight + (l.marginBottom ?? 6) };
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
    if (s.barcode) {
      const bc = s._bc;
      const startX = Math.max(0, Math.floor((width - bc.totalWidth) / 2));
      ctx.fillStyle = 'white';
      ctx.fillRect(startX, y, bc.totalWidth, bc.barHeight);
      ctx.fillStyle = 'black';
      let bx = startX + bc.quietPx;
      for (const value of bc.values) {
        const pattern = CODE128_PATTERNS[value];
        for (let i = 0; i < pattern.length; i++) {
          const w = Number(pattern[i]) * bc.moduleWidth;
          if (i % 2 === 0) ctx.fillRect(bx, y, w, bc.barHeight);
          bx += w;
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

function parseGsV0BandAt(src, offset) {
  if (offset > src.length - 8) return null;
  if (src[offset] !== GS || src[offset + 1] !== 0x76 || src[offset + 2] !== 0x30) return null;
  const widthBytes = src[offset + 4] + (src[offset + 5] << 8);
  const height = src[offset + 6] + (src[offset + 7] << 8);
  const total = 8 + widthBytes * height;
  if (offset + total > src.length) return null;
  return { widthBytes, height, total, band: src.subarray(offset, offset + total) };
}

/** Keep each GS v 0 band separate — AiYin BLE rejects one mega-raster. */
function extractGsV0RastersConcat(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const parts = [];
  let i = 0;
  while (i <= src.length - 8) {
    const parsed = parseGsV0BandAt(src, i);
    if (parsed) {
      parts.push(parsed.band);
      i += parsed.total;
      continue;
    }
    i += 1;
  }
  return Buffer.concat(parts);
}

function splitGsV0BandBuffer(bandBuf, maxRows) {
  const parsed = parseGsV0BandAt(bandBuf, 0);
  if (!parsed) return [];
  const { widthBytes, height, band } = parsed;
  if (height <= maxRows) return [band];
  const data = band.subarray(8);
  const out = [];
  for (let y = 0; y < height; y += maxRows) {
    const h = Math.min(maxRows, height - y);
    const chunk = data.subarray(y * widthBytes, (y + h) * widthBytes);
    out.push(Buffer.concat([
      Buffer.from([
        GS, 0x76, 0x30, 0x00,
        widthBytes & 0xff, (widthBytes >> 8) & 0xff,
        h & 0xff, (h >> 8) & 0xff,
      ]),
      chunk,
    ]));
  }
  return out;
}

function countGsV0Bands(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let count = 0;
  let i = 0;
  while (i <= src.length - 8) {
    const parsed = parseGsV0BandAt(src, i);
    if (parsed) {
      count += 1;
      i += parsed.total;
      continue;
    }
    i += 1;
  }
  return count;
}

/** Merge ESC/POS GS v 0 bands into one raster (TCP printers only). */
function mergeGsV0Rasters(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const bands = [];
  let i = 0;
  while (i <= src.length - 8) {
    const parsed = parseGsV0BandAt(src, i);
    if (parsed) {
      bands.push({
        widthBytes: parsed.widthBytes,
        height: parsed.height,
        data: parsed.band.subarray(8),
      });
      i += parsed.total;
      continue;
    }
    i += 1;
  }
  if (!bands.length) return Buffer.alloc(0);
  const widthBytes = bands[0].widthBytes;
  const totalHeight = bands.reduce((sum, b) => sum + b.height, 0);
  const merged = Buffer.concat(bands.map((b) => b.data));
  return Buffer.concat([
    Buffer.from([
      GS, 0x76, 0x30, 0x00,
      widthBytes & 0xff, (widthBytes >> 8) & 0xff,
      totalHeight & 0xff, (totalHeight >> 8) & 0xff,
    ]),
    merged,
  ]);
}

function toAiyinBleRaster(escposBuf, opts = {}) {
  const maxRows = Number(opts.bleMaxRasterRows) || 128;
  const src = extractGsV0RastersConcat(escposBuf);
  if (!src.length) return Buffer.alloc(0);
  const parts = [];
  let i = 0;
  while (i <= src.length - 8) {
    const parsed = parseGsV0BandAt(src, i);
    if (parsed) {
      parts.push(...splitGsV0BandBuffer(parsed.band, maxRows));
      i += parsed.total;
      continue;
    }
    i += 1;
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
    for (const { item: it } of section.items) {
      const variantSuffix = it.variant_name ? ` (${it.variant_name})` : '';
      lines.push({ text: `${it.quantity} x ${it.product_name}${variantSuffix}`, size: 30, bold: true });
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
  return Buffer.concat([INIT, ALIGN_L, rasterFromImageData(img, opts), escposBitmapFooter(opts, 'partial')]);
}

function buildReceiptBitmap(order, opts = {}) {
  ensureFont(opts.fontPath);
  const widthPx = opts.widthPx || (opts.width >= 48 ? 576 : 384);
  const restaurantName = opts.restaurantName || 'POS V2';

  const lines = [];
  lines.push({ text: restaurantName, size: 34, bold: true, align: 'center', wrap: true, maxWidth: widthPx - 12 });
  lines.push({ text: '--- ใบเสร็จ / RECEIPT ---', size: 20, align: 'center' });
  lines.push({ text: orderQueueLabel(order), right: orderLocationLabel(order), size: 20 });
  lines.push({ text: `Order #${order.id}`, size: 18 });
  lines.push({ text: new Date(order.created_at).toLocaleString('th-TH'), size: 18 });
  lines.push({ rule: '-', size: 20 });

  for (const it of order.items) {
    const variantSuffix = it.variant_name ? ` (${it.variant_name})` : '';
    lines.push({ text: `${it.quantity} x ${it.product_name}${variantSuffix}`, size: 24 });
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
  return Buffer.concat([INIT, ALIGN_L, rasterFromImageData(img, opts), escposBitmapFooter(opts, 'full')]);
}

function resolveBarcodeCellCfg(cfg = {}) {
  const columns = Math.max(1, Math.min(6, Number(cfg.labelColumns) || 1));
  const sheetMm = Number(cfg.paperWidthMm) || Number(cfg.labelWidthMm) || 58;
  const sheetPx = sheetMm * 8;
  const gapPx = Math.round((Number(cfg.columnGapMm) || 0) * 8);
  const cellWidthPx = columns > 1
    ? Math.max(96, Math.floor((sheetPx - (columns - 1) * gapPx) / columns))
    : (cfg.widthPx || sheetPx);
  return { ...cfg, widthPx: cellWidthPx, labelWidthMm: Math.round(cellWidthPx / 8) };
}

function barcodeLabelLines({
  barcode,
  name = '',
  price,
  stockQty,
  barcodeHeightPx,
} = {}, widthPx, cfg = {}) {
  const cellWmm = cfg.labelWidthMm || Math.round((widthPx || 384) / 8);
  const cellHmm = Number(cfg.labelHeightMm) || 0;
  const tiny = isTinyBarcodeLabel(cellWmm, cellHmm);
  const scale = barcodeLabelTextScale(cellWmm, cellHmm);
  const titleSize = Math.max(8, Math.round((tiny ? 16 : 26) * scale));
  const footerSize = Math.max(7, Math.round((tiny ? 12 : 18) * scale));
  const barH = barcodeHeightPx
    || barcodeRasterHeightPx(cellWmm, cellHmm, barcodeHeightPx);
  const lines = [];
  if (name && !tiny) {
    lines.push({
      text: name,
      size: titleSize,
      bold: true,
      align: 'center',
      wrap: true,
      maxWidth: widthPx - 12,
    });
  }
  lines.push({
    barcode: String(barcode || ''),
    heightPx: barH,
    marginBottom: tiny ? 0 : 4,
  });
  if (!tiny) {
    const footerParts = [String(barcode || '')];
    if (price != null) footerParts.push(`฿${Number(price).toFixed(0)}`);
    if (stockQty != null) footerParts.push(`stock ${Number(stockQty).toFixed(0)}`);
    lines.push({ text: footerParts.join(' · '), size: footerSize, align: 'center' });
  }
  return lines;
}

function renderBarcodeLabelImageData(opts, cfg) {
  ensureFont(cfg.fontPath);
  const cellCfg = resolveBarcodeCellCfg(cfg);
  const widthPx = cellCfg.widthPx || 384;
  const cellHmm = Number(cellCfg.labelHeightMm) || 0;
  const cellWmm = cellCfg.labelWidthMm || Math.round(widthPx / 8);
  const tiny = isTinyBarcodeLabel(cellWmm, cellHmm);
  const lines = barcodeLabelLines(opts, widthPx, cellCfg);
  return renderLines(lines, widthPx, {
    padTop: tiny ? 2 : 8,
    padBottom: tiny ? 2 : bottomFeedPx(cellCfg),
  });
}

function buildBarcodeLabelRaw(opts = {}, cfg = {}) {
  const cellCfg = resolveBarcodeCellCfg(cfg);
  const img = renderBarcodeLabelImageData(opts, cellCfg);
  return {
    raw: rawBitmapFromImageData(img),
    cellCfg,
    heightPx: img.height,
  };
}

function buildBarcodeLabelBitmap(opts = {}, cfg = {}) {
  const columns = Math.max(1, Math.min(6, Number(cfg.labelColumns) || 1));
  const itemsInRow = Math.min(columns, Math.max(1, Number(opts.itemsInRow) || 1));
  const cellCfg = resolveBarcodeCellCfg(cfg);
  const cellImg = renderBarcodeLabelImageData(opts, cellCfg);

  if (itemsInRow <= 1) {
    return Buffer.concat([
      INIT,
      ALIGN_L,
      rasterFromImageData(cellImg, cellCfg),
      escposBitmapFooter(cellCfg, 'partial'),
    ]);
  }

  const gapPx = Math.round((Number(cfg.columnGapMm) || 0) * 8);
  const sheetW = cellCfg.widthPx * itemsInRow + gapPx * (itemsInRow - 1);
  const sheetH = cellImg.height;
  const canvas = canvasLib.createCanvas(sheetW, sheetH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sheetW, sheetH);
  const cellCanvas = canvasLib.createCanvas(cellCfg.widthPx, sheetH);
  cellCanvas.getContext('2d').putImageData(cellImg, 0, 0);
  let x = 0;
  for (let i = 0; i < itemsInRow; i += 1) {
    ctx.drawImage(cellCanvas, x, 0);
    x += cellCfg.widthPx + gapPx;
  }
  const sheetImg = ctx.getImageData(0, 0, sheetW, sheetH);
  const rasterCfg = { ...cfg, widthPx: sheetW };
  return Buffer.concat([
    INIT,
    ALIGN_L,
    rasterFromImageData(sheetImg, rasterCfg),
    escposBitmapFooter(cfg, 'partial'),
  ]);
}

function buildQrLabelBitmap({
  url,
  tableName = '',
  tableCode = '',
  storeName = '',
  storeLogo = '',
  note = 'สแกน QR เพื่อสั่งอาหาร',
  footer = 'ขอบคุณที่ใช้บริการ',
  qrSizePx,
} = {}, opts = {}) {
  ensureFont(opts.fontPath);
  const widthPx = opts.widthPx || (opts.width >= 48 ? 576 : 384);
  const lines = [];
  const header = [storeLogo, storeName].filter(Boolean).join(' ').trim();
  if (header) {
    lines.push({ text: header, size: 30, bold: true, align: 'center', wrap: true, maxWidth: widthPx - 12 });
  }
  if (note) lines.push({ text: note, size: 20, align: 'center' });
  lines.push({ rule: '-', size: 20 });
  if (tableName) lines.push({ text: tableName, size: 38, bold: true, align: 'center' });
  if (tableCode) lines.push({ text: tableCode, size: 20, align: 'center' });
  lines.push({ qr: String(url || ''), sizePx: qrSizePx || Math.min(320, widthPx - 48) });
  if (url) lines.push({ text: url, size: 14, align: 'center' });
  lines.push({ rule: '-', size: 18 });
  if (footer) lines.push({ text: footer, size: 20, align: 'center' });

  const img = renderLines(lines, widthPx, { padTop: 8, padBottom: bottomFeedPx(opts) });
  return Buffer.concat([INIT, ALIGN_L, rasterFromImageData(img, opts), escposBitmapFooter(opts, 'partial')]);
}

/** Tiny solid-black raster for AiYin BLE hardware checks (~1.2 KB). */
function buildAiyinBlePingBitmap(opts = {}) {
  const widthPx = opts.widthPx || 384;
  const widthBytes = Math.ceil(widthPx / 8);
  const rows = 32;
  const data = Buffer.alloc(widthBytes * rows, 0xff);
  return Buffer.concat([
    Buffer.from([
      GS, 0x76, 0x30, 0x00,
      widthBytes & 0xff, (widthBytes >> 8) & 0xff,
      rows & 0xff, (rows >> 8) & 0xff,
    ]),
    data,
  ]);
}

function buildTestBitmap(opts = {}) {
  if (opts.bleProfile === 'aiyin') {
    return buildAiyinBlePingBitmap(opts);
  }
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
  return Buffer.concat([
    INIT,
    ALIGN_L,
    rasterFromImageData(img, opts),
    escposBitmapFooter(opts, 'partial'),
  ]);
}

module.exports = {
  buildKitchenBitmap,
  buildReceiptBitmap,
  buildQrLabelBitmap,
  buildBarcodeLabelBitmap,
  buildBarcodeLabelRaw,
  resolveBarcodeCellCfg,
  buildTestBitmap,
  buildAiyinBlePingBitmap,
  mergeGsV0Rasters,
  extractGsV0RastersConcat,
  countGsV0Bands,
  toAiyinBleRaster,
  rasterFromImageData,
  rawBitmapFromImageData,
  renderLines,
  ensureFont,
  bottomFeedPx,
  rasterBandHeight,
};

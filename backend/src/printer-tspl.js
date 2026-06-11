// TSPL (Taiwan Semiconductor Printer Language) for AYIN/IPRT label printers.
//
// AYIN A70Pro and similar label printers do NOT speak ESC/POS — they speak
// TSPL. Sending ESC/POS bytes makes them silently drop the connection.
//
// Strategy: render the receipt to a 1-bit bitmap (we already do this for
// `image` mode in printer-bitmap.js) then wrap with TSPL commands:
//
//   SIZE 80 mm, 100 mm
//   GAP 0 mm, 0 mm        (continuous paper)
//   DIRECTION 0
//   DENSITY 8
//   SPEED 4
//   CLS
//   BITMAP 0, 0, <wbytes>, <h>, 0, <raw bitmap data>
//   PRINT 1
//
// Plus optional `CUT` for cutter-equipped models, but the AYIN A70Pro
// uses a tear bar, so we omit CUT.

const bitmap = require('./printer-bitmap');
const { paymentQrMeta } = require('./lib/thaiQrPayment');
const { isTinyBarcodeLabel } = require('./lib/barcodeLabelScale');
const { code128ModuleSum } = require('./lib/code128');

function renderToBitmap(builderFn, order, opts) {
  // The existing buildKitchenBitmap/buildReceiptBitmap return ESC/POS bytes,
  // not raw bitmap. We need the raw image, so rebuild via the line renderer.
  // Easiest path: reuse the lines arrays from those builders. But those are
  // hidden inside the functions. So we render lines directly here.
  const lines = builderFn(order, opts);
  const widthPx = opts.widthPx || 384;
  const img = bitmap.renderLines(lines, widthPx, { padTop: 10, padBottom: 10 });
  return bitmap.rawBitmapFromImageData(img);
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

// We need access to the line lists used by the existing builders.
// Re-implement them here as line-array generators (no escpos wrapping).
function kitchenLines(order) {
  const lines = [];
  lines.push({ text: '** KITCHEN **', size: 30, bold: true, align: 'center' });
  lines.push({ text: orderQueueLabel(order), size: 30, bold: true, align: 'center' });
  lines.push({ text: orderLocationLabel(order), size: 28, bold: true, align: 'center' });
  lines.push({ text: orderModeLabel(order), size: 24, bold: true, align: 'center' });
  lines.push({ text: `Order #${order.id}    ${new Date(order.created_at).toLocaleString('th-TH')}`, size: 18 });
  if (order.source) lines.push({ text: `source: ${order.source}`, size: 16 });
  lines.push({ rule: '-', size: 18 });
  for (const section of kitchenSections(order)) {
    lines.push({ text: `-- ${section.label} --`, size: 24, bold: true });
    for (const { item: it } of section.items) {
      let suffix = '';
      if (it.variant_name) suffix += ` (${it.variant_name})`;
      lines.push({ text: `${it.quantity} x ${it.product_name}${suffix}`, size: 24, bold: true });
      if (Array.isArray(it.options_selected) && it.options_selected.length) {
        lines.push({ text: `   > ${it.options_selected.map((o) => o.value).join(' · ')}`, size: 18 });
      }
      if (it.note) lines.push({ text: `   *${it.note}`, size: 18 });
    }
  }
  lines.push({ rule: '-', size: 18 });
  if (order.note) {
    lines.push({ text: `NOTE: ${order.note}`, size: 20, bold: true });
    lines.push({ rule: '-', size: 18 });
  }
  return lines;
}

function receiptLines(order, opts) {
  const restaurantName = opts.restaurantName || 'POS V2';
  const widthPx = opts.widthPx || 384;
  const lines = [];
  lines.push({ text: restaurantName, size: 32, bold: true, align: 'center', wrap: true, maxWidth: widthPx - 16 });
  lines.push({ text: '--- ใบเสร็จ / RECEIPT ---', size: 18, align: 'center' });
  lines.push({ text: orderQueueLabel(order), right: orderLocationLabel(order), size: 18 });
  lines.push({ text: `Order #${order.id}`, size: 16 });
  lines.push({ text: new Date(order.created_at).toLocaleString('th-TH'), size: 16 });
  lines.push({ rule: '-', size: 18 });
  for (const it of order.items) {
    lines.push({ text: `${it.quantity} x ${it.product_name}${it.variant_name ? ' (' + it.variant_name + ')' : ''}`, size: 20 });
    lines.push({ text: `  [${fulfillmentText(itemFulfillmentType(order, it))}]`, size: 14 });
    const lineTotal = (Number(it.unit_price) * it.quantity).toFixed(2);
    lines.push({ text: `  @${Number(it.unit_price).toFixed(2)}`, right: lineTotal, size: 16 });
    if (Array.isArray(it.options_selected) && it.options_selected.length) {
      lines.push({ text: `  > ${it.options_selected.map((o) => o.value).join(' · ')}`, size: 14 });
    }
    if (it.note) lines.push({ text: `  *${it.note}`, size: 14 });
  }
  lines.push({ rule: '-', size: 18 });
  lines.push({ text: 'TOTAL', right: Number(order.total_amount).toFixed(2), size: 26, bold: true });
  lines.push({ rule: '=', size: 18 });
  const paymentQr = paymentQrMeta(order, opts.paymentSettings || opts);
  if (paymentQr) {
    lines.push({ text: paymentQr.label, size: 22, bold: true, align: 'center' });
    lines.push({ qr: paymentQr.payload, sizePx: Math.min(280, (opts.widthPx || 384) - 48) });
    if (paymentQr.accountName) lines.push({ text: paymentQr.accountName, size: 16, align: 'center' });
    if (paymentQr.accountId) lines.push({ text: `รหัส: ${paymentQr.accountId}`, size: 16, align: 'center' });
    if (paymentQr.includeAmount) {
      lines.push({ text: `ยอดชำระ ${Number(order.total_amount).toFixed(2)} บาท`, size: 18, bold: true, align: 'center' });
    }
    lines.push({ rule: '-', size: 16 });
  }
  lines.push({ text: 'ขอบคุณที่ใช้บริการ', size: 18, align: 'center' });
  lines.push({ text: 'Thank you', size: 16, align: 'center' });
  return lines;
}

function testLines() {
  return [
    { text: 'PRINT TEST (TSPL)', size: 26, bold: true, align: 'center' },
    { text: '--- ทดสอบภาษาไทย ---', size: 20, align: 'center' },
    { text: 'สวัสดีครับ ปริ้นเตอร์ทำงานปกติ', size: 22 },
    { text: 'พยัญชนะ สระ วรรณยุกต์', size: 22 },
    { text: 'ABC 123 abc !@#$%', size: 18 },
    { rule: '-', size: 18 },
    { text: 'AYIN A70Pro · TSPL', size: 14, align: 'center' },
  ];
}

/// Build TSPL header. The paper-detection sensor on AYIN/IPRT printers will
/// alarm if the declared paper type doesn't match what's loaded — sending
/// `GAP 2,0` on continuous paper hangs the print, and vice versa.
///
/// `paperType`:
///   - `continuous` → `GAP 0,0` + `BLINE 0,0` + `SET TEAR ON` (no sensor check)
///   - `gap` (default) → `GAP <n>,0` (gap-detect; <n>mm between die-cut labels)
///   - `bline` → `BLINE <n>,0` (black-mark detect)
function tsplSensorBlock(opts = {}) {
  const gapMm = opts.gapMm ?? 0;
  const blineMm = opts.blineMm ?? 0;
  const paperType = opts.paperType || (gapMm > 0 ? 'gap' : 'continuous');
  switch (paperType) {
    case 'continuous':
      return (
        `GAP 0,0\r\n` +
        `BLINE 0,0\r\n` +
        `SET GAP OFF\r\n` +
        `SET CUTTER OFF\r\n` +
        `SET PEEL OFF\r\n` +
        `SET TEAR ON\r\n`
      );
    case 'bline':
      return `BLINE ${blineMm || 3} mm, 0 mm\r\n`;
    case 'gap':
    default:
      return `GAP ${gapMm || 2} mm, 0 mm\r\n`;
  }
}

/// Native TSPL BARCODE — ASCII-only, fits tiny die-cut labels (e.g. 20×10 mm)
/// without BITMAP raster (avoids BLE corruption on AiYin/A70).
function buildBarcodeNativeTSPL(opts = {}, cfg = {}) {
  const labelW = cfg.labelWidthMm || 20;
  const labelH = cfg.labelHeightMm || 10;
  const density = cfg.density ?? 8;
  const speed = cfg.speed ?? 6;
  const copies = Math.max(1, Number(cfg.copies) || 1);
  const barcode = String(opts.barcode || '').trim().replace(/"/g, "'");
  if (!barcode) throw new Error('barcode required');

  const dotsW = labelW * 8;
  const dotsH = labelH * 8;
  const moduleSum = code128ModuleSum(barcode);
  let narrow = dotsW >= 200 ? 2 : 1;
  if (moduleSum * narrow > dotsW - 4) narrow = 1;
  const wide = narrow * 2;
  const estDots = moduleSum * narrow;
  const barH = Math.max(
    14,
    Math.min(dotsH - 4, Math.round(dotsH * (dotsH <= 88 ? 0.68 : 0.55))),
  );
  const x = Math.max(2, Math.floor((dotsW - estDots) / 2));
  const y = Math.max(2, Math.floor((dotsH - barH) / 2));

  const cmd =
    `SIZE ${labelW} mm, ${labelH} mm\r\n` +
    tsplSensorBlock(cfg) +
    `DIRECTION 0\r\n` +
    `REFERENCE 0,0\r\n` +
    `DENSITY ${density}\r\n` +
    `SPEED ${speed}\r\n` +
    `CLS\r\n` +
    `BARCODE ${x},${y},"128",${barH},0,0,${narrow},${wide},"${barcode}"\r\n` +
    `PRINT 1,${copies}\r\n`;
  return Buffer.from(cmd, 'ascii');
}

function wrapTSPL(rawBmp, opts = {}) {
  const labelW = opts.labelWidthMm  || 80;
  // Auto-calculate label height from bitmap (203 dpi → 8 dots/mm)
  const labelH = opts.labelHeightMm || Math.ceil(rawBmp.height / 8) + 5;
  const density = opts.density ?? 8;
  const speed   = opts.speed   ?? 4;

  const head = Buffer.from(
    `SIZE ${labelW} mm, ${labelH} mm\r\n` +
    tsplSensorBlock(opts) +
    `DIRECTION 0\r\n` +
    `REFERENCE 0,0\r\n` +
    `DENSITY ${density}\r\n` +
    `SPEED ${speed}\r\n` +
    `CLS\r\n` +
    `BITMAP 0, 0, ${rawBmp.widthBytes}, ${rawBmp.height}, 0, `,
    'ascii'
  );
  const copies = Math.max(1, Number(opts.copies) || 1);
  const foot = Buffer.from(`\r\nPRINT 1, ${copies}\r\n`, 'ascii');
  return Buffer.concat([head, rawBmp.data, foot]);
}

/// One-shot calibration command. Feeds paper through the sensor and
/// auto-learns the gap/black-mark positions. Send this once after loading
/// new paper stock to clear "paper out" / sensor mismatch alarms.
///   - `continuous` → no calibration needed (returns empty buffer)
///   - `gap`        → `GAPDETECT` (some firmwares: `AUTODETECT`)
///   - `bline`      → `BLINEDETECT`
function buildCalibrateTSPL(opts = {}) {
  const paperType = opts.paperType || 'gap';
  let cmd = '';
  if (paperType === 'gap') cmd = `SIZE ${opts.labelWidthMm || 60} mm, ${opts.labelHeightMm || 40} mm\r\nGAPDETECT\r\n`;
  else if (paperType === 'bline') cmd = `SIZE ${opts.labelWidthMm || 60} mm, ${opts.labelHeightMm || 40} mm\r\nBLINEDETECT\r\n`;
  else cmd = `\r\n`; // continuous: use buildContinuousSetupTSPL instead
  return Buffer.from(cmd, 'ascii');
}

/// One-shot continuous-paper setup. Clears gap/black-mark sensor alarm on
/// AiYin/IPRT when the roll has no gaps — must match Expert Label "Continuous".
function buildContinuousSetupTSPL(opts = {}) {
  const labelW = opts.labelWidthMm || 58;
  const cmd =
    `SIZE ${labelW} mm, 10 mm\r\n` +
    `GAP 0,0\r\n` +
    `BLINE 0,0\r\n` +
    `SET GAP OFF\r\n` +
    `SET CUTTER OFF\r\n` +
    `SET PEEL OFF\r\n` +
    `SET TEAR ON\r\n` +
    `DIRECTION 0\r\n` +
    `REFERENCE 0,0\r\n`;
  return Buffer.from(cmd, 'ascii');
}

// ─── public builders (mirror printer-bitmap API) ─────────────────────────
function buildKitchenTSPL(order, opts = {}) {
  bitmap.ensureFont(opts.fontPath);
  const widthPx = opts.widthPx || 384;
  const lines = kitchenLines(order);
  const img = bitmap.renderLines(lines, widthPx, { padTop: 10, padBottom: 10 });
  const raw = bitmap.rawBitmapFromImageData(img);
  return wrapTSPL(raw, opts);
}

function buildReceiptTSPL(order, opts = {}) {
  bitmap.ensureFont(opts.fontPath);
  const widthPx = opts.widthPx || 384;
  const lines = receiptLines(order, opts);
  const img = bitmap.renderLines(lines, widthPx, { padTop: 10, padBottom: 10 });
  const raw = bitmap.rawBitmapFromImageData(img);
  return wrapTSPL(raw, opts);
}

function buildBarcodeTSPL(opts = {}, cfg = {}) {
  const cellCfg = bitmap.resolveBarcodeCellCfg(cfg);
  const w = cellCfg.labelWidthMm || cfg.labelWidthMm || 50;
  const h = Number(cellCfg.labelHeightMm || cfg.labelHeightMm) || 0;
  if (isTinyBarcodeLabel(w, h)) {
    return buildBarcodeNativeTSPL(opts, { ...cellCfg, ...cfg, labelWidthMm: w, labelHeightMm: h || 10 });
  }
  bitmap.ensureFont(cfg.fontPath);
  const { raw, cellCfg: resolved, heightPx } = bitmap.buildBarcodeLabelRaw(opts, cfg);
  const labelHmm = Number(resolved.labelHeightMm) || 0;
  const minHmm = Math.max(1, Math.ceil((heightPx + 4) / 8));
  const labelH = labelHmm > 0 ? Math.max(labelHmm, minHmm) : minHmm;
  return wrapTSPL(raw, {
    ...resolved,
    ...cfg,
    labelWidthMm: resolved.labelWidthMm || cfg.labelWidthMm || 50,
    labelHeightMm: labelH,
  });
}

function buildTestTSPL(opts = {}) {
  bitmap.ensureFont(opts.fontPath);
  const widthPx = opts.widthPx || 384;
  const lines = testLines();
  const img = bitmap.renderLines(lines, widthPx, { padTop: 10, padBottom: 10 });
  const raw = bitmap.rawBitmapFromImageData(img);
  return wrapTSPL(raw, opts);
}

function buildQrTSPL(opts = {}, cfg = {}) {
  bitmap.ensureFont(cfg.fontPath);
  const widthPx = cfg.widthPx || 384;
  const lines = [];
  const header = [opts.storeLogo, opts.storeName].filter(Boolean).join(' ').trim();
  if (header) {
    lines.push({ text: header, size: 28, bold: true, align: 'center', wrap: true, maxWidth: widthPx - 12 });
  }
  if (opts.note) lines.push({ text: opts.note, size: 18, align: 'center' });
  lines.push({ rule: '-', size: 18 });
  if (opts.tableName) lines.push({ text: opts.tableName, size: 34, bold: true, align: 'center' });
  if (opts.tableCode) lines.push({ text: opts.tableCode, size: 18, align: 'center' });
  lines.push({ qr: String(opts.url || ''), sizePx: Math.min(280, widthPx - 48) });
  if (opts.footer) lines.push({ text: opts.footer, size: 18, align: 'center' });
  const img = bitmap.renderLines(lines, widthPx, { padTop: 8, padBottom: 16 });
  const raw = bitmap.rawBitmapFromImageData(img);
  return wrapTSPL(raw, cfg);
}

module.exports = {
  buildKitchenTSPL,
  buildReceiptTSPL,
  buildBarcodeTSPL,
  buildBarcodeNativeTSPL,
  buildTestTSPL,
  buildQrTSPL,
  buildCalibrateTSPL,
  buildContinuousSetupTSPL,
  wrapTSPL,
};

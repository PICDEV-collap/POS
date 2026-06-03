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
function wrapTSPL(rawBmp, opts = {}) {
  const labelW = opts.labelWidthMm  || 80;
  // Auto-calculate label height from bitmap (203 dpi → 8 dots/mm)
  const labelH = opts.labelHeightMm || Math.ceil(rawBmp.height / 8) + 5;
  const density = opts.density ?? 8;
  const speed   = opts.speed   ?? 4;
  const gapMm   = opts.gapMm   ?? 0;
  const blineMm = opts.blineMm ?? 0;
  const paperType = opts.paperType || (gapMm > 0 ? 'gap' : 'continuous');

  let sensorBlock;
  switch (paperType) {
    case 'continuous':
      // No gap, no black mark — printer keeps feeding until PRINT length is met.
      sensorBlock =
        `SET TEAR ON\r\n` +
        `GAP 0 mm, 0 mm\r\n` +
        `BLINE 0 mm, 0 mm\r\n`;
      break;
    case 'bline':
      sensorBlock =
        `BLINE ${blineMm || 3} mm, 0 mm\r\n`;
      break;
    case 'gap':
    default:
      sensorBlock =
        `GAP ${gapMm || 2} mm, 0 mm\r\n`;
      break;
  }

  const head = Buffer.from(
    `SIZE ${labelW} mm, ${labelH} mm\r\n` +
    sensorBlock +
    `DIRECTION 0\r\n` +
    `REFERENCE 0,0\r\n` +
    `DENSITY ${density}\r\n` +
    `SPEED ${speed}\r\n` +
    `CLS\r\n` +
    `BITMAP 0, 0, ${rawBmp.widthBytes}, ${rawBmp.height}, 0, `,
    'ascii'
  );
  const foot = Buffer.from(`\r\nPRINT 1, 1\r\n`, 'ascii');
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
  else cmd = `\r\n`; // continuous: nothing to calibrate
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

function buildTestTSPL(opts = {}) {
  bitmap.ensureFont(opts.fontPath);
  const widthPx = opts.widthPx || 384;
  const lines = testLines();
  const img = bitmap.renderLines(lines, widthPx, { padTop: 10, padBottom: 10 });
  const raw = bitmap.rawBitmapFromImageData(img);
  return wrapTSPL(raw, opts);
}

module.exports = {
  buildKitchenTSPL,
  buildReceiptTSPL,
  buildTestTSPL,
  buildCalibrateTSPL,
  wrapTSPL,
};

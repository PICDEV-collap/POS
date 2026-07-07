'use strict';

// Renders an accounting report (the object returned by accounting.buildReport)
// into a printable A4 PDF. Thai glyphs come from a system TTF resolved the same
// way printer-bitmap.js does it (Tahoma on Windows, Sarabun on Linux), so the
// report prints Thai correctly without bundling a font.

const fs = require('fs');
const PDFDocument = require('pdfkit');

const REGULAR_CANDIDATES = [
  process.env.REPORT_FONT_PATH,
  process.env.PRINTER_FONT_PATH,
  'C:/Windows/Fonts/tahoma.ttf',
  'C:/Windows/Fonts/leelawui.ttf',
  '/usr/share/fonts/truetype/tlwg/Sarabun-Regular.ttf',
  '/System/Library/Fonts/Supplemental/Tahoma.ttf',
];
const BOLD_CANDIDATES = [
  process.env.REPORT_FONT_BOLD_PATH,
  'C:/Windows/Fonts/tahomabd.ttf',
  'C:/Windows/Fonts/leelawuib.ttf',
  '/usr/share/fonts/truetype/tlwg/Sarabun-Bold.ttf',
];

function firstExisting(list) {
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch { /* try next */ }
  }
  return null;
}

const INK = '#1c2342';
const MUTED = '#7a8099';
const LINE = '#e6e8f2';
const HEAD_BG = '#f2f3f9';
const ZEBRA = '#f8f9fd';
const M = 36; // page margin (pt)

function fmtMoney(value, currency) {
  const n = Number(value || 0);
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency || '฿'}${s}`;
}

function fmtInt(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function fmtDateTime(date) {
  try {
    return new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

const STATUS_TH = { paid: 'ชำระแล้ว', cancelled: 'ยกเลิก', pending: 'รอ', cooking: 'กำลังทำ', served: 'เสิร์ฟแล้ว' };
const METHOD_TH = { manual: 'เงินสด', cash: 'เงินสด', promptpay: 'พร้อมเพย์', '-': '—' };
const labelStatus = (s) => STATUS_TH[s] || s || '—';
const labelMethod = (m) => METHOD_TH[m] || m || '—';

/**
 * @param {object} report  result of accounting.buildReport()
 * @param {object} meta    { shopName, currency, periodLabel, generatedAt }
 * @returns {Promise<Buffer>}
 */
function buildReportPdf(report, meta = {}) {
  const currency = meta.currency || '฿';
  const money = (v) => fmtMoney(v, currency);
  const shopName = meta.shopName || 'POS V2';
  const periodLabel = meta.periodLabel || `${report?.range?.from || ''} – ${report?.range?.to || ''}`;
  const generatedAt = meta.generatedAt || new Date();

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: M, bottom: M, left: M, right: M },
    bufferPages: true,
    info: { Title: `รายงานบัญชี ${periodLabel}`, Author: shopName },
  });

  const regularPath = firstExisting(REGULAR_CANDIDATES);
  const boldPath = firstExisting(BOLD_CANDIDATES);
  if (regularPath) doc.registerFont('Thai', regularPath);
  if (boldPath) doc.registerFont('ThaiBold', boldPath);
  // Fall back gracefully: Thai-regular for "bold" if no bold face exists, and
  // the standard PDF fonts only when no Thai face is available at all.
  const FONT = regularPath ? 'Thai' : 'Helvetica';
  const FONT_B = boldPath ? 'ThaiBold' : (regularPath ? 'Thai' : 'Helvetica-Bold');

  const contentW = doc.page.width - M * 2;
  const left = M;
  const pageBottom = () => doc.page.height - M;
  let y = M;

  // ── Header ──────────────────────────────────────────────────────────
  doc.font(FONT_B).fontSize(18).fillColor(INK).text(shopName, left, y, { width: contentW * 0.62 });
  const leftBottom = doc.y;
  doc.font(FONT).fontSize(10.5).fillColor(MUTED)
    .text('รายงานบัญชี (Non-VAT)', left, leftBottom + 1, { width: contentW * 0.62 });
  const headerLeftBottom = doc.y;

  const rightX = left + contentW * 0.62;
  const rightW = contentW * 0.38;
  doc.font(FONT).fontSize(10).fillColor(INK)
    .text(`ช่วงเวลา: ${periodLabel}`, rightX, y + 2, { width: rightW, align: 'right' });
  doc.font(FONT).fontSize(9).fillColor(MUTED)
    .text(`ออกรายงาน: ${fmtDateTime(generatedAt)}`, rightX, doc.y + 1, { width: rightW, align: 'right' });

  y = Math.max(headerLeftBottom, doc.y) + 10;
  doc.moveTo(left, y).lineTo(left + contentW, y).strokeColor(LINE).lineWidth(1).stroke();
  y += 14;

  // ── Summary metric grid (3 × 2) ─────────────────────────────────────
  const s = report?.summary || {};
  const metrics = [
    ['ยอดขายรวม', money(s.gross_sales)],
    ['ต้นทุนขาย', money(s.cogs)],
    ['กำไรขั้นต้น', money(s.gross_profit)],
    ['Margin', `${Number(s.margin_pct || 0).toFixed(1)}%`],
    ['ออเดอร์ที่ชำระแล้ว', fmtInt(s.paid_orders)],
    ['จำนวนที่ขาย (ชิ้น)', fmtInt(s.items_sold)],
  ];
  const cols = 3;
  const gap = 10;
  const cellW = (contentW - gap * (cols - 1)) / cols;
  const cellH = 48;
  metrics.forEach((m, i) => {
    const cx = left + (i % cols) * (cellW + gap);
    const cy = y + Math.floor(i / cols) * (cellH + gap);
    doc.roundedRect(cx, cy, cellW, cellH, 8).fillColor(ZEBRA).fill();
    doc.roundedRect(cx, cy, cellW, cellH, 8).lineWidth(1).strokeColor(LINE).stroke();
    doc.font(FONT).fontSize(9).fillColor(MUTED)
      .text(m[0], cx + 10, cy + 9, { width: cellW - 20, lineBreak: false, ellipsis: true });
    doc.font(FONT_B).fontSize(15).fillColor(INK)
      .text(m[1], cx + 10, cy + 23, { width: cellW - 20, lineBreak: false, ellipsis: true });
  });
  y += Math.ceil(metrics.length / cols) * (cellH + gap) + 6;

  // ── Generic table renderer ──────────────────────────────────────────
  // columns: [{ key, label, w (fraction of contentW), align, format }]
  function drawTable(title, columns, rows, totals) {
    const totalFrac = columns.reduce((a, c) => a + c.w, 0);
    const widths = columns.map((c) => (c.w / totalFrac) * contentW);
    const xs = [];
    let acc = left;
    for (const w of widths) { xs.push(acc); acc += w; }
    const rowH = 18;
    const padX = 5;

    function ensure(h) {
      if (y + h > pageBottom()) { doc.addPage(); y = M; return true; }
      return false;
    }

    function drawTitle() {
      doc.font(FONT_B).fontSize(12).fillColor(INK)
        .text(`${title}  (${rows.length})`, left, y, { width: contentW });
      y = doc.y + 4;
    }

    function drawHead() {
      doc.rect(left, y, contentW, rowH + 2).fillColor(HEAD_BG).fill();
      doc.font(FONT_B).fontSize(8.5).fillColor(INK);
      columns.forEach((c, i) => {
        doc.text(c.label, xs[i] + padX, y + 5, {
          width: widths[i] - padX * 2, align: c.align || 'left', lineBreak: false, ellipsis: true,
        });
      });
      y += rowH + 2;
    }

    function drawRow(cells, opts = {}) {
      if (ensure(rowH)) drawHead();
      if (opts.zebra) { doc.rect(left, y, contentW, rowH).fillColor(ZEBRA).fill(); }
      doc.font(opts.bold ? FONT_B : FONT).fontSize(8.5).fillColor(opts.muted ? MUTED : INK);
      columns.forEach((c, i) => {
        doc.text(cells[i] == null ? '—' : String(cells[i]), xs[i] + padX, y + 5, {
          width: widths[i] - padX * 2, align: c.align || 'left', lineBreak: false, ellipsis: true,
        });
      });
      doc.moveTo(left, y + rowH).lineTo(left + contentW, y + rowH).lineWidth(0.5).strokeColor(LINE).stroke();
      y += rowH;
    }

    ensure(rowH * 3 + 24); // keep title + head + a couple rows together
    drawTitle();
    drawHead();

    if (!rows.length) {
      doc.font(FONT).fontSize(9).fillColor(MUTED)
        .text('ไม่มีข้อมูลในช่วงเวลานี้', left, y + 6, { width: contentW, align: 'center' });
      y += rowH + 8;
      return;
    }
    rows.forEach((row, idx) => {
      drawRow(columns.map((c) => (c.format ? c.format(row[c.key], row) : row[c.key])), { zebra: idx % 2 === 1 });
    });
    if (totals) drawRow(totals, { bold: true });
    y += 14;
  }

  // ── Daily ───────────────────────────────────────────────────────────
  const daily = report?.daily || [];
  const dailyTotals = sumRows(daily, ['paid_orders', 'gross_sales', 'cogs', 'gross_profit']);
  drawTable('สรุปรายวัน', [
    { key: 'business_date', label: 'วันที่', w: 1.6 },
    { key: 'paid_orders', label: 'บิล', w: 0.8, align: 'right' },
    { key: 'gross_sales', label: 'ยอดขาย', w: 1.4, align: 'right', format: money },
    { key: 'cogs', label: 'ต้นทุน', w: 1.2, align: 'right', format: money },
    { key: 'gross_profit', label: 'กำไร', w: 1.2, align: 'right', format: money },
  ], daily, ['รวม', fmtInt(dailyTotals.paid_orders), money(dailyTotals.gross_sales), money(dailyTotals.cogs), money(dailyTotals.gross_profit)]);

  // ── Payments ────────────────────────────────────────────────────────
  drawTable('ช่องทางการชำระเงิน', [
    { key: 'payment_method', label: 'ช่องทาง', w: 1.8, format: (v) => labelMethod(v) },
    { key: 'paid_orders', label: 'บิล', w: 0.8, align: 'right' },
    { key: 'gross_sales', label: 'ยอดขาย', w: 1.4, align: 'right', format: money },
    { key: 'gross_profit', label: 'กำไร', w: 1.4, align: 'right', format: money },
  ], report?.payments || []);

  // ── Products ────────────────────────────────────────────────────────
  const products = report?.products || [];
  const prodTotals = sumRows(products, ['quantity', 'gross_sales', 'cogs', 'gross_profit']);
  drawTable('เมนูขายและกำไร', [
    { key: 'product_name', label: 'เมนู', w: 2.4 },
    { key: 'variant_name', label: 'ขนาด', w: 1.0 },
    { key: 'quantity', label: 'จำนวน', w: 0.8, align: 'right', format: fmtInt },
    { key: 'gross_sales', label: 'ยอดขาย', w: 1.3, align: 'right', format: money },
    { key: 'cogs', label: 'ต้นทุน', w: 1.2, align: 'right', format: money },
    { key: 'gross_profit', label: 'กำไร', w: 1.2, align: 'right', format: money },
  ], products, ['รวม', '', fmtInt(prodTotals.quantity), money(prodTotals.gross_sales), money(prodTotals.cogs), money(prodTotals.gross_profit)]);

  // ── Orders ──────────────────────────────────────────────────────────
  drawTable('รายการออเดอร์', [
    { key: 'daily_seq', label: 'ลำดับ', w: 0.7, align: 'right' },
    { key: 'business_date', label: 'วันที่', w: 1.4 },
    { key: 'table_name', label: 'โต๊ะ/จุดขาย', w: 1.6 },
    { key: 'status', label: 'สถานะ', w: 1.0, format: (v) => labelStatus(v) },
    { key: 'payment_method', label: 'ชำระ', w: 1.0, format: (v) => labelMethod(v) },
    { key: 'gross_sales', label: 'ยอดขาย', w: 1.2, align: 'right', format: money },
    { key: 'gross_profit', label: 'กำไร', w: 1.1, align: 'right', format: money },
  ], report?.orders || []);

  // ── Page numbers ────────────────────────────────────────────────────
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // prevent auto page-break while writing footer
    doc.font(FONT).fontSize(8).fillColor(MUTED)
      .text(`${shopName} · หน้า ${i + 1}/${range.count}`, M, doc.page.height - 22,
        { width: contentW, align: 'center', lineBreak: false });
  }

  // Collect into a Buffer.
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function sumRows(rows, keys) {
  const out = {};
  for (const k of keys) out[k] = 0;
  for (const r of rows) for (const k of keys) out[k] += Number(r[k] || 0);
  return out;
}

module.exports = { buildReportPdf };

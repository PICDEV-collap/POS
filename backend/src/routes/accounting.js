const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const logger = require('../lib/logger');
const { buildReportPdf } = require('../lib/reportPdf');

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXPORT_TYPES = new Set(['summary', 'daily', 'payments', 'products', 'orders']);

router.use(authRequired, requireRole('admin'));

router.get('/summary', async (req, res) => {
  const range = dateRange(req.query);
  const report = await buildReport(range);
  res.json(report);
});

router.get('/export', async (req, res) => {
  const range = dateRange(req.query);
  const type = String(req.query.type || 'orders').toLowerCase();
  if (!EXPORT_TYPES.has(type)) return res.status(400).json({ error: 'invalid export type' });

  const report = await buildReport(range);
  const rows = exportRows(type, report);
  const csv = toCsv(rows);
  await db.query(
    `INSERT INTO accounting_exports (export_type, from_date, to_date, row_count, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [type, range.from, range.to, rows.length, req.user.sub]
  );
  logger.info('accounting.export', 'accounting report exported', {
    export_type: type,
    from_date: range.from,
    to_date: range.to,
    row_count: rows.length,
    user_id: req.user.sub,
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pos-${type}-${range.from}-${range.to}.csv"`);
  res.send(`\uFEFF${csv}`);
});

router.get('/report.pdf', async (req, res) => {
  const range = dateRange(req.query);
  const [report, settings] = await Promise.all([
    buildReport(range),
    db.query('SELECT name, currency FROM restaurant_settings WHERE id = 1'),
  ]);
  const shop = settings.rows[0] || {};
  const periodLabel = cleanLabel(req.query.label) || `${range.from} – ${range.to}`;
  const rowCount = (report.orders || []).length;

  const pdf = await buildReportPdf(report, {
    shopName: shop.name || 'POS V2',
    currency: shop.currency || '฿',
    periodLabel,
    generatedAt: new Date(),
  });

  await db.query(
    `INSERT INTO accounting_exports (export_type, from_date, to_date, row_count, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    ['pdf', range.from, range.to, rowCount, req.user.sub]
  );
  logger.info('accounting.export', 'accounting report exported', {
    export_type: 'pdf',
    from_date: range.from,
    to_date: range.to,
    row_count: rowCount,
    user_id: req.user.sub,
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="pos-report-${range.from}-${range.to}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  res.send(pdf);
});

// Free-text period caption coming from the UI (e.g. "มิถุนายน 2569").
// Strip control chars and cap length; fall back to the raw range upstream.
function cleanLabel(value) {
  if (value == null || value === '') return null;
  const text = String(value).replace(/[^\p{L}\p{N}\s.\-–/()]+/gu, '').trim().slice(0, 80);
  return text || null;
}

function dateRange(query) {
  const today = todayBangkok();
  const from = cleanDate(query.from) || today;
  const to = cleanDate(query.to) || from;
  if (from > to) {
    const err = new Error('from must be before to');
    err.status = 400;
    throw err;
  }
  return { from, to };
}

function cleanDate(value) {
  if (value == null || value === '') return null;
  const raw = String(value).slice(0, 10);
  if (!DATE_RE.test(raw)) {
    const err = new Error('invalid date');
    err.status = 400;
    throw err;
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    const err = new Error('invalid date');
    err.status = 400;
    throw err;
  }
  return raw;
}

function todayBangkok() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

async function buildReport(range) {
  const params = [range.from, range.to];
  const [summary, daily, payments, products, orders, exports] = await Promise.all([
    db.query(summarySql(), params),
    db.query(dailySql(), params),
    db.query(paymentSql(), params),
    db.query(productSql(), params),
    db.query(orderSql(), params),
    db.query(
      `SELECT id, export_type, from_date, to_date, row_count, created_by, created_at
         FROM accounting_exports
        ORDER BY created_at DESC
        LIMIT 10`
    ),
  ]);

  const s = summary.rows[0] || {};
  const grossSales = money(s.gross_sales);
  const cogs = money(s.cogs);
  const grossProfit = money(s.gross_profit);
  return {
    range,
    mode: 'non_vat',
    summary: {
      paid_orders: intValue(s.paid_orders),
      cancelled_orders: intValue(s.cancelled_orders),
      items_sold: intValue(s.items_sold),
      gross_sales: grossSales,
      cogs,
      gross_profit: grossProfit,
      margin_pct: grossSales > 0 ? money((grossProfit / grossSales) * 100) : 0,
    },
    daily: daily.rows.map(mapMoneyRow),
    payments: payments.rows.map(mapMoneyRow),
    products: products.rows.map(mapMoneyRow),
    orders: orders.rows.map(mapMoneyRow),
    recent_exports: exports.rows,
  };
}

function orderCostCte() {
  return `
    WITH order_costs AS (
      SELECT o.id, o.business_date, o.daily_seq, o.table_id, t.name AS table_name,
             o.status, o.total_amount, o.source, o.order_type, o.customer_name,
             o.created_at, o.updated_at,
             COALESCE(SUM(oi.quantity), 0)::int AS items_sold,
             COALESCE(SUM(oi.cost_price_snapshot * oi.quantity), 0)::numeric(12,2) AS cogs
        FROM orders o
        JOIN tables t ON t.id = o.table_id
        LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.business_date BETWEEN $1::date AND $2::date
       GROUP BY o.id, t.name
    )
  `;
}

function summarySql() {
  return `
    ${orderCostCte()}
    SELECT
      COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_orders,
      COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_orders,
      COALESCE(SUM(items_sold) FILTER (WHERE status = 'paid'), 0)::int AS items_sold,
      COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0)::numeric(12,2) AS gross_sales,
      COALESCE(SUM(cogs) FILTER (WHERE status = 'paid'), 0)::numeric(12,2) AS cogs,
      COALESCE(SUM(total_amount - cogs) FILTER (WHERE status = 'paid'), 0)::numeric(12,2) AS gross_profit
    FROM order_costs
  `;
}

function dailySql() {
  return `
    ${orderCostCte()}
    SELECT business_date,
           COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_orders,
           COALESCE(SUM(items_sold) FILTER (WHERE status = 'paid'), 0)::int AS items_sold,
           COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0)::numeric(12,2) AS gross_sales,
           COALESCE(SUM(cogs) FILTER (WHERE status = 'paid'), 0)::numeric(12,2) AS cogs,
           COALESCE(SUM(total_amount - cogs) FILTER (WHERE status = 'paid'), 0)::numeric(12,2) AS gross_profit
      FROM order_costs
     GROUP BY business_date
     ORDER BY business_date DESC
  `;
}

function paymentSql() {
  return `
    ${orderCostCte()},
    paid_with_method AS (
      SELECT oc.*,
             COALESCE(pay.provider, 'manual') AS payment_method
        FROM order_costs oc
        LEFT JOIN LATERAL (
          SELECT provider
            FROM payment_transactions pt
           WHERE pt.order_id = oc.id
             AND pt.status = 'confirmed'
           ORDER BY pt.confirmed_at DESC NULLS LAST, pt.created_at DESC
           LIMIT 1
        ) pay ON TRUE
       WHERE oc.status = 'paid'
    )
    SELECT payment_method,
           COUNT(*)::int AS paid_orders,
           COALESCE(SUM(total_amount), 0)::numeric(12,2) AS gross_sales,
           COALESCE(SUM(cogs), 0)::numeric(12,2) AS cogs,
           COALESCE(SUM(total_amount - cogs), 0)::numeric(12,2) AS gross_profit
      FROM paid_with_method
     GROUP BY payment_method
     ORDER BY gross_sales DESC, payment_method
  `;
}

function productSql() {
  return `
    SELECT oi.product_id,
           oi.product_name,
           COALESCE(NULLIF(oi.variant_name, ''), '-') AS variant_name,
           SUM(oi.quantity)::int AS quantity,
           COALESCE(SUM(oi.unit_price * oi.quantity), 0)::numeric(12,2) AS gross_sales,
           COALESCE(SUM(oi.cost_price_snapshot * oi.quantity), 0)::numeric(12,2) AS cogs,
           COALESCE(SUM((oi.unit_price - oi.cost_price_snapshot) * oi.quantity), 0)::numeric(12,2) AS gross_profit
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE o.status = 'paid'
       AND o.business_date BETWEEN $1::date AND $2::date
     GROUP BY oi.product_id, oi.product_name, COALESCE(NULLIF(oi.variant_name, ''), '-')
     ORDER BY gross_sales DESC, quantity DESC, oi.product_name
  `;
}

function orderSql() {
  return `
    ${orderCostCte()}
    SELECT oc.id, oc.business_date, oc.daily_seq, oc.table_name, oc.status,
           oc.total_amount::numeric(12,2) AS gross_sales,
           oc.cogs,
           (oc.total_amount - oc.cogs)::numeric(12,2) AS gross_profit,
           oc.items_sold, oc.source, oc.order_type, oc.customer_name,
           COALESCE(pay.provider, CASE WHEN oc.status = 'paid' THEN 'manual' ELSE '-' END) AS payment_method,
           oc.created_at, oc.updated_at
      FROM order_costs oc
      LEFT JOIN LATERAL (
        SELECT provider
          FROM payment_transactions pt
         WHERE pt.order_id = oc.id
           AND pt.status = 'confirmed'
         ORDER BY pt.confirmed_at DESC NULLS LAST, pt.created_at DESC
         LIMIT 1
      ) pay ON TRUE
     WHERE oc.status IN ('paid', 'cancelled')
     ORDER BY oc.business_date DESC, oc.daily_seq DESC, oc.id DESC
  `;
}

function mapMoneyRow(row) {
  const out = { ...row };
  for (const key of ['gross_sales', 'cogs', 'gross_profit', 'total_amount']) {
    if (out[key] !== undefined && out[key] !== null) out[key] = money(out[key]);
  }
  if (out.margin_pct !== undefined) out.margin_pct = money(out.margin_pct);
  return out;
}

function exportRows(type, report) {
  if (type === 'summary') return [report.summary];
  if (type === 'daily') return report.daily;
  if (type === 'payments') return report.payments;
  if (type === 'products') return report.products;
  return report.orders;
}

function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
  ].join('\r\n');
}

function csvCell(value) {
  if (value == null) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function intValue(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

module.exports = { router, buildReport };

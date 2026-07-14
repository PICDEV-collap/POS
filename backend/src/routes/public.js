// Public endpoints used by the customer-facing QR ordering web.
// No JWT — customer is identified by table qr_token from the QR link.

const express = require('express');
const db = require('../db');
const { createOrder, loadOrder, maybeAutoPrint } = require('./orders');
const { emit } = require('../socket');
const push = require('../push');
const { attachNormalizedMenus } = require('../lib/menuModel');
const logger = require('../lib/logger');
const {
  customerKeyFromRequest,
  getPublicOrderState,
  issueCustomerSession,
  sessionTokenFromRequest,
  validateCustomerSession,
} = require('../lib/publicOrderGuard');

const router = express.Router();

function isTakeawayPoint(table) {
  return String(table?.code || '').toUpperCase() === 'TAKEAWAY' || Number(table?.seats) === 0;
}

async function tableFromToken(token) {
  if (!token) return null;
  const { rows } = await db.query(
    'SELECT id, store_id, code, name, seats, is_active FROM tables WHERE qr_token = $1',
    [token]
  );
  const t = rows[0];
  return t && t.is_active ? t : null;
}

// Customer hits this with the QR token to confirm which table they're at
router.get('/table/:token', async (req, res) => {
  const t = await tableFromToken(req.params.token);
  if (!t) return res.status(404).json({ error: 'invalid table' });
  const orderState = await getPublicOrderState(req, null, t.store_id);
  let session = null;
  if (orderState.allowed && orderState.settings.ordering_require_session) {
    session = await issueCustomerSession(t.id, req, customerKeyFromRequest(req), t.store_id);
  }
  res.json({
    id: t.id,
    code: t.code,
    name: t.name,
    seats: t.seats,
    is_takeaway: isTakeawayPoint(t),
    ordering: orderingPayload(orderState),
    customer_key: session?.customer_key || customerKeyFromRequest(req) || null,
    customer_session_token: session?.session_token || null,
  });
});

// Public menu (categories + available products + restaurant settings).
// Products with no/inactive category are excluded — they'd be orphans the
// customer UI couldn't slot anywhere. Admin can re-categorize them in
// /admin → tab "เมนู" if they want them visible again.
router.get('/menu', async (req, res) => {
  let storeId = Number(req.query.store_id || 1);
  if (req.query.token) {
    const table = await tableFromToken(req.query.token);
    if (!table) return res.status(404).json({ error: 'invalid table' });
    storeId = table.store_id || 1;
  }
  // Staff/admin views set ?include_unavailable=1 to see sold-out items so
  // they can flip them back on. Customers never set this flag, so even
  // without auth this only leaks which menus are sold out (not sensitive).
  const includeUnavailable = req.query.include_unavailable === '1'
      || req.query.include_unavailable === 'true';
  const cats = await db.query(
    `SELECT id, name, icon, sort_order FROM categories
       WHERE is_active = TRUE AND store_id = $1 ORDER BY sort_order, id`,
    [storeId]
  );
  const availFilter = includeUnavailable ? '' : 'AND p.is_available = TRUE';
  const prods = await db.query(
    `SELECT p.id, p.category_id, p.name, p.description, p.price, p.image_url,
            p.sort_order, p.emoji, p.is_popular, p.options, p.variants,
            p.product_type, p.print_station_key, p.is_available
       FROM products p
       JOIN categories c ON c.id = p.category_id
      WHERE c.is_active = TRUE ${availFilter}
        AND p.store_id = $1 AND c.store_id = $1
        AND COALESCE(p.product_type, 'food') <> 'stock'
      ORDER BY p.sort_order, p.id`
    ,
    [storeId]
  );
  const r = await db.query(
    `SELECT name, logo, currency, public_base_url AS base_url
       FROM stores
      WHERE id = $1 AND is_active = TRUE`,
    [storeId]
  );
  res.json({
    categories: cats.rows,
    products: await attachNormalizedMenus(db, prods.rows),
    restaurant: r.rows[0] || { name: 'POS V2', logo: '🍽️', currency: '฿' },
  });
});

// Customer places an order via QR token
router.post('/orders', async (req, res, next) => {
  try {
    const {
      token, items, note, order_type, customer_name,
      customer_key, customer_session_token,
    } = req.body || {};
    const t = await tableFromToken(token);
    if (!t) return res.status(404).json({ error: 'invalid table' });
    const orderState = await getPublicOrderState(req, req.body, t.store_id);
    if (!orderState.allowed) {
      logger.warn('public-order', 'order blocked by public guard', {
        table_id: t.id,
        reason: orderState.reason,
        open_now: orderState.open_now,
        network_allowed: orderState.network_allowed,
        network_reason: orderState.network_reason,
        location_allowed: orderState.location_allowed,
        location_reason: orderState.location_reason,
        location_distance_m: orderState.location_distance_m,
        location_accuracy_m: orderState.location_accuracy_m,
        location_max_distance_m: orderState.location_max_distance_m,
        ip: orderState.ip,
        host: orderState.host,
      });
      return res.status(403).json({ error: orderState.reason || 'ร้านยังไม่เปิดรับออเดอร์' });
    }
    const sessionCheck = await validateCustomerSession({
      tableId: t.id,
      req,
      settings: orderState.settings,
      customerKey: customer_key || customerKeyFromRequest(req, req.body),
      sessionToken: customer_session_token || sessionTokenFromRequest(req, req.body),
      storeId: t.store_id,
    });
    if (!sessionCheck.ok) {
      logger.warn('public-order', 'order blocked by invalid customer session', {
        table_id: t.id,
        reason: sessionCheck.message,
        ip: orderState.ip,
      });
      return res.status(sessionCheck.status || 403).json({ error: sessionCheck.message });
    }
    const takeawayPoint = isTakeawayPoint(t);
    if (takeawayPoint && !String(customer_name || '').trim()) {
      return res.status(400).json({ error: 'กรุณาใส่ชื่อสำหรับออเดอร์สั่งกลับบ้าน' });
    }
    const normalizedItems = Array.isArray(items)
      ? items.map((item) => ({
          ...item,
          fulfillment_type: takeawayPoint ? 'takeaway' : item.fulfillment_type,
        }))
      : items;
    const order = await createOrder({
      table_id: t.id, items: normalizedItems, note, source: 'customer',
      order_type: takeawayPoint ? 'takeaway' : order_type,
      customer_name,
      customer_session_id: sessionCheck.session_id,
    });
    emit('order:new', order);
    push.broadcastToScope('kitchen', {
      title: `🍽️ ออเดอร์ใหม่: ${order.table_name}`,
      body: `${order.items.length} รายการ · ฿${Number(order.total_amount).toFixed(0)}`,
      tag: `order-${order.id}`,
      url: '/kitchen',
    }).catch(() => {});
    await maybeAutoPrint(order);
    res.status(201).json(order);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Customer can poll their own order status
router.get('/orders/:id', async (req, res) => {
  const { token } = req.query;
  const t = await tableFromToken(token);
  if (!t) return res.status(404).json({ error: 'invalid table' });
  const order = await loadOrder(req.params.id);
  if (!order || order.table_id !== t.id) return res.status(404).json({ error: 'not found' });
  res.json(order);
});

// Batch poll: the customer page tracks its own order ids in localStorage and
// used to fetch each one individually every 8s (N+1 per phone). This returns
// all of them in one query, still scoped to the table the QR token unlocks.
router.get('/table-orders', async (req, res) => {
  const t = await tableFromToken(req.query.token);
  if (!t) return res.status(404).json({ error: 'invalid table' });
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 50);
  if (!ids.length) return res.json({ orders: [] });
  const { rows } = await db.query(
    `SELECT o.id, o.table_id, o.store_id, o.daily_seq, o.status, o.total_amount,
            o.note, o.order_type, o.customer_name, o.created_at, o.updated_at,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', oi.id, 'product_id', oi.product_id, 'product_name', oi.product_name,
                'unit_price', oi.unit_price, 'quantity', oi.quantity, 'note', oi.note,
                'option_label', oi.option_label, 'options_selected', oi.options_selected,
                'variant_name', oi.variant_name, 'fulfillment_type', oi.fulfillment_type,
                'status', oi.status
              ) ORDER BY oi.id)
              FROM order_items oi WHERE oi.order_id = o.id
            ), '[]'::json) AS items
       FROM orders o
      WHERE o.id = ANY($1::int[]) AND o.table_id = $2
      ORDER BY o.created_at DESC`,
    [ids, t.id]
  );
  res.json({ orders: rows });
});

// Customer taps "call staff / request bill" at the table. This is a real-time
// signal only — it never changes order state. Cashier screens (staff web +
// mobile) listen for `table:call` and also get a best-effort push.
router.post('/call-staff', async (req, res) => {
  const t = await tableFromToken(req.body?.token);
  if (!t) return res.status(404).json({ error: 'invalid table' });
  const type = req.body?.type === 'service' ? 'service' : 'bill';
  const payload = {
    table_id: t.id,
    table_code: t.code,
    table_name: t.name,
    store_id: t.store_id,
    type,
    at: new Date().toISOString(),
  };
  emit('table:call', payload);
  push.broadcastToScope('staff', {
    title: type === 'bill' ? `💰 เรียกเก็บเงิน: ${t.name}` : `🔔 เรียกพนักงาน: ${t.name}`,
    body: 'ลูกค้ากำลังรออยู่ที่โต๊ะ',
    tag: `call-${t.id}`,
    url: '/staff',
  }).catch(() => {});
  logger.info('table-call', 'customer called staff', {
    table_id: t.id, type, store_id: t.store_id,
  });
  res.json({ ok: true });
});

function orderingPayload(state) {
  return {
    allowed: !!state.allowed,
    reason: state.reason || null,
    open_now: !!state.open_now,
    network_allowed: !!state.network_allowed,
    network_reason: state.network_reason || null,
    location_allowed: !!state.location_allowed,
    location_reason: state.location_reason || null,
    distance_m: state.location_distance_m ?? null,
    accuracy_m: state.location_accuracy_m ?? null,
    max_distance_m: state.location_max_distance_m ?? null,
    open_time: state.settings.ordering_open_time,
    close_time: state.settings.ordering_close_time,
    timezone: state.settings.ordering_timezone,
    require_session: !!state.settings.ordering_require_session,
    require_private_ip: !!state.settings.ordering_require_private_ip,
    require_gps: !!state.settings.ordering_require_gps,
    gps_configured: !!state.gps_configured,
  };
}

module.exports = router;

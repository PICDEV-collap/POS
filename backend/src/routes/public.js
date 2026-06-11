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
    'SELECT id, code, name, seats, is_active FROM tables WHERE qr_token = $1',
    [token]
  );
  const t = rows[0];
  return t && t.is_active ? t : null;
}

// Customer hits this with the QR token to confirm which table they're at
router.get('/table/:token', async (req, res) => {
  const t = await tableFromToken(req.params.token);
  if (!t) return res.status(404).json({ error: 'invalid table' });
  const orderState = await getPublicOrderState(req);
  let session = null;
  if (orderState.allowed && orderState.settings.ordering_require_session) {
    session = await issueCustomerSession(t.id, req, customerKeyFromRequest(req));
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
router.get('/menu', async (_req, res) => {
  const cats = await db.query(
    `SELECT id, name, icon, sort_order FROM categories
       WHERE is_active = TRUE ORDER BY sort_order, id`
  );
  const prods = await db.query(
    `SELECT p.id, p.category_id, p.name, p.description, p.price, p.image_url,
            p.sort_order, p.emoji, p.is_popular, p.options, p.variants,
            p.product_type, p.print_station_key
       FROM products p
       JOIN categories c ON c.id = p.category_id
      WHERE p.is_available = TRUE AND c.is_active = TRUE
        AND COALESCE(p.product_type, 'food') <> 'stock'
      ORDER BY p.sort_order, p.id`
  );
  const r = await db.query('SELECT name, logo, currency FROM restaurant_settings WHERE id = 1');
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
    const orderState = await getPublicOrderState(req, req.body);
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

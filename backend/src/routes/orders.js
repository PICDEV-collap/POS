const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { emit } = require('../socket');
const push = require('../push');
const printer = require('../printer');
const { loadSettings } = require('./settings');
const logger = require('../lib/logger');
const { attachNormalizedMenus, validateSelectedOptions } = require('../lib/menuModel');

const router = express.Router();
const BUSINESS_TZ = 'Asia/Bangkok';

/// Queue auto-print jobs after createOrder() has committed. This persists the
/// print intent before the API returns, but still swallows failures so order
/// creation is never rolled back by a printer/config problem.
async function maybeAutoPrint(order) {
  const jobs = [];
  try {
    const s = await loadSettings();
    const cfg = printer.printerConfig();
    const serverAutoEnabled = String(process.env.SERVER_AUTO_PRINT_ENABLED || 'true').toLowerCase() !== 'false';
    if (!serverAutoEnabled || !cfg.enabled) {
      logger.info('auto-print', 'server-side auto print skipped', {
        order_id: order?.id,
        server_auto_enabled: serverAutoEnabled,
        printer_enabled: cfg.enabled,
        printer_host: cfg.host,
      });
      return jobs;
    }
    if (s.auto_print_kitchen) {
      const stationJobs = await queueKitchenStationPrints(order);
      jobs.push(...stationJobs);
    }
    if (s.auto_print_receipt) {
      jobs.push(await printer.queueOrderReceipt(order, {
        createdBy: null,
        restaurantName: s.name,
        paymentSettings: s,
        dedupeKey: `order:${order.id}:receipt`,
      }));
    }
  } catch (e) {
    logger.warn('auto-print', 'failed to queue auto print job', {
      order_id: order?.id,
      error: e.message,
      code: e.code,
    });
  }
  return jobs;
}

async function loadPrintStations() {
  try {
    const { rows } = await db.query(
      `SELECT key, name, station_type, printer_key, printer_host, printer_port,
              width_chars, thai_cp, render_mode,
              paper_width_mm, paper_height_mm, paper_gap_mm, width_px,
              feed_lines, bottom_feed_px, raster_band_height, cut_mode,
              is_active, sort_order
         FROM print_stations
        WHERE is_active = TRUE
        ORDER BY sort_order, key`
    );
    return rows;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return [];
    throw e;
  }
}

function stationKeyForProduct(product) {
  if (product?.print_station_key) return String(product.print_station_key);
  if (product?.product_type === 'drink') return 'drink';
  if (product?.product_type === 'stock') return 'snack';
  return 'kitchen';
}

function stationKeyForItem(item) {
  return item?.print_station_key || 'kitchen';
}

async function queueKitchenStationPrints(order, opts = {}) {
  const stations = await loadPrintStations();
  const stationMap = new Map(stations.map((s) => [s.key, s]));
  const fallbackStation = stationMap.get('kitchen') || {
    key: 'kitchen',
    name: 'ครัว / อาหาร',
    station_type: 'kitchen',
  };
  const groups = new Map();
  for (const item of order.items || []) {
    const key = stationKeyForItem(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const jobs = [];
  for (const [key, items] of groups.entries()) {
    const station = stationMap.get(key) || fallbackStation;
    const stationOrder = {
      ...order,
      items,
      fulfillment_summary: fulfillmentSummary(items, order.order_type),
    };
    jobs.push(await printer.queueOrderKitchen(stationOrder, {
      ...opts,
      stationKey: key,
      stationLabel: station.name,
      printerOverride: station,
      dedupeKey: opts.dedupeKey || `order:${order.id}:station:${key}`,
    }));
  }
  return jobs;
}

async function loadOrder(id) {
  const o = await db.query(
    `SELECT o.id, o.table_id, t.code AS table_code, t.name AS table_name,
            o.business_date, o.daily_seq,
            o.status, o.total_amount, o.note, o.source,
            o.order_type, o.customer_name, o.customer_session_id,
            o.created_at, o.updated_at
       FROM orders o JOIN tables t ON t.id = o.table_id
      WHERE o.id = $1`,
    [id]
  );
  if (!o.rows[0]) return null;
  const items = await db.query(
    `SELECT id, product_id, product_name, unit_price, quantity, note,
            option_label, options_selected, variant_name, fulfillment_type,
            print_station_key, status
       FROM order_items WHERE order_id = $1 ORDER BY id`,
    [id]
  );
  return {
    ...o.rows[0],
    items: items.rows,
    fulfillment_summary: fulfillmentSummary(items.rows, o.rows[0].order_type),
  };
}

function normalizeOrderType(value) {
  return value === 'takeaway' ? 'takeaway' : 'dine-in';
}

function normalizeFulfillmentType(value, fallback = 'dine-in') {
  return value === 'takeaway' ? 'takeaway' : normalizeOrderType(fallback);
}

function fulfillmentSummary(items = [], orderType = 'dine-in') {
  const types = new Set(items.map((it) => normalizeFulfillmentType(it.fulfillment_type, orderType)));
  if (types.size > 1) return 'mixed';
  return types.has('takeaway') ? 'takeaway' : 'dine-in';
}

async function allocateDailySequence(client) {
  const { rows } = await client.query(
    `INSERT INTO order_daily_sequences (business_date, last_seq, updated_at)
     VALUES ((NOW() AT TIME ZONE $1)::date, 1, NOW())
     ON CONFLICT (business_date) DO UPDATE
        SET last_seq = order_daily_sequences.last_seq + 1,
            updated_at = NOW()
     RETURNING business_date, last_seq AS daily_seq`,
    [BUSINESS_TZ]
  );
  return rows[0];
}

async function createOrder({
  table_id, items, note, source, created_by, order_type,
  customer_name, customer_session_id,
}) {
  if (!table_id || !Array.isArray(items) || items.length === 0) {
    const err = new Error('table_id and items required');
    err.status = 400;
    throw err;
  }
  const requestedOrderType = normalizeOrderType(order_type);

  const productIds = items.map((it) => it.product_id);
  const { rows: rawProducts } = await db.query(
    `SELECT id, name, price, cost_price, is_available, variants, options,
            product_type, barcode, track_stock, stock_qty, print_station_key
       FROM products WHERE id = ANY($1::int[])`,
    [productIds]
  );
  const products = await attachNormalizedMenus(db, rawProducts);
  const byId = new Map(products.map((p) => [p.id, p]));
  // Pre-validate (also normalises options_selected onto each item).
  for (const it of items) {
    const p = byId.get(it.product_id);
    if (!p) { const e = new Error(`product ${it.product_id} not found`); e.status = 400; throw e; }
    if (!p.is_available) { const e = new Error(`product ${p.name} not available`); e.status = 400; throw e; }
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
      const e = new Error('invalid quantity'); e.status = 400; throw e;
    }
    const optionResult = validateSelectedOptions(p.options, it.options_selected);
    it._optionsSelected = optionResult.selected;
    it._optionPriceDelta = optionResult.priceDelta;
    it._fulfillmentType = normalizeFulfillmentType(it.fulfillment_type, requestedOrderType);
    it._printStationKey = stationKeyForProduct(p);
  }
  const itemTypes = new Set(items.map((it) => it._fulfillmentType));
  const orderType = itemTypes.size === 1 ? [...itemTypes][0] : requestedOrderType;

  // Per-item price = base price OR variant.price if variant_name selected
  function itemUnitPrice(it, p) {
    if (it.variant_name) {
      const variants = Array.isArray(p.variants) ? p.variants : [];
      const v = variants.find((x) => x.name === it.variant_name);
      if (v && v.price != null && v.is_available !== false) {
        return Number(v.price) + Number(it._optionPriceDelta || 0);
      }
      const e = new Error(`variant "${it.variant_name}" not available for ${p.name}`);
      e.status = 400;
      throw e;
    }
    return Number(p.price) + Number(it._optionPriceDelta || 0);
  }

  function itemUnitCost(_it, p) {
    const n = Number(p.cost_price || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function shouldTrackStock(product) {
    return product?.track_stock === true || product?.product_type === 'stock';
  }

  async function decrementStockForSale(client, product, orderId, orderItemId, quantity) {
    if (!shouldTrackStock(product)) return;
    const { rows } = await client.query(
      `UPDATE products
          SET stock_qty = stock_qty - $2
        WHERE id = $1
          AND stock_qty >= $2
        RETURNING stock_qty`,
      [product.id, quantity]
    );
    if (!rows[0]) {
      const e = new Error(`สินค้า "${product.name}" คงเหลือไม่พอ`);
      e.status = 409;
      throw e;
    }
    await client.query(
      `INSERT INTO stock_movements
         (movement_key, product_id, order_id, order_item_id, movement_type,
          quantity_delta, stock_after, note, created_by)
       VALUES ($1, $2, $3, $4, 'sale', $5, $6, $7, $8)
       ON CONFLICT (movement_key) DO NOTHING`,
      [`sale:item:${orderItemId}`, product.id, orderId, orderItemId,
       -Number(quantity), rows[0].stock_qty, 'order created', created_by || null]
    );
  }

  const total = items.reduce((sum, it) => {
    const p = byId.get(it.product_id);
    return sum + itemUnitPrice(it, p) * it.quantity;
  }, 0);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const seq = await allocateDailySequence(client);
    const { rows: orderRows } = await client.query(
      `INSERT INTO orders
         (table_id, business_date, daily_seq, status, total_amount, note, source,
          created_by, order_type, customer_name, customer_session_id)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [table_id, seq.business_date, seq.daily_seq, total.toFixed(2), note || null,
       source || 'customer', created_by || null, orderType, customer_name || null,
       customer_session_id || null]
    );
    const orderId = orderRows[0].id;
    for (const it of items) {
      const p = byId.get(it.product_id);
      const price = itemUnitPrice(it, p);
      const cost = itemUnitCost(it, p);
      const insertedItem = await client.query(
        `INSERT INTO order_items
           (order_id, product_id, product_name, unit_price, quantity, note,
            option_label, options_selected, variant_name, fulfillment_type,
            cost_price_snapshot, print_station_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
         RETURNING id`,
        [orderId, p.id, p.name, price, it.quantity, it.note || null,
         it.option || null,
         it._optionsSelected ? JSON.stringify(it._optionsSelected) : null,
         it.variant_name || null,
         it._fulfillmentType,
         cost,
         it._printStationKey]
      );
      await decrementStockForSale(client, p, orderId, insertedItem.rows[0].id, it.quantity);
    }
    await client.query('COMMIT');
    return await loadOrder(orderId);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function restoreStockForItems(client, itemRows, movementType, createdBy) {
  for (const row of itemRows) {
    const tracked = row.track_stock === true || row.product_type === 'stock';
    if (!tracked || !row.product_id) continue;
    const movementKey = `restore:item:${row.id}`;
    const inserted = await client.query(
      `INSERT INTO stock_movements
         (movement_key, product_id, order_id, order_item_id, movement_type,
          quantity_delta, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (movement_key) DO NOTHING
       RETURNING id`,
      [movementKey, row.product_id, row.order_id, row.id, movementType,
       Number(row.quantity), 'order/item cancelled', createdBy || null]
    );
    if (!inserted.rows[0]) continue;
    const updated = await client.query(
      `UPDATE products
          SET stock_qty = stock_qty + $2
        WHERE id = $1
        RETURNING stock_qty`,
      [row.product_id, row.quantity]
    );
    await client.query(
      'UPDATE stock_movements SET stock_after = $2 WHERE id = $1',
      [inserted.rows[0].id, updated.rows[0]?.stock_qty ?? null]
    );
  }
}

async function restoreStockForOrder(client, orderId, movementType, createdBy) {
  const { rows } = await client.query(
    `SELECT oi.id, oi.order_id, oi.product_id, oi.quantity,
            p.product_type, p.track_stock
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1`,
    [orderId]
  );
  await restoreStockForItems(client, rows, movementType, createdBy);
}

// Staff/admin/kitchen: list orders, optional status filter
router.get('/', authRequired, async (req, res) => {
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE o.status = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT o.id, o.table_id, t.code AS table_code, t.name AS table_name,
            o.business_date, o.daily_seq,
            o.status, o.total_amount, o.note, o.source,
            o.order_type, o.customer_name,
            COALESCE((
              SELECT CASE
                WHEN COUNT(DISTINCT COALESCE(oi.fulfillment_type, o.order_type)) > 1 THEN 'mixed'
                ELSE MIN(COALESCE(oi.fulfillment_type, o.order_type))
              END
              FROM order_items oi
              WHERE oi.order_id = o.id
            ), o.order_type) AS fulfillment_summary,
            o.created_at, o.updated_at
       FROM orders o JOIN tables t ON t.id = o.table_id
       ${where}
      ORDER BY o.created_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

router.get('/:id', authRequired, async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  res.json(order);
});

// Staff places an order on behalf of a table
router.post('/', authRequired, requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { table_id, items, note, order_type, customer_name } = req.body || {};
    const order = await createOrder({
      table_id, items, note, source: 'staff', created_by: req.user.sub,
      order_type, customer_name,
    });
    emit('order:new', order);
    notifyKitchen(order);
    await maybeAutoPrint(order);
    res.status(201).json(order);
  } catch (e) { next(e); }
});

function notifyKitchen(order) {
  // Fire-and-forget — don't block the API response on push delivery
  push.broadcastToScope('kitchen', {
    title: `🍳 ออเดอร์ใหม่: ${order.table_name}`,
    body: `${order.items.length} รายการ · ฿${Number(order.total_amount).toFixed(0)}`,
    tag: `order-${order.id}`,
    url: '/kitchen',
  }).catch((e) => console.warn('[push] notify failed', e.message));
}

// Update overall order status (kitchen/staff/admin)
router.patch('/:id/status', authRequired, requireRole('staff', 'admin', 'kitchen'), async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['pending', 'cooking', 'served', 'paid', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT id, status FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!before.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    await client.query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, req.params.id]
    );
    if (status === 'cancelled' && before.rows[0].status !== 'cancelled') {
      await restoreStockForOrder(client, req.params.id, 'cancel_order', req.user.sub);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const order = await loadOrder(req.params.id);
  emit('order:update', order);
  res.json(order);
});

// Update single line item status (kitchen partial-cook flow)
router.patch('/items/:itemId/status', authRequired, requireRole('staff', 'admin', 'kitchen'), async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['pending', 'cooking', 'served', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const client = await db.getClient();
  let orderId;
  try {
    await client.query('BEGIN');
    const before = await client.query(
      `SELECT oi.id, oi.order_id, oi.product_id, oi.quantity, oi.status,
              p.product_type, p.track_stock
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.id = $1
        FOR UPDATE OF oi`,
      [req.params.itemId]
    );
    if (!before.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    orderId = before.rows[0].order_id;
    await client.query('UPDATE order_items SET status = $1 WHERE id = $2', [status, req.params.itemId]);
    if (status === 'cancelled' && before.rows[0].status !== 'cancelled') {
      await restoreStockForItems(client, before.rows, 'cancel_item', req.user.sub);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const order = await loadOrder(orderId);
  emit('order:update', order);
  res.json(order);
});

module.exports = { router, createOrder, loadOrder, maybeAutoPrint, queueKitchenStationPrints };

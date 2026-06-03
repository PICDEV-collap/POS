const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { parseStoreIds, resolveStoreId } = require('../lib/storeScope');
const { writeAudit } = require('../lib/auditLog');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'products');

const DEFAULT_TABLES = [
  { code: 'A1', name: 'โต๊ะ 1', seats: 4 },
  { code: 'A2', name: 'โต๊ะ 2', seats: 4 },
  { code: 'A3', name: 'โต๊ะ 3', seats: 4 },
  { code: 'A4', name: 'โต๊ะ 4', seats: 4 },
  { code: 'TAKEAWAY', name: 'สั่งกลับบ้าน', seats: 0 },
];

const DEFAULT_CATEGORIES = [
  { name: 'อาหาร', icon: '🍽️', sort_order: 10 },
  { name: 'เครื่องดื่ม', icon: '🥤', sort_order: 20 },
];
const DEFAULT_MENU_SOURCE_STORE_ID = 1;

function newQrToken() {
  return crypto.randomBytes(16).toString('hex');
}

function unlinkLocalProductImage(urlPath) {
  if (!urlPath || !urlPath.startsWith('/uploads/products/')) return;
  const filename = path.basename(urlPath);
  const full = path.join(UPLOAD_DIR, filename);
  if (!path.resolve(full).startsWith(path.resolve(UPLOAD_DIR))) return;
  try { fs.unlinkSync(full); } catch {}
}

function cleanCode(value, fallback = '') {
  return String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function normalizeStoreInput(body = {}) {
  const name = String(body.name || '').trim();
  const code = cleanCode(body.code || body.slug || name);
  const slug = cleanCode(body.slug || code);
  if (!name) {
    const err = new Error('store name required');
    err.status = 400;
    throw err;
  }
  if (!code || !slug) {
    const err = new Error('store code required');
    err.status = 400;
    throw err;
  }
  return {
    code,
    slug,
    name,
    logo: body.logo === undefined ? undefined : String(body.logo || '').trim().slice(0, 16) || null,
    currency: body.currency === undefined ? undefined : String(body.currency || '฿').trim().slice(0, 8),
    public_base_url: body.public_base_url === undefined ? undefined : String(body.public_base_url || '').trim().replace(/\/+$/, '') || null,
    timezone: body.timezone === undefined ? undefined : String(body.timezone || 'Asia/Bangkok').trim(),
    is_active: body.is_active === undefined ? undefined : !!body.is_active,
  };
}

function normalizePartialStoreInput(body = {}) {
  return {
    code: body.code === undefined ? undefined : cleanCode(body.code),
    slug: body.slug === undefined ? undefined : cleanCode(body.slug),
    name: body.name === undefined ? undefined : String(body.name || '').trim(),
    logo: body.logo === undefined ? undefined : String(body.logo || '').trim().slice(0, 16) || null,
    currency: body.currency === undefined ? undefined : String(body.currency || '฿').trim().slice(0, 8),
    public_base_url: body.public_base_url === undefined ? undefined : String(body.public_base_url || '').trim().replace(/\/+$/, '') || null,
    timezone: body.timezone === undefined ? undefined : String(body.timezone || 'Asia/Bangkok').trim(),
    is_active: body.is_active === undefined ? undefined : !!body.is_active,
  };
}

async function provisionStoreDefaults(client, storeId) {
  for (const table of DEFAULT_TABLES) {
    await client.query(
      `INSERT INTO tables (store_id, code, name, seats, qr_token, is_active)
       SELECT $1, $2::varchar, $3, $4, $5, TRUE
        WHERE NOT EXISTS (
          SELECT 1 FROM tables WHERE store_id = $1 AND lower(code) = lower($2::text)
        )`,
      [storeId, table.code, table.name, table.seats, newQrToken()]
    );
  }

  const categoryCount = await client.query(
    'SELECT COUNT(*)::int AS count FROM categories WHERE store_id = $1',
    [storeId]
  );
  if (Number(categoryCount.rows[0]?.count || 0) === 0) {
    const clonedCategories = storeId === DEFAULT_MENU_SOURCE_STORE_ID
      ? { rowCount: 0 }
      : await client.query(
        `INSERT INTO categories (store_id, name, icon, sort_order, is_active)
         SELECT $1, name, icon, sort_order, is_active
           FROM categories
          WHERE store_id = $2
          ORDER BY sort_order, id`,
        [storeId, DEFAULT_MENU_SOURCE_STORE_ID]
      );
    if (!clonedCategories.rowCount) {
      for (const category of DEFAULT_CATEGORIES) {
        await client.query(
          `INSERT INTO categories (store_id, name, icon, sort_order, is_active)
           VALUES ($1, $2, $3, $4, TRUE)`,
          [storeId, category.name, category.icon, category.sort_order]
        );
      }
    }
  }

  if (storeId !== DEFAULT_MENU_SOURCE_STORE_ID) {
    await cloneDefaultMenu(client, storeId);
  }
}

async function grantDefaultKitchenAccess(client, storeId) {
  await client.query(
    `UPDATE users
        SET allowed_store_ids = (
              SELECT ARRAY(
                SELECT DISTINCT unnest(
                  COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) || $1::int[]
                )
                ORDER BY 1
              )
            )
      WHERE role = 'kitchen'
        AND username = 'kitchen'
        AND is_active = TRUE`,
    [[storeId]]
  );
}

async function cloneDefaultMenu(client, storeId) {
  const productCount = await client.query(
    'SELECT COUNT(*)::int AS count FROM products WHERE store_id = $1',
    [storeId]
  );
  if (Number(productCount.rows[0]?.count || 0) > 0) return;

  await client.query(
    `INSERT INTO categories (store_id, name, icon, sort_order, is_active)
     SELECT $1, src.name, src.icon, src.sort_order, src.is_active
       FROM categories src
      WHERE src.store_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM categories dst
           WHERE dst.store_id = $1 AND lower(dst.name) = lower(src.name)
        )
      ORDER BY src.sort_order, src.id`,
    [storeId, DEFAULT_MENU_SOURCE_STORE_ID]
  );

  await client.query(
    `INSERT INTO products
       (store_id, category_id, name, description, price, image_url, is_available,
        sort_order, emoji, is_popular, options, variants, cost_price, product_type,
        barcode, track_stock, stock_qty, stock_alert_qty, print_station_key)
     SELECT $1,
            dst_cat.id,
            src.name,
            src.description,
            src.price,
            src.image_url,
            src.is_available,
            src.sort_order,
            src.emoji,
            src.is_popular,
            src.options,
            src.variants,
            src.cost_price,
            src.product_type,
            NULL,
            src.track_stock,
            src.stock_qty,
            src.stock_alert_qty,
            src.print_station_key
       FROM products src
       LEFT JOIN categories src_cat ON src_cat.id = src.category_id
       LEFT JOIN categories dst_cat
         ON dst_cat.store_id = $1 AND lower(dst_cat.name) = lower(src_cat.name)
      WHERE src.store_id = $2
      ORDER BY src.sort_order, src.id`,
    [storeId, DEFAULT_MENU_SOURCE_STORE_ID]
  );
}

function canAccessStore(req, storeId) {
  if (req.user?.role === 'super_admin') return true;
  return parseStoreIds(req.user?.allowed_store_ids).includes(storeId);
}

function requireSuperAdmin(req, res) {
  if (req.user?.role === 'super_admin') return true;
  res.status(403).json({ error: 'super admin required' });
  return false;
}

router.get('/', authRequired, requireRole('admin'), async (req, res) => {
  const params = [];
  let where = '';
  if (req.user.role !== 'super_admin') {
    const access = await db.query(
      'SELECT COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) AS allowed_store_ids FROM users WHERE id = $1',
      [req.user.sub]
    );
    params.push(access.rows[0]?.allowed_store_ids || [resolveStoreId(req)]);
    where = `WHERE id = ANY($${params.length}::int[])`;
  }
  const { rows } = await db.query(
    `SELECT id, code, slug, name, logo, currency, public_base_url, timezone,
            ordering_enabled, ordering_open_time, ordering_close_time,
            ordering_timezone, ordering_days, ordering_require_session,
            ordering_require_private_ip, ordering_require_gps,
            ordering_shop_lat, ordering_shop_lng, ordering_max_distance_m,
            is_active, created_at, updated_at
       FROM stores
       ${where}
      ORDER BY id`,
    params
  );
  res.json(rows);
});

router.post('/', authRequired, requireRole('admin'), async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const input = normalizeStoreInput(req.body);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO stores (code, slug, name, logo, currency, public_base_url, timezone,
                           ordering_timezone)
       VALUES ($1, $2, $3, COALESCE($4, '🍽️'), COALESCE($5, '฿'), $6, COALESCE($7, 'Asia/Bangkok'),
               COALESCE($7, 'Asia/Bangkok'))
       RETURNING *`,
      [input.code, input.slug, input.name, input.logo, input.currency, input.public_base_url, input.timezone]
    );
    await provisionStoreDefaults(client, rows[0].id);
    await grantDefaultKitchenAccess(client, rows[0].id);
    if (req.user.role !== 'super_admin') {
      await client.query(
        `UPDATE users
            SET allowed_store_ids = (
              SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) || $2::int[]))
            )
          WHERE id = $1`,
        [req.user.sub, [rows[0].id]]
      );
    }
    await client.query('COMMIT');
    await writeAudit(req, { action: 'store.create', targetType: 'store', targetId: rows[0].id, details: { code: rows[0].code } });
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'store code/slug already exists' });
    throw e;
  } finally {
    client.release();
  }
});

router.put('/:id', authRequired, requireRole('admin'), async (req, res) => {
  const storeId = Number(req.params.id);
  if (!Number.isInteger(storeId) || storeId <= 0) return res.status(400).json({ error: 'invalid store id' });
  if (req.user.role !== 'super_admin' && storeId !== resolveStoreId(req)) {
    return res.status(403).json({ error: 'store access forbidden' });
  }
  const input = normalizePartialStoreInput(req.body);
  const { rows } = await db.query(
    `UPDATE stores SET
        code = COALESCE($1, code),
        slug = COALESCE($2, slug),
        name = COALESCE($3, name),
        logo = COALESCE($4, logo),
        currency = COALESCE($5, currency),
        public_base_url = COALESCE($6, public_base_url),
        timezone = COALESCE($7, timezone),
        ordering_timezone = COALESCE($7, ordering_timezone),
        is_active = COALESCE($8, is_active),
        updated_at = NOW()
      WHERE id = $9
      RETURNING *`,
    [input.code, input.slug, input.name, input.logo, input.currency,
     input.public_base_url, input.timezone, input.is_active, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'store not found' });
  await writeAudit(req, { action: 'store.update', targetType: 'store', targetId: storeId, details: input });
  res.json(rows[0]);
});

router.delete('/:id', authRequired, requireRole('admin'), async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const storeId = Number(req.params.id);
  if (!Number.isInteger(storeId) || storeId <= 0) return res.status(400).json({ error: 'invalid store id' });
  if (!canAccessStore(req, storeId)) return res.status(403).json({ error: 'store access forbidden' });

  const client = await db.getClient();
  const productImages = [];
  try {
    await client.query('BEGIN');

    const storeResult = await client.query('SELECT id, code, name FROM stores WHERE id = $1 FOR UPDATE', [storeId]);
    const store = storeResult.rows[0];
    if (!store) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'store not found' });
    }
    if (store.id === 1 || store.code === 'default') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot delete default store' });
    }

    const countsResult = await client.query(
      `SELECT
          (SELECT COUNT(*)::int FROM users WHERE store_id = $1) AS assigned_users,
          (SELECT COUNT(*)::int FROM orders WHERE store_id = $1) AS orders,
          (SELECT COUNT(*)::int FROM payment_transactions WHERE store_id = $1) AS payments,
          (SELECT COUNT(*)::int FROM stock_movements WHERE store_id = $1) AS stock_movements,
          (SELECT COUNT(*)::int FROM accounting_exports WHERE store_id = $1) AS accounting_exports`,
      [storeId]
    );
    const counts = countsResult.rows[0] || {};
    if (Number(counts.assigned_users || 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'store is assigned to users; move users before deleting', counts });
    }
    const hasHistory = ['orders', 'payments', 'stock_movements', 'accounting_exports']
      .some((key) => Number(counts[key] || 0) > 0);
    if (hasHistory) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'store has transaction history and cannot be deleted', counts });
    }

    const images = await client.query(
      `SELECT image_url
         FROM products
        WHERE store_id = $1
          AND image_url IS NOT NULL
          AND image_url <> ''`,
      [storeId]
    );
    images.rows.forEach((row) => productImages.push(row.image_url));

    await client.query('DELETE FROM customer_order_sessions WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM order_daily_sequences WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM products WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM categories WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM tables WHERE store_id = $1', [storeId]);
    await client.query(
      `DELETE FROM print_stations ps
        WHERE ps.store_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM products p WHERE p.print_station_key = ps.key
          )`,
      [storeId]
    );

    const remainingStations = await client.query(
      'SELECT COUNT(*)::int AS count FROM print_stations WHERE store_id = $1',
      [storeId]
    );
    if (Number(remainingStations.rows[0]?.count || 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'store has printer stations still in use' });
    }

    await client.query('UPDATE users SET allowed_store_ids = array_remove(allowed_store_ids, $1)', [storeId]);
    await client.query('DELETE FROM stores WHERE id = $1', [storeId]);

    await client.query('COMMIT');
    productImages.forEach(unlinkLocalProductImage);
    await writeAudit(req, { action: 'store.delete', targetType: 'store', targetId: store.id, details: { name: store.name } });
    res.json({ deleted: true, id: store.id, name: store.name });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

module.exports = router;

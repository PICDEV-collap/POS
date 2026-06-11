const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const {
  attachNormalizedMenus,
  normalizeMenuPayload,
  normalizeProductRow,
  saveNormalizedMenu,
} = require('../lib/menuModel');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'products');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
      const stem = crypto.randomBytes(8).toString('hex');
      cb(null, `p${req.params.id}-${stem}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error(`unsupported mimetype: ${file.mimetype}`));
  },
});

const router = express.Router();

const PRODUCT_TYPES = new Set(['food', 'drink', 'stock']);
function cleanBarcode(value) {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, 64) : null;
}
function cleanProductType(value) {
  const s = String(value || '').trim().toLowerCase();
  return PRODUCT_TYPES.has(s) ? s : 'food';
}
function stationForProduct(type, value) {
  const explicit = String(value || '').trim();
  if (explicit) return explicit.slice(0, 32);
  if (type === 'drink') return 'drink';
  if (type === 'stock') return 'snack';
  return 'kitchen';
}
function stockNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generatedBarcodeForProduct(id) {
  return `SNK${String(id).padStart(6, '0')}`;
}

async function uniqueGeneratedBarcode(client, productId) {
  const base = generatedBarcodeForProduct(productId);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : `${base}${String(i).padStart(2, '0')}`;
    const { rows } = await client.query(
      'SELECT id FROM products WHERE barcode = $1 AND id <> $2 LIMIT 1',
      [candidate, productId]
    );
    if (!rows[0]) return candidate;
  }
  return `SNK${Date.now().toString().slice(-10)}`;
}

function code128BValues(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('barcode required');
  const values = [104]; // Code 128 Start B.
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) {
      const err = new Error('barcode must contain ASCII characters only');
      err.status = 400;
      throw err;
    }
    values.push(code - 32);
  }
  let checksum = 104;
  for (let i = 1; i < values.length; i++) checksum += values[i] * i;
  values.push(checksum % 103, 106);
  return values;
}

function code128Svg({ barcode, name, price, stockQty }) {
  const moduleWidth = 2;
  const quiet = 10;
  const barHeight = 70;
  const labelHeight = 44;
  const values = code128BValues(barcode);
  const modules = values
    .map((v) => CODE128_PATTERNS[v])
    .join('')
    .split('')
    .reduce((sum, n) => sum + Number(n), quiet * 2);
  const width = modules * moduleWidth;
  const height = barHeight + labelHeight;
  let x = quiet * moduleWidth;
  const rects = [];
  for (const value of values) {
    const pattern = CODE128_PATTERNS[value];
    for (let i = 0; i < pattern.length; i++) {
      const w = Number(pattern[i]) * moduleWidth;
      if (i % 2 === 0) rects.push(`<rect x="${x}" y="8" width="${w}" height="${barHeight}" fill="#000"/>`);
      x += w;
    }
  }
  const line2 = [
    price != null ? `฿${Number(price).toFixed(0)}` : null,
    stockQty != null ? `stock ${Number(stockQty).toFixed(0)}` : null,
  ].filter(Boolean).join(' · ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#fff"/>
  ${rects.join('\n  ')}
  <text x="${width / 2}" y="${barHeight + 18}" font-family="Arial, sans-serif" font-size="13" font-weight="700" text-anchor="middle">${escapeXml(name)}</text>
  <text x="${width / 2}" y="${barHeight + 34}" font-family="Arial, sans-serif" font-size="12" text-anchor="middle">${escapeXml(barcode)}${line2 ? ` · ${escapeXml(line2)}` : ''}</text>
</svg>`;
}

function productSelectSql() {
  return `SELECT id, category_id, name, description, price, cost_price, image_url,
                 emoji, is_popular, options, variants,
                 is_available, sort_order, product_type, barcode, track_stock,
                 stock_qty, stock_alert_qty, print_station_key
            FROM products`;
}

router.get('/', async (req, res) => {
  const { category_id, available_only } = req.query;
  const filters = [];
  const params = [];
  if (category_id) {
    params.push(category_id);
    filters.push(`category_id = $${params.length}`);
  }
  if (available_only === '1' || available_only === 'true') {
    filters.push('is_available = TRUE');
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT id, category_id, name, description, price, image_url,
            emoji, is_popular, options, variants,
            is_available, sort_order, product_type, barcode, track_stock,
            stock_qty, stock_alert_qty, print_station_key
       FROM products ${where} ORDER BY sort_order, id`,
    params
  );
  res.json(await attachNormalizedMenus(db, rows));
});

router.get('/admin', authRequired, requireRole('admin'), async (req, res) => {
  const { category_id, available_only } = req.query;
  const filters = [];
  const params = [];
  if (category_id) {
    params.push(category_id);
    filters.push(`category_id = $${params.length}`);
  }
  if (available_only === '1' || available_only === 'true') {
    filters.push('is_available = TRUE');
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT id, category_id, name, description, price, cost_price, image_url,
            emoji, is_popular, options, variants,
            is_available, sort_order, product_type, barcode, track_stock,
            stock_qty, stock_alert_qty, print_station_key
       FROM products ${where} ORDER BY sort_order, id`,
    params
  );
  res.json(await attachNormalizedMenus(db, rows));
});

router.post('/barcode/bulk-generate', authRequired, requireRole('admin'), async (req, res) => {
  const { category_id, category_name, force } = req.body || {};
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const params = [];
    let where = '';
    if (category_id) {
      params.push(category_id);
      where = `WHERE p.category_id = $${params.length}`;
    } else if (category_name) {
      params.push(`%${String(category_name).trim()}%`);
      where = `WHERE c.name ILIKE $${params.length}`;
    } else {
      where = `WHERE p.product_type = 'stock'
                  OR c.name ~* '(ขนม|ขบเคี้ยว|snack|ของกินเล่น)'`;
    }
    const target = await client.query(
      `SELECT p.id, p.barcode
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        ${where}
        ORDER BY p.id
        FOR UPDATE OF p`,
      params
    );
    const updated = [];
    for (const row of target.rows) {
      const barcode = await uniqueGeneratedBarcode(client, row.id);
      const saved = await client.query(
        `UPDATE products SET
            barcode = $2,
            product_type = 'stock',
            track_stock = TRUE,
            print_station_key = 'snack'
          WHERE id = $1
          RETURNING *`,
        [row.id, row.barcode && force !== true ? row.barcode : barcode]
      );
      updated.push(normalizeProductRow(saved.rows[0]));
    }
    await client.query('COMMIT');
    res.json({ updated_count: updated.length, products: updated });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.get('/barcode/:barcode', authRequired, requireRole('admin', 'staff'), async (req, res) => {
  const barcode = cleanBarcode(req.params.barcode);
  if (!barcode) return res.status(400).json({ error: 'barcode required' });
  const { rows } = await db.query(
    `SELECT id, category_id, name, description, price, cost_price, image_url,
            emoji, is_popular, options, variants,
            is_available, sort_order, product_type, barcode, track_stock,
            stock_qty, stock_alert_qty, print_station_key
       FROM products
      WHERE barcode = $1 AND is_available = TRUE
      LIMIT 1`,
    [barcode]
  );
  if (!rows[0]) return res.status(404).json({ error: 'ไม่พบสินค้าจากบาร์โค้ดนี้' });
  res.json((await attachNormalizedMenus(db, rows))[0]);
});

router.post('/:id/barcode/generate', authRequired, requireRole('admin'), async (req, res) => {
  const force = req.query.force === '1' || req.body?.force === true;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id, barcode FROM products WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    const barcode = current.rows[0].barcode && !force
      ? current.rows[0].barcode
      : await uniqueGeneratedBarcode(client, current.rows[0].id);
    const { rows } = await client.query(
      `UPDATE products SET
          barcode = $2,
          product_type = 'stock',
          track_stock = TRUE,
          print_station_key = 'snack'
        WHERE id = $1
        RETURNING *`,
      [req.params.id, barcode]
    );
    await client.query('COMMIT');
    res.json(normalizeProductRow(rows[0]));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.get('/:id/barcode/label.svg', authRequired, requireRole('admin', 'staff'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.price, p.barcode, p.stock_qty
       FROM products p
      WHERE p.id = $1`,
    [req.params.id]
  );
  const product = rows[0];
  if (!product) return res.status(404).json({ error: 'not found' });
  if (!product.barcode) return res.status(400).json({ error: 'product has no barcode' });
  const svg = code128Svg({
    barcode: product.barcode,
    name: product.name,
    price: product.price,
    stockQty: product.stock_qty,
  });
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(svg);
});

router.get('/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, category_id, name, description, price, image_url,
            emoji, is_popular, options, variants,
            is_available, sort_order, product_type, barcode, track_stock,
            stock_qty, stock_alert_qty, print_station_key
       FROM products WHERE id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json((await attachNormalizedMenus(db, rows))[0]);
});

router.post('/', authRequired, requireRole('admin'), async (req, res) => {
  const { category_id, name, description, price, image_url, sort_order,
          emoji, is_popular, options, variants, cost_price, product_type,
          barcode, track_stock, stock_qty, stock_alert_qty, print_station_key } = req.body || {};
  if (!name || price == null) return res.status(400).json({ error: 'name and price required' });
  const cost = cost_price == null || cost_price === '' ? 0 : Number(cost_price);
  if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'invalid cost_price' });
  const type = cleanProductType(product_type);
  const stationKey = stationForProduct(type, print_station_key);
  const menu = normalizeMenuPayload({ basePrice: price, options, variants });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO products (category_id, name, description, price, cost_price, image_url, sort_order,
                             emoji, is_popular, options, variants, product_type,
                             barcode, track_stock, stock_qty, stock_alert_qty, print_station_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
               $12, $13, $14, $15, $16, $17) RETURNING *`,
      [category_id || null, name, description || null, price, cost, image_url || null, sort_order || 0,
       emoji || null, is_popular === true,
       menu.options ? JSON.stringify(menu.options) : null,
       menu.variants ? JSON.stringify(menu.variants) : null,
       type, cleanBarcode(barcode), track_stock === true || type === 'stock',
       stockNumber(stock_qty, 0), stockNumber(stock_alert_qty, 0), stationKey]
    );
    await saveNormalizedMenu(client, rows[0].id, menu);
    await client.query('COMMIT');
    res.status(201).json(normalizeProductRow(rows[0]));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.put('/:id', authRequired, requireRole('admin'), async (req, res) => {
  const { category_id, name, description, price, image_url, is_available, sort_order,
          emoji, is_popular, options, variants, cost_price, product_type,
          barcode, track_stock, stock_qty, stock_alert_qty, print_station_key } = req.body || {};
  const cost = cost_price === undefined || cost_price === null || cost_price === ''
    ? undefined
    : Number(cost_price);
  if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) {
    return res.status(400).json({ error: 'invalid cost_price' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT price, options, variants, product_type, barcode, print_station_key FROM products WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    const nextPrice = price !== undefined && price !== null ? price : current.rows[0].price;
    const nextType = product_type !== undefined ? cleanProductType(product_type) : current.rows[0].product_type;
    const nextStation = print_station_key !== undefined
      ? stationForProduct(nextType, print_station_key)
      : current.rows[0].print_station_key;
    const menu = normalizeMenuPayload({
      basePrice: nextPrice,
      options: options !== undefined ? options : current.rows[0].options,
      variants: variants !== undefined ? variants : current.rows[0].variants,
    });
    const { rows } = await client.query(
      `UPDATE products SET
         category_id = COALESCE($1, category_id),
         name        = COALESCE($2, name),
         description = COALESCE($3, description),
         price       = COALESCE($4, price),
         cost_price  = COALESCE($5, cost_price),
         image_url   = COALESCE($6, image_url),
         is_available= COALESCE($7, is_available),
         sort_order  = COALESCE($8, sort_order),
         emoji       = COALESCE($9, emoji),
         is_popular  = COALESCE($10, is_popular),
         options     = $11::jsonb,
         variants    = $12::jsonb,
         product_type = COALESCE($13, product_type),
         barcode      = $14,
         track_stock  = COALESCE($15, track_stock),
         stock_qty    = COALESCE($16, stock_qty),
         stock_alert_qty = COALESCE($17, stock_alert_qty),
         print_station_key = COALESCE($18, print_station_key)
       WHERE id = $19 RETURNING *`,
      [category_id, name, description, price, cost, image_url, is_available, sort_order,
       emoji, is_popular,
       menu.options ? JSON.stringify(menu.options) : null,
       menu.variants ? JSON.stringify(menu.variants) : null,
       product_type !== undefined ? nextType : undefined,
       barcode !== undefined ? cleanBarcode(barcode) : current.rows[0].barcode,
       track_stock !== undefined ? (track_stock === true || nextType === 'stock') : undefined,
       stock_qty !== undefined ? stockNumber(stock_qty, 0) : undefined,
       stock_alert_qty !== undefined ? stockNumber(stock_alert_qty, 0) : undefined,
       print_station_key !== undefined || product_type !== undefined ? nextStation : undefined,
       req.params.id]
    );
    await saveNormalizedMenu(client, rows[0].id, menu);
    await client.query('COMMIT');
    res.json(normalizeProductRow(rows[0]));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// Hard-delete the product. Schema migration 001 changed
// `order_items.product_id` to `ON DELETE SET NULL`, and order_items also
// snapshot `product_name` + `unit_price` at order time — so historical
// orders/receipts keep displaying correctly even after the product row
// is gone.
router.delete('/:id', authRequired, requireRole('admin'), async (req, res) => {
  const { rows } = await db.query('SELECT image_url FROM products WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  await db.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  if (rows[0].image_url) _unlinkLocalImage(rows[0].image_url);
  res.status(204).end();
});

// ─── Image upload ────────────────────────────────────────────────────────
router.post(
  '/:id/image',
  authRequired,
  requireRole('admin'),
  upload.single('image'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no image uploaded' });
    const url = `/uploads/products/${req.file.filename}`;
    // Delete old image (best-effort) then update DB
    const old = await db.query('SELECT image_url FROM products WHERE id = $1', [req.params.id]);
    if (!old.rows[0]) {
      // No such product — clean up the file we just wrote
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'product not found' });
    }
    if (old.rows[0].image_url) _unlinkLocalImage(old.rows[0].image_url);

    const { rows } = await db.query(
      'UPDATE products SET image_url = $1 WHERE id = $2 RETURNING *',
      [url, req.params.id]
    );
    res.status(201).json(rows[0]);
  }
);

router.delete('/:id/image', authRequired, requireRole('admin'), async (req, res) => {
  const { rows } = await db.query('SELECT image_url FROM products WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  if (rows[0].image_url) _unlinkLocalImage(rows[0].image_url);
  const upd = await db.query(
    'UPDATE products SET image_url = NULL WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  res.json(upd.rows[0]);
});

function _unlinkLocalImage(urlPath) {
  if (!urlPath || !urlPath.startsWith('/uploads/products/')) return;
  const filename = path.basename(urlPath);
  const full = path.join(UPLOAD_DIR, filename);
  // Defensive: ensure resolved path still under UPLOAD_DIR
  if (!path.resolve(full).startsWith(path.resolve(UPLOAD_DIR))) return;
  try { fs.unlinkSync(full); } catch {}
}

module.exports = router;

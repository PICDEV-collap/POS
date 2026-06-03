const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { resolveStoreId } = require('../lib/storeScope');

const router = express.Router();

router.get('/', async (req, res) => {
  const storeId = Number(req.query.store_id || 1);
  const { rows } = await db.query(
    `SELECT id, name, icon, sort_order, is_active
       FROM categories WHERE is_active = TRUE AND store_id = $1 ORDER BY sort_order, id`,
    [storeId]
  );
  res.json(rows);
});

router.post('/', authRequired, requireRole('admin'), async (req, res) => {
  const { name, icon, sort_order } = req.body || {};
  const storeId = resolveStoreId(req);
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await db.query(
    'INSERT INTO categories (store_id, name, icon, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
    [storeId, name, icon || null, sort_order || 0]
  );
  res.status(201).json(rows[0]);
});

router.put('/:id', authRequired, requireRole('admin'), async (req, res) => {
  const { name, icon, sort_order, is_active } = req.body || {};
  const storeId = resolveStoreId(req);
  const { rows } = await db.query(
    `UPDATE categories
       SET name       = COALESCE($1, name),
           icon       = COALESCE($2, icon),
           sort_order = COALESCE($3, sort_order),
           is_active  = COALESCE($4, is_active)
     WHERE id = $5 AND store_id = $6 RETURNING *`,
    [name, icon, sort_order, is_active, req.params.id, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// Hard-delete the category. Schema has `category_id REFERENCES categories(id)
// ON DELETE SET NULL` on products, so any product in this category just gets
// `category_id = NULL` (it stays in the menu, no orphan). To merely hide a
// category, set `is_active = false` via PUT instead.
router.delete('/:id', authRequired, requireRole('admin'), async (req, res) => {
  const storeId = resolveStoreId(req);
  const { rowCount } = await db.query('DELETE FROM categories WHERE id = $1 AND store_id = $2', [req.params.id, storeId]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// Admin needs to see ALL categories including inactive ones for management
router.get('/all', authRequired, requireRole('admin'), async (req, res) => {
  const storeId = resolveStoreId(req);
  const { rows } = await db.query(
    'SELECT id, store_id, name, icon, sort_order, is_active FROM categories WHERE store_id = $1 ORDER BY sort_order, id',
    [storeId]
  );
  res.json(rows);
});

module.exports = router;

const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (_req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, icon, sort_order, is_active
       FROM categories WHERE is_active = TRUE ORDER BY sort_order, id`
  );
  res.json(rows);
});

router.post('/', authRequired, requireRole('admin'), async (req, res) => {
  const { name, icon, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await db.query(
    'INSERT INTO categories (name, icon, sort_order) VALUES ($1, $2, $3) RETURNING *',
    [name, icon || null, sort_order || 0]
  );
  res.status(201).json(rows[0]);
});

router.put('/:id', authRequired, requireRole('admin'), async (req, res) => {
  const { name, icon, sort_order, is_active } = req.body || {};
  const { rows } = await db.query(
    `UPDATE categories
       SET name       = COALESCE($1, name),
           icon       = COALESCE($2, icon),
           sort_order = COALESCE($3, sort_order),
           is_active  = COALESCE($4, is_active)
     WHERE id = $5 RETURNING *`,
    [name, icon, sort_order, is_active, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// Hard-delete the category. Schema has `category_id REFERENCES categories(id)
// ON DELETE SET NULL` on products, so any product in this category just gets
// `category_id = NULL` (it stays in the menu, no orphan). To merely hide a
// category, set `is_active = false` via PUT instead.
router.delete('/:id', authRequired, requireRole('admin'), async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// Admin needs to see ALL categories including inactive ones for management
router.get('/all', authRequired, requireRole('admin'), async (_req, res) => {
  const { rows } = await db.query(
    'SELECT id, name, icon, sort_order, is_active FROM categories ORDER BY sort_order, id'
  );
  res.json(rows);
});

module.exports = router;

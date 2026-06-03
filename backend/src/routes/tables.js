const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const logger = require('../lib/logger');
const { resolveStoreId } = require('../lib/storeScope');

const router = express.Router();

function newQrToken() {
  return crypto.randomBytes(16).toString('hex');
}

router.get('/', authRequired, async (req, res) => {
  const storeId = resolveStoreId(req);
  const { rows } = await db.query(
    `SELECT id, store_id, code, name, seats, qr_token, is_active,
            (upper(code) = 'TAKEAWAY' OR seats = 0) AS is_takeaway
       FROM tables
      WHERE store_id = $1
      ORDER BY CASE WHEN upper(code) = 'TAKEAWAY' THEN 1 ELSE 0 END, code`
    ,
    [storeId]
  );
  res.json(rows);
});

router.post('/', authRequired, requireRole('admin'), async (req, res) => {
  const { code, name, seats } = req.body || {};
  const storeId = resolveStoreId(req);
  if (!code || !name) return res.status(400).json({ error: 'code and name required' });
  const token = newQrToken();
  try {
    const { rows } = await db.query(
      'INSERT INTO tables (store_id, code, name, seats, qr_token) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [storeId, code, name, seats || 4, token]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'table code already exists' });
    throw e;
  }
});

router.post('/rotate-qr-all', authRequired, requireRole('admin'), async (req, res) => {
  const storeId = resolveStoreId(req);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows: tables } = await client.query(
      `SELECT id, code, name
         FROM tables
        WHERE is_active = TRUE
          AND store_id = $1
        ORDER BY CASE WHEN upper(code) = 'TAKEAWAY' THEN 1 ELSE 0 END, code
        FOR UPDATE`,
      [storeId]
    );

    const rotated = [];
    for (const table of tables) {
      const token = newQrToken();
      const { rows } = await client.query(
        `UPDATE tables
            SET qr_token = $1
          WHERE id = $2 AND store_id = $3
          RETURNING id, store_id, code, name, seats, qr_token, is_active,
                    (upper(code) = 'TAKEAWAY' OR seats = 0) AS is_takeaway`,
        [token, table.id, storeId]
      );
      rotated.push(rows[0]);
    }

    const tableIds = rotated.map((t) => t.id);
    let expiredSessions = 0;
    if (tableIds.length) {
      const expired = await client.query(
        `UPDATE customer_order_sessions
            SET is_active = FALSE, last_seen_at = NOW()
          WHERE is_active = TRUE
            AND table_id = ANY($1::int[])
            AND store_id = $2`,
        [tableIds, storeId]
      );
      expiredSessions = expired.rowCount || 0;
    }

    await client.query('COMMIT');
    logger.warn('tables', 'all active table QR tokens rotated', {
      rotated_count: rotated.length,
      expired_sessions: expiredSessions,
    });
    res.json({
      rotated_count: rotated.length,
      expired_sessions: expiredSessions,
      tables: rotated,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.post('/:id/rotate-qr', authRequired, requireRole('admin'), async (req, res) => {
  const storeId = resolveStoreId(req);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const token = newQrToken();
    const { rows } = await client.query(
      `UPDATE tables
          SET qr_token = $1
        WHERE id = $2
          AND store_id = $3
        RETURNING id, code, name, seats, qr_token, is_active,
                  (upper(code) = 'TAKEAWAY' OR seats = 0) AS is_takeaway`,
      [token, req.params.id, storeId]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    const expired = await client.query(
      `UPDATE customer_order_sessions
          SET is_active = FALSE, last_seen_at = NOW()
        WHERE is_active = TRUE
          AND table_id = $1
          AND store_id = $2`,
      [req.params.id, storeId]
    );
    await client.query('COMMIT');
    logger.warn('tables', 'table QR token rotated', {
      table_id: rows[0].id,
      expired_sessions: expired.rowCount || 0,
    });
    res.json({ ...rows[0], expired_sessions: expired.rowCount || 0 });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.put('/:id', authRequired, requireRole('admin'), async (req, res) => {
  const { name, seats, is_active } = req.body || {};
  const storeId = resolveStoreId(req);
  const { rows } = await db.query(
    `UPDATE tables SET
        name = COALESCE($1, name),
        seats = COALESCE($2, seats),
        is_active = COALESCE($3, is_active)
      WHERE id = $4 AND store_id = $5 RETURNING *`,
    [name, seats, is_active, req.params.id, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

router.delete('/:id', authRequired, requireRole('admin'), async (req, res) => {
  const storeId = resolveStoreId(req);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const tableResult = await client.query(
      'SELECT id, code, name FROM tables WHERE id = $1 AND store_id = $2 FOR UPDATE',
      [req.params.id, storeId]
    );
    const table = tableResult.rows[0];
    if (!table) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }

    const orderResult = await client.query(
      'SELECT COUNT(*)::int AS count FROM orders WHERE table_id = $1 AND store_id = $2',
      [req.params.id, storeId]
    );
    const ordersCount = Number(orderResult.rows[0]?.count || 0);
    if (ordersCount > 0 || String(table.code).toUpperCase() === 'TAKEAWAY') {
      const { rows } = await client.query(
        'UPDATE tables SET is_active = FALSE WHERE id = $1 AND store_id = $2 RETURNING id, store_id, code, name, seats, qr_token, is_active',
        [req.params.id, storeId]
      );
      await client.query('COMMIT');
      return res.json({
        ...rows[0],
        deactivated: true,
        deleted: false,
        orders_count: ordersCount,
      });
    }

    await client.query('DELETE FROM tables WHERE id = $1 AND store_id = $2', [req.params.id, storeId]);
    await client.query('COMMIT');
    return res.status(204).end();
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

module.exports = router;

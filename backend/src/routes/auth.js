const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { signToken, authRequired } = require('../middleware/auth');
const { parseStoreIds } = require('../lib/storeScope');

const router = express.Router();

function selectedStoreId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function activeStore(id) {
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT id, code, slug, name, logo, currency, public_base_url, timezone, is_active
       FROM stores
      WHERE id = $1 AND is_active = TRUE`,
    [id]
  );
  return rows[0] || null;
}

router.get('/stores', async (_req, res) => {
  const { rows } = await db.query(
    `SELECT id, code, slug, name, logo, currency, public_base_url, timezone, is_active
       FROM stores
      WHERE is_active = TRUE
      ORDER BY id`
  );
  res.json(rows);
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const requestedStoreId = selectedStoreId(req.body?.store_id);
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const { rows } = await db.query(
    `SELECT id, username, password_hash, full_name, role, is_active,
            COALESCE(store_id, 1) AS store_id,
            COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) AS allowed_store_ids,
            COALESCE(permissions, '[]'::jsonb) AS permissions
       FROM users
      WHERE username = $1`,
    [username]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });

  let sessionUser = user;
  if (requestedStoreId) {
    const store = await activeStore(requestedStoreId);
    if (!store) return res.status(403).json({ error: 'selected store not available' });
    const allowedStoreIds = parseStoreIds(user.allowed_store_ids);
    const canUseStore =
      user.role === 'super_admin' || allowedStoreIds.includes(requestedStoreId);
    if (!canUseStore) {
      return res.status(403).json({ error: 'selected store is not allowed for this user' });
    }
    sessionUser = { ...user, store_id: requestedStoreId };
  }

  const token = signToken(sessionUser);
  return res.json({
    token,
    user: {
      id: sessionUser.id,
      username: sessionUser.username,
      full_name: sessionUser.full_name,
      role: sessionUser.role,
      store_id: sessionUser.store_id,
      allowed_store_ids: sessionUser.allowed_store_ids,
      permissions: sessionUser.permissions,
    },
  });
});

router.post('/staff-session', async (req, res) => {
  const disabled = String(process.env.STAFF_AUTO_SESSION_DISABLED || '').toLowerCase();
  if (disabled === '1' || disabled === 'true') {
    return res.status(403).json({ error: 'staff auto session disabled' });
  }
  const requestedStoreId = selectedStoreId(req.body?.store_id);
  if (requestedStoreId && !(await activeStore(requestedStoreId))) {
    return res.status(403).json({ error: 'selected store not available' });
  }
  const params = [];
  let storeFilter = '';
  if (requestedStoreId) {
    params.push(requestedStoreId);
    storeFilter = `AND $${params.length} = ANY(COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]))`;
  }
  const { rows } = await db.query(
    `SELECT id, username, full_name,
            COALESCE(store_id, 1) AS store_id,
            COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) AS allowed_store_ids,
            COALESCE(permissions, '[]'::jsonb) AS permissions
       FROM users
      WHERE role = 'staff' AND is_active = true
        ${storeFilter}
      ORDER BY id
      LIMIT 1`,
    params
  );
  const staff = rows[0];
  if (!staff) {
    return res.status(503).json({ error: 'no active staff user configured' });
  }
  const user = {
    id: staff.id,
    username: staff.username,
    full_name: staff.full_name,
    role: 'staff',
    store_id: requestedStoreId || staff.store_id,
    allowed_store_ids: staff.allowed_store_ids,
    permissions: staff.permissions,
  };
  const token = signToken(user);
  console.log(`[auth] staff auto-session issued user=${user.username} ip=${req.ip}`);
  return res.json({ token, user });
});

router.get('/me', authRequired, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, username, full_name, role,
            COALESCE(store_id, 1) AS store_id,
            COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) AS allowed_store_ids,
            COALESCE(permissions, '[]'::jsonb) AS permissions
       FROM users
      WHERE id = $1`,
    [req.user.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: 'user not found' });
  return res.json({ ...rows[0], store_id: req.user.store_id });
});

module.exports = router;

const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { parseStoreIds } = require('../lib/storeScope');

const router = express.Router();

const VALID_ROLES = new Set(['super_admin', 'admin', 'staff', 'kitchen']);
const STORE_ADMIN_ROLES = new Set(['staff', 'kitchen']);
const VALID_PERMISSIONS = new Set(['mobile_admin', 'store_admin']);
const BCRYPT_COST = parseInt(process.env.BCRYPT_COST, 10) || 12;

function parseBool(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function cleanText(value, max = 128) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function cleanUsername(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(text)) return null;
  return text;
}

function cleanRole(value) {
  const role = String(value || '').trim();
  return VALID_ROLES.has(role) ? role : null;
}

function cleanStoreIds(value) {
  const ids = parseStoreIds(value);
  return [...new Set(ids)].filter((id) => id > 0);
}

function cleanPermissions(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [...new Set(raw.map((v) => String(v).trim()).filter((v) => VALID_PERMISSIONS.has(v)))];
}

function requesterStoreIds(req) {
  return cleanStoreIds(req.user?.allowed_store_ids);
}

function isStoreAdmin(req) {
  return req.user?.role === 'admin'
    && cleanPermissions(req.user?.permissions).includes('store_admin')
    && requesterStoreIds(req).length > 0;
}

function requireUserManager(req, res) {
  if (req.user?.role === 'super_admin') return true;
  if (isStoreAdmin(req)) return true;
  res.status(403).json({ error: 'user management permission required' });
  return false;
}

function storesWithinManager(req, storeIds) {
  if (req.user?.role === 'super_admin') return true;
  const allowed = requesterStoreIds(req);
  return storeIds.length > 0 && storeIds.every((id) => allowed.includes(id));
}

function canManageRole(req, role) {
  if (req.user?.role === 'super_admin') return true;
  return STORE_ADMIN_ROLES.has(role);
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    store_id: Number(row.store_id || 1),
    allowed_store_ids: cleanStoreIds(row.allowed_store_ids),
    permissions: cleanPermissions(row.permissions),
    is_active: !!row.is_active,
    created_at: row.created_at,
  };
}

async function loadUser(id) {
  const { rows } = await db.query(
    `SELECT id, username, full_name, role, is_active, created_at,
            COALESCE(store_id, 1) AS store_id,
            COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) AS allowed_store_ids,
            COALESCE(permissions, '[]'::jsonb) AS permissions
       FROM users
      WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

router.get('/', authRequired, requireRole('admin'), async (req, res) => {
  if (!requireUserManager(req, res)) return;
  const params = [];
  let where = '';
  if (req.user.role !== 'super_admin') {
    params.push(requesterStoreIds(req));
    where = `WHERE role IN ('staff', 'kitchen')
               AND COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) <@ $${params.length}::int[]`;
  }
  const { rows } = await db.query(
    `SELECT id, username, full_name, role, is_active, created_at,
            COALESCE(store_id, 1) AS store_id,
            COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) AS allowed_store_ids,
            COALESCE(permissions, '[]'::jsonb) AS permissions
       FROM users
       ${where}
      ORDER BY is_active DESC, role, username`,
    params
  );
  res.json(rows.map(publicUser));
});

router.post('/', authRequired, requireRole('admin'), async (req, res) => {
  if (!requireUserManager(req, res)) return;
  const username = cleanUsername(req.body?.username);
  const password = String(req.body?.password || '');
  const role = cleanRole(req.body?.role);
  const storeId = Number(req.body?.store_id);
  const allowedStoreIds = cleanStoreIds(req.body?.allowed_store_ids?.length ? req.body.allowed_store_ids : [storeId]);
  const fullName = cleanText(req.body?.full_name);
  const isActive = parseBool(req.body?.is_active, true);
  const permissions = req.user.role === 'super_admin' ? cleanPermissions(req.body?.permissions) : [];

  if (!username) return res.status(400).json({ error: 'invalid username' });
  if (!role) return res.status(400).json({ error: 'invalid role' });
  if (!Number.isInteger(storeId) || storeId <= 0) return res.status(400).json({ error: 'invalid store id' });
  if (allowedStoreIds.length === 0) return res.status(400).json({ error: 'allowed stores required' });
  if (!allowedStoreIds.includes(storeId)) return res.status(400).json({ error: 'primary store must be allowed' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  if (!canManageRole(req, role)) return res.status(403).json({ error: 'cannot manage this role' });
  if (!storesWithinManager(req, allowedStoreIds) || !storesWithinManager(req, [storeId])) {
    return res.status(403).json({ error: 'store access forbidden' });
  }
  if (role !== 'admin' && permissions.length > 0) {
    return res.status(400).json({ error: 'permissions are only valid for admin users' });
  }

  const hash = await bcrypt.hash(password, BCRYPT_COST);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, full_name, role, store_id, allowed_store_ids, permissions, is_active)
       VALUES ($1, $2, $3, $4, $5, $6::int[], $7::jsonb, $8)
       RETURNING id, username, full_name, role, is_active, created_at,
                 store_id, allowed_store_ids, permissions`,
      [username, hash, fullName, role, storeId, allowedStoreIds, JSON.stringify(permissions), isActive]
    );
    res.status(201).json(publicUser(rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'username already exists' });
    throw e;
  }
});

router.put('/:id', authRequired, requireRole('admin'), async (req, res) => {
  if (!requireUserManager(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid user id' });
  const current = await loadUser(id);
  if (!current) return res.status(404).json({ error: 'user not found' });

  if (!canManageRole(req, current.role) || !storesWithinManager(req, cleanStoreIds(current.allowed_store_ids))) {
    return res.status(403).json({ error: 'cannot manage this user' });
  }

  const username = req.body?.username === undefined ? current.username : cleanUsername(req.body.username);
  const role = req.body?.role === undefined ? current.role : cleanRole(req.body.role);
  const storeId = req.body?.store_id === undefined ? Number(current.store_id) : Number(req.body.store_id);
  const allowedStoreIds = req.body?.allowed_store_ids === undefined
    ? cleanStoreIds(current.allowed_store_ids)
    : cleanStoreIds(req.body.allowed_store_ids);
  const fullName = req.body?.full_name === undefined ? current.full_name : cleanText(req.body.full_name);
  const isActive = parseBool(req.body?.is_active, current.is_active);
  const permissions = req.user.role === 'super_admin'
    ? (req.body?.permissions === undefined ? cleanPermissions(current.permissions) : cleanPermissions(req.body.permissions))
    : cleanPermissions(current.permissions);
  const password = req.body?.password === undefined ? null : String(req.body.password || '');

  if (!username) return res.status(400).json({ error: 'invalid username' });
  if (!role) return res.status(400).json({ error: 'invalid role' });
  if (!Number.isInteger(storeId) || storeId <= 0) return res.status(400).json({ error: 'invalid store id' });
  if (allowedStoreIds.length === 0) return res.status(400).json({ error: 'allowed stores required' });
  if (!allowedStoreIds.includes(storeId)) return res.status(400).json({ error: 'primary store must be allowed' });
  if (password !== null && password.length > 0 && password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (!canManageRole(req, role)) return res.status(403).json({ error: 'cannot manage this role' });
  if (!storesWithinManager(req, allowedStoreIds) || !storesWithinManager(req, [storeId])) {
    return res.status(403).json({ error: 'store access forbidden' });
  }
  if (role !== 'admin' && permissions.length > 0) {
    return res.status(400).json({ error: 'permissions are only valid for admin users' });
  }
  if (id === Number(req.user.sub) && isActive === false) {
    return res.status(400).json({ error: 'cannot deactivate your own account' });
  }

  const hash = password ? await bcrypt.hash(password, BCRYPT_COST) : null;
  try {
    const { rows } = await db.query(
      `UPDATE users
          SET username = $1,
              password_hash = COALESCE($2, password_hash),
              full_name = $3,
              role = $4,
              store_id = $5,
              allowed_store_ids = $6::int[],
              permissions = $7::jsonb,
              is_active = $8
        WHERE id = $9
        RETURNING id, username, full_name, role, is_active, created_at,
                  store_id, allowed_store_ids, permissions`,
      [username, hash, fullName, role, storeId, allowedStoreIds, JSON.stringify(permissions), isActive, id]
    );
    res.json(publicUser(rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'username already exists' });
    throw e;
  }
});

module.exports = router;

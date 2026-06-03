const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { signToken, authRequired } = require('../middleware/auth');
const { parseStoreIds } = require('../lib/storeScope');
const { clientIp } = require('../lib/accessBoundary');
const { assertNotLocked, recordFailure, clearAttempts } = require('../lib/loginGuard');
const {
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
} = require('../lib/refreshTokens');

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

async function loadUserById(id) {
  const { rows } = await db.query(
    `SELECT id, username, password_hash, full_name, role, is_active,
            COALESCE(store_id, 1) AS store_id,
            COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) AS allowed_store_ids,
            COALESCE(permissions, '[]'::jsonb) AS permissions
       FROM users
      WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

function applyStoreScope(user, requestedStoreId) {
  if (!requestedStoreId) return user;
  const allowedStoreIds = parseStoreIds(user.allowed_store_ids);
  const canUseStore =
    user.role === 'super_admin' || allowedStoreIds.includes(requestedStoreId);
  if (!canUseStore) {
    const err = new Error('selected store is not allowed for this user');
    err.status = 403;
    throw err;
  }
  return { ...user, store_id: requestedStoreId };
}

async function authPayload(sessionUser, req) {
  const token = signToken(sessionUser);
  const refresh = await issueRefreshToken(sessionUser.id, {
    ip: clientIp(req),
    userAgent: req.headers['user-agent'],
  });
  return {
    token,
    refresh_token: refresh.token,
    refresh_expires_at: refresh.expires_at,
    user: {
      id: sessionUser.id,
      username: sessionUser.username,
      full_name: sessionUser.full_name,
      role: sessionUser.role,
      store_id: sessionUser.store_id,
      allowed_store_ids: sessionUser.allowed_store_ids,
      permissions: sessionUser.permissions,
    },
  };
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
  const normalizedUser = String(username || '').trim();
  if (!normalizedUser || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  try {
    await assertNotLocked(normalizedUser);
  } catch (e) {
    return res.status(e.status || 429).json({ error: e.message });
  }

  const { rows } = await db.query(
    `SELECT id, username, password_hash, full_name, role, is_active,
            COALESCE(store_id, 1) AS store_id,
            COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) AS allowed_store_ids,
            COALESCE(permissions, '[]'::jsonb) AS permissions
       FROM users
      WHERE username = $1`,
    [normalizedUser]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    await recordFailure(normalizedUser);
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const attempt = await recordFailure(normalizedUser);
    if (attempt.locked_until) {
      return res.status(429).json({ error: 'บัญชีถูกล็อกชั่วคราว ลองใหม่ภายหลัง' });
    }
    return res.status(401).json({ error: 'invalid credentials' });
  }

  await clearAttempts(normalizedUser);

  try {
    if (requestedStoreId) {
      const store = await activeStore(requestedStoreId);
      if (!store) return res.status(403).json({ error: 'selected store not available' });
    }
    const sessionUser = applyStoreScope(user, requestedStoreId);
    return res.json(await authPayload(sessionUser, req));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/refresh', async (req, res) => {
  const raw = req.body?.refresh_token;
  if (!raw) return res.status(400).json({ error: 'refresh_token required' });
  const consumed = await consumeRefreshToken(raw);
  if (!consumed) return res.status(401).json({ error: 'invalid refresh token' });

  const user = await loadUserById(consumed.userId);
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'invalid refresh token' });
  }

  const requestedStoreId = selectedStoreId(req.body?.store_id);
  try {
    if (requestedStoreId) {
      const store = await activeStore(requestedStoreId);
      if (!store) return res.status(403).json({ error: 'selected store not available' });
    }
    const sessionUser = applyStoreScope(user, requestedStoreId);
    return res.json(await authPayload(sessionUser, req));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/logout', async (req, res) => {
  const raw = req.body?.refresh_token;
  if (raw) await revokeRefreshToken(raw);
  return res.json({ ok: true });
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
  console.log(`[auth] staff auto-session issued user=${user.username} ip=${req.ip}`);
  return res.json(await authPayload(user, req));
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

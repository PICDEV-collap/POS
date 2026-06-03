const jwt = require('jsonwebtoken');
const db = require('../db');
const {
  adminControlLanOnlyEnabled,
  clientIp,
  isAdminControlPath,
  isLocalControlRequest,
  isMobileStoreAdmin,
  isMobileStoreAdminAllowedControlPath,
} = require('../lib/accessBoundary');
const { parseStoreIds } = require('../lib/storeScope');

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      store_id: user.store_id || 1,
      allowed_store_ids: user.allowed_store_ids || [user.store_id || 1],
      permissions: user.permissions || [],
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
  try {
    const { rows } = await db.query(
      `SELECT id, username, full_name, role, is_active,
              COALESCE(store_id, 1) AS store_id,
              COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) AS allowed_store_ids,
              COALESCE(permissions, '[]'::jsonb) AS permissions
         FROM users
        WHERE id = $1`,
      [decoded.sub]
    );
    const user = rows[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'invalid token' });
    const tokenStoreId = Number(decoded.store_id);
    const allowedStoreIds = parseStoreIds(user.allowed_store_ids);
    const fallbackStoreId = Number(user.store_id || 1);
    const effectiveStoreId =
      Number.isInteger(tokenStoreId)
      && tokenStoreId > 0
      && (user.role === 'super_admin' || allowedStoreIds.includes(tokenStoreId))
        ? tokenStoreId
        : fallbackStoreId;
    req.user = {
      ...decoded,
      sub: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      store_id: effectiveStoreId,
      allowed_store_ids: user.allowed_store_ids,
      permissions: user.permissions,
    };
    return next();
  } catch (e) {
    return next(e);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'missing token' });
    const isSuperAdmin = req.user.role === 'super_admin';
    if (!isSuperAdmin && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (
      adminControlLanOnlyEnabled()
      && (isSuperAdmin || req.user.role === 'admin')
      && roles.includes('admin')
      && isAdminControlPath(req)
      && !isLocalControlRequest(req)
    ) {
      const mobileStoreAdminAllowed = !isSuperAdmin
        && isMobileStoreAdmin(req)
        && isMobileStoreAdminAllowedControlPath(req);
      if (mobileStoreAdminAllowed) return next();
      console.warn(`[auth] admin control blocked outside LAN user=${req.user.username} ip=${clientIp(req)} path=${req.originalUrl}`);
      return res.status(403).json({ error: 'admin control requires server LAN or mobile store-admin permission' });
    }
    return next();
  };
}

module.exports = { signToken, authRequired, requireRole };

const db = require('../db');
const { clientIp } = require('./accessBoundary');

function auditEnabled() {
  return String(process.env.AUDIT_LOG_DISABLED || '').toLowerCase() !== 'true';
}

async function writeAudit(req, {
  action,
  targetType = null,
  targetId = null,
  details = {},
}) {
  if (!auditEnabled() || !req?.user) return;
  const user = req.user;
  try {
    await db.query(
      `INSERT INTO audit_log
         (user_id, username, role, store_id, action, target_type, target_id, ip_address, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        user.sub || null,
        user.username || null,
        user.role || null,
        user.store_id || null,
        action,
        targetType,
        targetId != null ? String(targetId) : null,
        clientIp(req),
        JSON.stringify(details || {}),
      ]
    );
  } catch (e) {
    console.warn('[audit] write failed:', e.message);
  }
}

module.exports = { writeAudit, auditEnabled };

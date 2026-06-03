const crypto = require('crypto');
const db = require('../db');

const TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS, 10) || 7;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function issueRefreshToken(userId, { ip, userAgent } = {}) {
  const token = newRefreshToken();
  const tokenHash = hashToken(token);
  const { rows } = await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, NOW() + make_interval(days => $3::int), $4, $5)
     RETURNING expires_at`,
    [userId, tokenHash, String(TTL_DAYS), ip || null, userAgent || null]
  );
  return { token, expires_at: rows[0].expires_at };
}

async function consumeRefreshToken(rawToken) {
  const tokenHash = hashToken(String(rawToken || '').trim());
  if (!tokenHash) return null;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, user_id, expires_at
         FROM refresh_tokens
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `UPDATE refresh_tokens
          SET revoked_at = NOW(), last_used_at = NOW()
        WHERE id = $1`,
      [row.id]
    );
    await client.query('COMMIT');
    return { userId: row.user_id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function revokeRefreshToken(rawToken) {
  const tokenHash = hashToken(String(rawToken || '').trim());
  if (!tokenHash) return 0;
  const { rowCount } = await db.query(
    `UPDATE refresh_tokens
        SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
  return rowCount;
}

async function revokeAllForUser(userId) {
  await db.query(
    `UPDATE refresh_tokens
        SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

module.exports = {
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  TTL_DAYS,
};

const db = require('../db');

const MAX_ATTEMPTS = parseInt(process.env.LOGIN_MAX_ATTEMPTS, 10) || 5;
const LOCK_MINUTES = parseInt(process.env.LOGIN_LOCK_MINUTES, 10) || 15;

async function getAttempt(username) {
  const { rows } = await db.query(
    `SELECT username, failed_count, locked_until
       FROM login_attempts
      WHERE username = $1`,
    [username]
  );
  return rows[0] || null;
}

function isLocked(row) {
  if (!row?.locked_until) return false;
  return new Date(row.locked_until).getTime() > Date.now();
}

async function assertNotLocked(username) {
  const row = await getAttempt(username);
  if (isLocked(row)) {
    const err = new Error('บัญชีถูกล็อกชั่วคราว ลองใหม่ภายหลัง');
    err.status = 429;
    throw err;
  }
}

async function recordFailure(username) {
  const { rows } = await db.query(
    `INSERT INTO login_attempts (username, failed_count, locked_until, updated_at)
     VALUES ($1, 1, NULL, NOW())
     ON CONFLICT (username) DO UPDATE SET
       failed_count = login_attempts.failed_count + 1,
       locked_until = CASE
         WHEN login_attempts.failed_count + 1 >= $2
           THEN NOW() + make_interval(mins => $3::int)
         ELSE login_attempts.locked_until
       END,
       updated_at = NOW()
     RETURNING failed_count, locked_until`,
    [username, MAX_ATTEMPTS, String(LOCK_MINUTES)]
  );
  return rows[0];
}

async function clearAttempts(username) {
  await db.query('DELETE FROM login_attempts WHERE username = $1', [username]);
}

module.exports = {
  assertNotLocked,
  recordFailure,
  clearAttempts,
  isLocked,
  MAX_ATTEMPTS,
  LOCK_MINUTES,
};

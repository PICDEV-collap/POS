#!/usr/bin/env node
// Apply production security settings (env + DB cleanup). Safe to re-run.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/db');

const ENV_PATH = path.join(__dirname, '..', '.env');
const DEV_USERNAMES = ['staff1', 'kitchen'];

function upsertEnv(lines, key, value) {
  const prefix = `${key}=`;
  let found = false;
  const out = lines.map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) out.push(`${key}=${value}`);
  return out;
}

function patchEnv(updates) {
  const raw = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  let lines = raw.split(/\r?\n/).filter((line, i, arr) => !(line === '' && i === arr.length - 1));
  for (const [key, value] of Object.entries(updates)) {
    lines = upsertEnv(lines, key, value);
  }
  fs.writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const rotateJwt = String(process.env.HARDEN_ROTATE_JWT || '1') !== '0';
  const updates = {
    NODE_ENV: 'production',
    JWT_EXPIRES_IN: '2h',
    BCRYPT_COST: '12',
    LISTEN_HOST: '127.0.0.1',
    ADMIN_CONTROL_LAN_ONLY: 'true',
    STAFF_AUTO_SESSION_DISABLED: 'true',
    LOGIN_MAX_ATTEMPTS: '5',
    LOGIN_LOCK_MINUTES: '15',
    REFRESH_TOKEN_DAYS: '7',
  };
  if (rotateJwt) {
    updates.JWT_SECRET = crypto.randomBytes(64).toString('hex');
    console.log('Generated new JWT_SECRET (all users must log in again).');
  }
  patchEnv(updates);
  console.log('Updated backend/.env production keys.');

  const off = await db.query(
    `UPDATE users
        SET is_active = FALSE
      WHERE username = ANY($1::text[])
        AND username <> 'admin'`,
    [DEV_USERNAMES]
  );
  console.log(`Deactivated dev users: ${off.rowCount} (${DEV_USERNAMES.join(', ')})`);

  const weak = await db.query(
    `SELECT username FROM users
      WHERE username IN ('admin', 'staff1', 'kitchen')
        AND is_active = TRUE`
  );
  if (weak.rows.length) {
    console.log('Active users still present:', weak.rows.map((r) => r.username).join(', '));
    console.log('Ensure passwords are strong (create-admin.js if needed).');
  }

  await db.pool.end();
  console.log('Done. Restart pos-v2-backend and pos-v2-web.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

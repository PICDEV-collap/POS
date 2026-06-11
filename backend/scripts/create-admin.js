// Create or update an admin user with a properly bcrypt-hashed password.
// Usage:  node scripts/create-admin.js <username> <password> [full_name]
//
// In production this is the recommended way to bootstrap your first admin
// (instead of running db:seed which inserts well-known dev passwords).
require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../src/db');

const BCRYPT_COST = parseInt(process.env.BCRYPT_COST, 10) || 12;

(async () => {
  const [, , username, password, ...rest] = process.argv;
  const fullName = rest.join(' ').trim() || username;

  if (!username || !password) {
    console.error('Usage: node scripts/create-admin.js <username> <password> [full_name]');
    process.exit(2);
  }
  if (password.length < 10) {
    console.error('Password too short — use ≥10 characters.');
    process.exit(2);
  }

  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           full_name     = EXCLUDED.full_name,
           role          = 'admin'
     RETURNING id, username, role`,
    [username, hash, fullName]
  );
  console.log(`✓ admin ready: ${JSON.stringify(rows[0])}`);
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });

// Seed the database: applies database/seed.sql for catalog data,
// then creates dev users with bcrypt-hashed passwords.
//
// REFUSES to insert default-password users when NODE_ENV=production
// unless ALLOW_INSECURE_SEED=1 is also set (e.g. for first-run bootstrap that
// is followed immediately by a password change).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const db = require('../src/db');

const BCRYPT_COST = parseInt(process.env.BCRYPT_COST, 10) || 12;

const DEV_USERS = [
  { username: 'admin',   password: 'admin123',   full_name: 'Administrator', role: 'super_admin', store_id: 1, allowed_store_ids: [1] },
  { username: 'staff1',  password: 'staff123',   full_name: 'พนักงาน 1',     role: 'staff',       store_id: 1, allowed_store_ids: [1] },
  { username: 'kitchen', password: 'kitchen123', full_name: 'ครัว',          role: 'kitchen',     store_id: 1, allowed_store_ids: [1] },
];

(async () => {
  const file = path.join(__dirname, '..', '..', 'database', 'seed.sql');
  const sql = fs.readFileSync(file, 'utf8');
  console.log(`Applying seed from ${file}`);
  await db.query(sql);

  const isProd = process.env.NODE_ENV === 'production';
  const allowInsecure = process.env.ALLOW_INSECURE_SEED === '1';

  if (isProd && !allowInsecure) {
    console.log('\n⚠️  NODE_ENV=production — refusing to insert dev users with default passwords.');
    console.log('    Create your admin manually:');
    console.log('      node scripts/create-admin.js <username> <password> [full_name]');
    console.log('    Or set ALLOW_INSECURE_SEED=1 to override (NOT RECOMMENDED — rotate passwords immediately).');
  } else {
    if (isProd) console.log('\n⚠️  ALLOW_INSECURE_SEED=1 — inserting dev users in PRODUCTION. Change these now!');
    console.log(`Creating dev users (bcrypt cost ${BCRYPT_COST})...`);
    for (const u of DEV_USERS) {
      const hash = await bcrypt.hash(u.password, BCRYPT_COST);
      await db.query(
        `INSERT INTO users (username, password_hash, full_name, role, store_id, allowed_store_ids)
         VALUES ($1, $2, $3, $4, $5, $6::int[])
         ON CONFLICT (username) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           full_name = EXCLUDED.full_name,
           role = EXCLUDED.role,
           store_id = EXCLUDED.store_id,
           allowed_store_ids = EXCLUDED.allowed_store_ids`,
        [u.username, hash, u.full_name, u.role, u.store_id, u.allowed_store_ids]
      );
      console.log(`  - ${u.username} / ${u.password}  (role=${u.role})`);
    }
  }

  const { rows } = await db.query('SELECT code, qr_token FROM tables ORDER BY code');
  console.log('\nQR tokens for tables (use these in the customer URL):');
  for (const t of rows) {
    console.log(`  ${t.code}: ${t.qr_token}`);
  }
  console.log('\nDone.');
  await db.pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

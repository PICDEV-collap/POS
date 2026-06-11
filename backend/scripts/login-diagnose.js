#!/usr/bin/env node
require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../src/db');

async function main() {
  const storesRes = await fetch('http://127.0.0.1:4000/api/auth/stores');
  console.log('GET /api/auth/stores', storesRes.status);
  if (!storesRes.ok) {
    console.log(await storesRes.text());
  }

  const users = await db.query(
    `SELECT id, username, role, is_active,
            LEFT(password_hash, 20) AS hash_prefix,
            COALESCE(allowed_store_ids, ARRAY[COALESCE(store_id, 1)]::int[]) AS allowed_store_ids
       FROM users
      ORDER BY id`
  );
  console.log('\nusers:', users.rows);

  const locks = await db.query(
    `SELECT username, failed_count, locked_until
       FROM login_attempts
      ORDER BY username`
  );
  console.log('\nlogin_attempts:', locks.rows);

  const testPasswords = ['admin123', 'staff123', 'kitchen123'];
  for (const user of users.rows) {
    if (!user.is_active) continue;
    const full = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    const hash = full.rows[0]?.password_hash;
    const matches = [];
    for (const pw of testPasswords) {
      if (hash && (await bcrypt.compare(pw, hash))) matches.push(pw);
    }
    console.log(`\n${user.username}: dev-password-match=${matches.length ? matches.join(',') : 'none'}`);
  }

  const probeUser = process.env.LOGIN_PROBE_USER;
  const probePass = process.env.LOGIN_PROBE_PASS;
  if (probeUser && probePass) {
    const loginRes = await fetch('http://127.0.0.1:4000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: probeUser, password: probePass, store_id: 1 }),
    });
    const loginBody = await loginRes.json().catch(() => ({}));
    console.log(`\nPOST login ${probeUser} store=1:`, loginRes.status, loginBody);
  } else {
    console.log('\n(skip login probe — set LOGIN_PROBE_USER + LOGIN_PROBE_PASS to test)');
  }
}

main()
  .catch((e) => {
    console.error('DIAG FAIL:', e.message);
    process.exit(1);
  })
  .finally(() => db.pool.end());

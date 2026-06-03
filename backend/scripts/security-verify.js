#!/usr/bin/env node
require('dotenv').config();
const db = require('../src/db');

const BASE = process.env.QA_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4000}`;

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, ok: res.ok, text: await res.text() };
}

async function main() {
  let ok = 0;
  let fail = 0;
  function pass(name) { ok += 1; console.log(`PASS ${name}`); }
  function failMsg(name, detail) { fail += 1; console.error(`FAIL ${name} — ${detail}`); }

  if (process.env.NODE_ENV === 'production') pass('NODE_ENV=production');
  else failMsg('NODE_ENV', `expected production, got ${process.env.NODE_ENV || '(unset)'}`);

  if ((process.env.JWT_EXPIRES_IN || '') === '2h') pass('JWT_EXPIRES_IN=2h');
  else failMsg('JWT_EXPIRES_IN', process.env.JWT_EXPIRES_IN || '(unset)');

  if (String(process.env.STAFF_AUTO_SESSION_DISABLED || '').toLowerCase() === 'true') {
    pass('STAFF_AUTO_SESSION_DISABLED');
  } else failMsg('STAFF_AUTO_SESSION_DISABLED', 'should be true in production');

  const devUsers = await db.query(
    `SELECT username, is_active FROM users WHERE username = ANY($1::text[])`,
    [['staff1', 'kitchen']]
  );
  const activeDev = devUsers.rows.filter((r) => r.is_active);
  if (activeDev.length === 0) pass('dev users deactivated');
  else failMsg('dev users still active', activeDev.map((r) => r.username).join(', '));

  const tables = await db.query(
    `SELECT to_regclass('login_attempts') AS a,
            to_regclass('refresh_tokens') AS b,
            to_regclass('audit_log') AS c`
  );
  const t = tables.rows[0];
  if (t.a && t.b && t.c) pass('security tables exist');
  else failMsg('security tables', JSON.stringify(t));

  const health = await get('/api/health');
  if (health.ok) pass('backend health');
  else failMsg('backend health', health.status);

  console.log(`\nSecurity verify: ${ok} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Apply pending SQL files in `database/migrations/` to the configured DB.
// Each migration runs once — its filename is recorded in a `_migrations`
// table so we know not to re-apply it. Files are sorted lexicographically,
// so prefix them like `001_*.sql`, `002_*.sql`, ...
//
//   npm run db:migrate
//
// Idempotent: safe to re-run; only new files are applied.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'database', 'migrations');

(async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = new Set(
    (await db.query('SELECT filename FROM _migrations')).rows.map((r) => r.filename)
  );

  let files = [];
  try {
    files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (e) {
    if (e.code === 'ENOENT') { console.log('No migrations folder.'); process.exit(0); }
    throw e;
  }

  let n = 0;
  for (const f of files) {
    if (applied.has(f)) { console.log(`✓ ${f} (already applied)`); continue; }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    console.log(`→ applying ${f}`);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`✓ ${f}`);
      n++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`✗ ${f} failed:`, e.message);
      process.exit(1);
    } finally {
      client.release();
    }
  }
  console.log(`Done — ${n} migration(s) applied.`);
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });

require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const p = new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  });
  try {
    const settings = await p.query(`
      SELECT name, setting, unit, source, pending_restart
      FROM pg_settings
      WHERE name IN ('max_connections', 'superuser_reserved_connections', 'shared_buffers')
      ORDER BY name
    `);
    console.log('settings:', JSON.stringify(settings.rows, null, 2));

    const usage = await p.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE state = 'active')::int AS active,
        count(*) FILTER (WHERE application_name LIKE '%pos%')::int AS pos_named
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
    `);
    console.log('usage:', usage.rows[0]);

    const byApp = await p.query(`
      SELECT application_name, state, count(*)::int AS n
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
      GROUP BY application_name, state
      ORDER BY n DESC
    `);
    console.log('by_app:', JSON.stringify(byApp.rows, null, 2));

    const conf = await p.query(`SHOW config_file`);
    console.log('config_file:', conf.rows[0].config_file);
  } finally {
    await p.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

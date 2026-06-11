require('dotenv').config();
const db = require('../src/db');

(async () => {
  const { rows } = await db.query(
    `SELECT username, role, is_active FROM users
     WHERE username IN ('admin', 'staff1', 'kitchen')
     ORDER BY username`,
  );
  console.table(rows);
  await db.pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

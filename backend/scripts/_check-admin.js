require('dotenv').config();
const db = require('../src/db');
(async () => {
  const { rows } = await db.query(
    `SELECT id, username, full_name, role, is_active, store_id, allowed_store_ids
       FROM users WHERE username = 'admin'`
  );
  console.log(JSON.stringify(rows[0] || null, null, 2));
  await db.pool.end();
})();

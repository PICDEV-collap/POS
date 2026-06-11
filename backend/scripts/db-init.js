// Apply database/schema.sql to the configured database.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

(async () => {
  const file = path.join(__dirname, '..', '..', 'database', 'schema.sql');
  const sql = fs.readFileSync(file, 'utf8');
  console.log(`Applying schema from ${file}`);
  await db.query(sql);
  console.log('Schema applied.');
  await db.pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

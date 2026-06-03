// Create or update a server admin or mobile store admin user.
// Usage:
//   node scripts/create-admin.js <username> <password> [full_name]
//   node scripts/create-admin.js branch2_admin "<password>" "Branch 2 Admin" --role admin --store-id 2 --allowed-store-ids 2 --mobile-admin
//
// In production this is the recommended way to bootstrap your first admin
// (instead of running db:seed which inserts well-known dev passwords).
require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../src/db');

const BCRYPT_COST = parseInt(process.env.BCRYPT_COST, 10) || 12;
const VALID_ROLES = new Set(['super_admin', 'admin', 'staff', 'kitchen']);

function parseArgs(argv) {
  const positional = [];
  const opts = {
    role: 'super_admin',
    storeId: 1,
    allowedStoreIds: null,
    permissions: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--role') {
      opts.role = String(argv[++i] || '').trim();
    } else if (arg === '--store-id') {
      opts.storeId = Number(argv[++i]);
    } else if (arg === '--allowed-store-ids') {
      opts.allowedStoreIds = String(argv[++i] || '')
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    } else if (arg === '--mobile-admin') {
      opts.permissions.push('mobile_admin', 'store_admin');
    } else if (arg === '--permission') {
      const permission = String(argv[++i] || '').trim();
      if (permission) opts.permissions.push(permission);
    } else {
      positional.push(arg);
    }
  }

  opts.permissions = [...new Set(opts.permissions)];
  if (!opts.allowedStoreIds || opts.allowedStoreIds.length === 0) {
    opts.allowedStoreIds = [opts.storeId];
  }
  return { positional, opts };
}

(async () => {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [username, password, ...rest] = positional;
  const fullName = rest.join(' ').trim() || username;

  if (!username || !password) {
    console.error('Usage: node scripts/create-admin.js <username> <password> [full_name] [--role super_admin|admin|staff|kitchen] [--store-id N] [--allowed-store-ids N[,N]] [--mobile-admin]');
    process.exit(2);
  }
  if (password.length < 10) {
    console.error('Password too short — use ≥10 characters.');
    process.exit(2);
  }
  if (!VALID_ROLES.has(opts.role)) {
    console.error(`Invalid role: ${opts.role}`);
    process.exit(2);
  }
  if (!Number.isInteger(opts.storeId) || opts.storeId <= 0) {
    console.error('Invalid --store-id; use a positive integer.');
    process.exit(2);
  }
  if (opts.role !== 'admin' && opts.permissions.includes('mobile_admin')) {
    console.error('--mobile-admin is only valid with --role admin.');
    process.exit(2);
  }

  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, full_name, role, store_id, allowed_store_ids, permissions)
     VALUES ($1, $2, $3, $4, $5, $6::int[], $7::jsonb)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           full_name     = EXCLUDED.full_name,
           role          = EXCLUDED.role,
           store_id      = EXCLUDED.store_id,
           allowed_store_ids = EXCLUDED.allowed_store_ids,
           permissions   = EXCLUDED.permissions,
           is_active     = true
     RETURNING id, username, role, store_id, allowed_store_ids, permissions`,
    [
      username,
      hash,
      fullName,
      opts.role,
      opts.storeId,
      opts.allowedStoreIds,
      JSON.stringify(opts.permissions),
    ]
  );
  console.log(`✓ user ready: ${JSON.stringify(rows[0])}`);
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });

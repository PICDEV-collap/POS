// Generate fresh secrets for production deploy.
// Prints to stdout — pipe into .env or copy manually.
//
//   node scripts/rotate-secrets.js
//   node scripts/rotate-secrets.js > .env.new
//
// What gets generated:
//   JWT_SECRET           — 64-byte hex (used to sign auth tokens)
//   VAPID_PUBLIC_KEY     \  used for Web Push notifications
//   VAPID_PRIVATE_KEY    /
//   PGPASSWORD_SUGGEST   — strong DB password you can apply with:
//                          ALTER USER postgres WITH PASSWORD '...';
//   ADMIN_PASSWORD_SUGGEST — initial admin password to use with create-admin.js

const crypto = require('crypto');
const webpush = require('web-push');

function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }
function strongPassword(len = 24) {
  // Letters + digits + symbols, but no characters that need shell escaping
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

const jwt = randomHex(64);
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
const dbPwd = strongPassword(24);
const adminPwd = strongPassword(20);

console.log('# === POS_V2 secrets — generated ' + new Date().toISOString() + ' ===');
console.log('# Copy each value into backend/.env, then RESTART the service.');
console.log('# IMPORTANT: do NOT commit .env to git. Keep these in a secret manager.');
console.log('');
console.log('JWT_SECRET=' + jwt);
console.log('JWT_EXPIRES_IN=2h          # short-lived (was 12h)');
console.log('');
console.log('VAPID_SUBJECT=mailto:admin@your-domain.example');
console.log('VAPID_PUBLIC_KEY=' + publicKey);
console.log('VAPID_PRIVATE_KEY=' + privateKey);
console.log('');
console.log('# --- one-time bootstrap (DO NOT keep these in .env) ---');
console.log('# 1. Apply this Postgres password:');
console.log('#       psql -U postgres -c "ALTER USER postgres WITH PASSWORD \'' + dbPwd + '\';"');
console.log('#    Then in .env:');
console.log('PGPASSWORD=' + dbPwd);
console.log('');
console.log('# 2. Create your admin user:');
console.log('#       node scripts/create-admin.js admin "' + adminPwd + '" "Administrator"');
console.log('#    (Password above is just a suggestion — pick your own if you prefer.)');
console.log('');
console.log('# 3. NODE_ENV=production    (already required for production hardening)');
console.log('# 4. LISTEN_HOST=127.0.0.1  (block direct external access; use Caddy in front)');

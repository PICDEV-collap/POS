// Web Push (VAPID) — sends notifications to subscribed clients (kitchen tablets etc.)
// Subscriptions persisted in `push_subscriptions` table.

const webpush = require('web-push');
const db = require('./db');

let _configured = false;

function configure() {
  let subject = process.env.VAPID_SUBJECT || 'mailto:admin@pos-v2.local';
  // Auto-wrap bare email in mailto: (web-push requires URL-formatted subject)
  if (subject && !subject.startsWith('mailto:') && !subject.startsWith('http')) {
    if (subject.includes('@')) subject = 'mailto:' + subject;
  }
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    console.warn('[push] VAPID keys not set — Web Push disabled');
    _configured = false;
    return false;
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
    _configured = true;
    return true;
  } catch (e) {
    console.warn('[push] VAPID config failed:', e.message);
    _configured = false;
    return false;
  }
}

function isConfigured() { return _configured; }
function publicKey() { return process.env.VAPID_PUBLIC_KEY || null; }

async function saveSubscription({ subscription, userId, scope = 'kitchen' }) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    const e = new Error('invalid subscription'); e.status = 400; throw e;
  }
  const { rows } = await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, scope, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh  = EXCLUDED.p256dh,
           auth    = EXCLUDED.auth,
           scope   = EXCLUDED.scope,
           last_seen_at = NOW()
     RETURNING id, scope`,
    [userId || null, endpoint, keys.p256dh, keys.auth, scope]
  );
  return rows[0];
}

async function deleteSubscription(endpoint) {
  await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

async function broadcastToScope(scope, payloadObj) {
  if (!_configured) return { sent: 0, skipped: true, reason: 'not configured' };
  const params = [scope];
  const where = scope === 'all' ? '' : 'WHERE scope = $1 OR scope = \'all\'';
  const { rows } = await db.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions ${where}`,
    scope === 'all' ? [] : params
  );
  const payload = JSON.stringify(payloadObj);
  let sent = 0, removed = 0;
  await Promise.all(rows.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 }
      );
      sent++;
    } catch (e) {
      // 404/410: subscription gone — remove
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => {});
        removed++;
      } else {
        console.warn('[push] send failed', e.statusCode, e.body || e.message);
      }
    }
  }));
  return { sent, removed, total: rows.length };
}

module.exports = {
  configure, isConfigured, publicKey,
  saveSubscription, deleteSubscription, broadcastToScope,
};

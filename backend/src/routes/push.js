const express = require('express');
const { authRequired } = require('../middleware/auth');
const push = require('../push');

const router = express.Router();

// Public-ish: clients need this to subscribe via PushManager.subscribe()
router.get('/vapid-public-key', (_req, res) => {
  const k = push.publicKey();
  if (!k) return res.status(503).json({ error: 'web push not configured' });
  res.json({ key: k });
});

router.post('/subscribe', authRequired, async (req, res) => {
  const { subscription, scope } = req.body || {};
  const saved = await push.saveSubscription({
    subscription,
    userId: req.user.sub,
    scope: scope || 'kitchen',
  });
  res.status(201).json(saved);
});

router.post('/unsubscribe', authRequired, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  await push.deleteSubscription(endpoint);
  res.status(204).end();
});

router.post('/test', authRequired, async (req, res) => {
  const r = await push.broadcastToScope(req.body?.scope || 'kitchen', {
    title: 'POS V2',
    body: req.body?.body || 'ทดสอบการแจ้งเตือน',
    tag: 'test',
  });
  res.json(r);
});

module.exports = router;

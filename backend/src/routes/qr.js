const express = require('express');
const QRCode = require('qrcode');

const router = express.Router();

// GET /api/qr?text=<encoded>&size=300
// Returns a PNG. Cached for 1 day.
router.get('/', async (req, res) => {
  const text = String(req.query.text || '');
  if (!text) return res.status(400).json({ error: 'text required' });
  const size = Math.max(100, Math.min(800, parseInt(req.query.size, 10) || 300));
  try {
    const buf = await QRCode.toBuffer(text, {
      width: size, margin: 2, errorCorrectionLevel: 'M', type: 'png',
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

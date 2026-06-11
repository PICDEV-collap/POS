const express = require('express');
const discovery = require('../discovery');

const router = express.Router();

// Public — clients can hit this if they know the host (HTTP-only fallback for
// mDNS-restricted environments like web browsers).
router.get('/info', (req, res) => {
  const port = req.app.get('port') || parseInt(process.env.PORT, 10) || 4000;
  res.json(discovery.info(port));
});

module.exports = router;

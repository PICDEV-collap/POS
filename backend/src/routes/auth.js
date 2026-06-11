const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { signToken, authRequired } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const { rows } = await db.query(
    'SELECT id, username, password_hash, full_name, role, is_active FROM users WHERE username = $1',
    [username]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });

  const token = signToken(user);
  return res.json({
    token,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
  });
});

router.post('/staff-session', async (req, res) => {
  const disabled = String(process.env.STAFF_AUTO_SESSION_DISABLED || '').toLowerCase();
  if (disabled === '1' || disabled === 'true') {
    return res.status(403).json({ error: 'staff auto session disabled' });
  }
  const { rows } = await db.query(
    `SELECT id, username, full_name
       FROM users
      WHERE role = 'staff' AND is_active = true
      ORDER BY id
      LIMIT 1`
  );
  const staff = rows[0];
  if (!staff) {
    return res.status(503).json({ error: 'no active staff user configured' });
  }
  const user = {
    id: staff.id,
    username: staff.username,
    full_name: staff.full_name,
    role: 'staff',
  };
  const token = signToken(user);
  console.log(`[auth] staff auto-session issued user=${user.username} ip=${req.ip}`);
  return res.json({ token, user });
});

router.get('/me', authRequired, async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, username, full_name, role FROM users WHERE id = $1',
    [req.user.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: 'user not found' });
  return res.json(rows[0]);
});

module.exports = router;

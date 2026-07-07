require('dotenv').config();
require('express-async-errors');
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

const { initSocket } = require('./socket');
const authRoutes = require('./routes/auth');
const tableRoutes = require('./routes/tables');
const categoryRoutes = require('./routes/categories');
const productRoutes = require('./routes/products');
const { router: orderRoutes } = require('./routes/orders');
const publicRoutes = require('./routes/public');
const printRoutes = require('./routes/print');
const qrRoutes = require('./routes/qr');
const printer = require('./printer');
const discovery = require('./discovery');
const discoveryRoutes = require('./routes/discovery');
const push = require('./push');
const pushRoutes = require('./routes/push');
const settingsRoutes = require('./routes/settings');
const paymentRoutes = require('./routes/payments');
const accountingRoutes = require('./routes/accounting');
const storeRoutes = require('./routes/stores');
const userRoutes = require('./routes/users');

const app = express();
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Behind a reverse proxy (Caddy/nginx) — trust X-Forwarded-* so rate limiter
// sees the real client IP and req.protocol == 'https'.
app.set('trust proxy', 1);

// Security headers (CSP relaxed for image upload + same-origin uploads)
app.use(helmet({
  contentSecurityPolicy: false,           // backend serves only API + images, CSP set by web proxy
  crossOriginResourcePolicy: { policy: 'cross-origin' },  // allow /uploads from web origin
}));

// Reflecting an arbitrary origin together with credentials is unsafe. Only
// allow credentials when an explicit allowlist is configured; the no-allowlist
// fallback reflects the origin but drops credentials. Auth uses Bearer tokens
// (no cookies), so this fallback does not affect normal operation.
app.use(cors(corsOrigins.length
  ? { origin: corsOrigins, credentials: true }
  : { origin: true, credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Rate limit: login (very strict) — blunts brute force
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,    // 10 minutes
  max: 10,                      // 10 attempts per IP per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many login attempts; try again later' },
});

// Rate limit: customer order placement (prevent table-spam abuse)
const publicOrderLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minute
  max: parseInt(process.env.PUBLIC_ORDER_RATE_LIMIT_MAX, 10) || 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = typeof req.body?.token === 'string'
      ? req.body.token.slice(0, 64)
      : 'no-table-token';
    return `${ipKeyGenerator(req.ip)}:${token}`;
  },
  handler: (req, res) => {
    const token = typeof req.body?.token === 'string'
      ? req.body.token.slice(0, 8)
      : 'none';
    console.warn(`[rate-limit] public order blocked ip=${req.ip} token=${token}`);
    res.status(429).json({ error: 'too many order requests; wait a moment and try again' });
  },
});

// Rate limit: customer "call staff / request bill" (prevent button-spam)
const publicCallLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = typeof req.body?.token === 'string'
      ? req.body.token.slice(0, 64)
      : 'no-table-token';
    return `${ipKeyGenerator(req.ip)}:${token}`;
  },
  message: { error: 'เรียกพนักงานถี่เกินไป กรุณารอสักครู่' },
});

// Generic API rate limit
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,                     // 10 req/sec/IP — wide for staff workflows
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Static serve product images. Cache for 7 days.
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), {
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

// Targeted limits on sensitive endpoints — must come BEFORE the route handler.
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/refresh', loginLimiter);
app.post('/api/public/orders', publicOrderLimiter);
app.post('/api/public/call-staff', publicCallLimiter);
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/tables', tableRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/print', printRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/discovery', discoveryRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/settings', settingsRoutes.router);
app.use('/api/payments', paymentRoutes.router);
app.use('/api/accounting', accountingRoutes.router);
app.use('/api/stores', storeRoutes);
app.use('/api/users', userRoutes);

// Centralized error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.status) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: 'internal error' });
});

const server = http.createServer(app);
initSocket(server, corsOrigins.length ? corsOrigins : '*');

const port = parseInt(process.env.PORT, 10) || 4000;
// Default bind: 0.0.0.0 in dev (so Android emulator + LAN can hit it),
// 127.0.0.1 in production (assume Caddy/nginx fronts the public address).
const defaultHost = process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0';
const listenHost = process.env.LISTEN_HOST || defaultHost;
app.set('port', port);
server.listen(port, listenHost, async () => {
  console.log(`POS_V2 backend listening on ${listenHost}:${port}`);
  if (listenHost === '127.0.0.1') console.log('  (loopback only — front with HTTPS reverse proxy)');
  console.log(`  Local IPs: ${discovery.localIPv4Addresses().join(', ') || '(none)'}`);
  // Print queue: recover orphan jobs from previous crash, start worker
  try {
    await printer.recoverOrphanJobs();
    printer.startWorker();
  } catch (e) {
    console.error('[printer] failed to start worker:', e.message);
  }
  // mDNS / Bonjour broadcast
  if ((process.env.BONJOUR_ENABLED || 'true').toLowerCase() !== 'false') {
    discovery.advertise(port);
  }
  // Web Push (VAPID)
  push.configure();
});

function shutdown() {
  console.log('\nshutting down...');
  printer.stopWorker();
  discovery.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

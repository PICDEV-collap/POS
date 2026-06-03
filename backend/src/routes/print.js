const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { loadOrder, queueKitchenStationPrints } = require('./orders');
const { loadSettings } = require('./settings');
const { parseStoreIds } = require('../lib/storeScope');
const printer = require('../printer');
const bitmap = require('../printer-bitmap');
const tspl = require('../printer-tspl');

const router = express.Router();
const MOBILE_PRINT_CLAIM_TTL = "15 minutes";

function normalizeStationKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{2,32}$/.test(key) ? key : null;
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  const picked = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, picked));
}

function canPrintReceipt(req) {
  return ['admin', 'staff', 'super_admin'].includes(req.user?.role);
}

function enforceReceiptPrintRole(req, res, type) {
  if (type !== 'receipt' || canPrintReceipt(req)) return true;
  res.status(403).json({ error: 'receipt printing requires staff/admin' });
  return false;
}

function orderStoreId(order) {
  const n = Number(order?.store_id || 1);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function canAccessOrderStore(req, order) {
  if (req.user?.role === 'super_admin') return true;
  const storeId = orderStoreId(order);
  const allowed = parseStoreIds(req.user?.allowed_store_ids);
  const fallback = Number(req.user?.store_id || 1);
  const effectiveAllowed = allowed.length
    ? allowed
    : [Number.isInteger(fallback) && fallback > 0 ? fallback : 1];
  return effectiveAllowed.includes(storeId);
}

function enforceOrderStoreAccess(req, res, order) {
  if (canAccessOrderStore(req, order)) return true;
  res.status(403).json({ error: 'store access forbidden' });
  return false;
}

async function loadOrderSettings(order) {
  return loadSettings(orderStoreId(order));
}

function stationPayload(body = {}, key) {
  const host = body.printer_host === '' ? null : body.printer_host ?? null;
  const port = body.printer_port === '' || body.printer_port == null ? null : parseInt(body.printer_port, 10);
  return {
    key,
    name: String(body.name || key).trim().slice(0, 128),
    station_type: ['kitchen', 'drink', 'snack', 'receipt', 'custom'].includes(body.station_type)
      ? body.station_type
      : 'custom',
    printer_key: body.printer_key ? String(body.printer_key).trim().slice(0, 128) : null,
    printer_host: host ? String(host).trim() : null,
    printer_port: Number.isFinite(port) ? port : null,
    width_chars: clampInt(body.width_chars, 42, 16, 80),
    thai_cp: clampInt(body.thai_cp, 21, 0, 255),
    render_mode: body.render_mode === 'image' ? 'image' : 'text',
    paper_width_mm: clampInt(body.paper_width_mm, 58, 30, 120),
    paper_height_mm: clampInt(body.paper_height_mm, 0, 0, 1000),
    paper_gap_mm: clampInt(body.paper_gap_mm, 0, 0, 60),
    width_px: clampInt(body.width_px, 384, 128, 832),
    feed_lines: clampInt(body.feed_lines, 6, 0, 24),
    bottom_feed_px: clampInt(body.bottom_feed_px, 160, 0, 1200),
    raster_band_height: clampInt(body.raster_band_height, 128, 64, 256),
    cut_mode: ['none', 'partial', 'full'].includes(body.cut_mode) ? body.cut_mode : 'partial',
    is_active: body.is_active !== false,
    sort_order: parseInt(body.sort_order, 10) || 0,
  };
}

async function loadStation(key) {
  const { rows } = await db.query(
    `SELECT key, name, station_type, printer_key, printer_host, printer_port,
            width_chars, thai_cp, render_mode,
            paper_width_mm, paper_height_mm, paper_gap_mm, width_px,
            feed_lines, bottom_feed_px, raster_band_height, cut_mode,
            is_active, sort_order
       FROM print_stations
      WHERE key = $1`,
    [key]
  );
  return rows[0] || null;
}

router.get('/config', authRequired, async (_req, res) => {
  const cfg = printer.printerConfig();
  const status = await printer.getPrinterStatus();
  let stations = [];
  try {
    const { rows } = await db.query(
      `SELECT key, name, station_type, printer_key, printer_host, printer_port,
              width_chars, thai_cp, render_mode,
              paper_width_mm, paper_height_mm, paper_gap_mm, width_px,
              feed_lines, bottom_feed_px, raster_band_height, cut_mode,
              is_active, sort_order
         FROM print_stations
        ORDER BY sort_order, key`
    );
    stations = rows;
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }
  res.json({
    enabled: cfg.enabled,
    transport: cfg.transport,
    host: cfg.host,
    port: cfg.port,
    windows_printer_name: cfg.windowsPrinterName,
    printer_key: cfg.printerKey,
    timeout_ms: cfg.timeout,
    thai_cp: cfg.thaiCp,
    width: cfg.width,
    poll_interval_ms: cfg.pollIntervalMs,
    backoff_base_sec: cfg.backoffBaseSec,
    backoff_max_sec: cfg.backoffMaxSec,
    max_attempts: cfg.maxAttempts,
    health_poll_ms: cfg.healthPollMs,
    render_mode: cfg.renderMode,
    width_px: cfg.widthPx,
    feed_lines: cfg.feedLines,
    bottom_feed_px: cfg.bottomFeedPx,
    raster_band_height: cfg.rasterBandHeight,
    paper_width_mm: cfg.paperWidthMm,
    paper_height_mm: cfg.paperHeightMm,
    paper_gap_mm: cfg.paperGapMm,
    cut_mode: cfg.cutMode,
    font_path: cfg.fontPath,
    status,
    stations,
  });
});

router.get('/windows-printers', authRequired, requireRole('admin', 'staff'), async (_req, res) => {
  try {
    res.json(await printer.listWindowsPrinters());
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code || 'WINDOWS_PRINTER_LIST_FAILED' });
  }
});

router.get('/stations', authRequired, requireRole('admin', 'staff'), async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ps.*,
              COALESCE(pst.status, 'unknown') AS health_status,
              pst.last_error_code,
              pst.last_latency_ms,
              pst.updated_at AS health_updated_at
         FROM print_stations ps
         LEFT JOIN printer_status pst
           ON pst.printer_key = COALESCE(ps.printer_key, 'station:' || ps.key)
        ORDER BY ps.sort_order, ps.key`
    );
    res.json(rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    throw e;
  }
});

router.put('/stations/:key', authRequired, requireRole('admin'), async (req, res) => {
  const key = normalizeStationKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'invalid station key' });
  const p = stationPayload(req.body || {}, key);
  const { rows } = await db.query(
    `INSERT INTO print_stations
       (key, name, station_type, printer_key, printer_host, printer_port,
        width_chars, thai_cp, render_mode,
        paper_width_mm, paper_height_mm, paper_gap_mm, width_px,
        feed_lines, bottom_feed_px, raster_band_height, cut_mode,
        is_active, sort_order, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
     ON CONFLICT (key) DO UPDATE SET
       name = EXCLUDED.name,
       station_type = EXCLUDED.station_type,
       printer_key = EXCLUDED.printer_key,
       printer_host = EXCLUDED.printer_host,
       printer_port = EXCLUDED.printer_port,
       width_chars = EXCLUDED.width_chars,
       thai_cp = EXCLUDED.thai_cp,
       render_mode = EXCLUDED.render_mode,
       paper_width_mm = EXCLUDED.paper_width_mm,
       paper_height_mm = EXCLUDED.paper_height_mm,
       paper_gap_mm = EXCLUDED.paper_gap_mm,
       width_px = EXCLUDED.width_px,
       feed_lines = EXCLUDED.feed_lines,
       bottom_feed_px = EXCLUDED.bottom_feed_px,
       raster_band_height = EXCLUDED.raster_band_height,
       cut_mode = EXCLUDED.cut_mode,
       is_active = EXCLUDED.is_active,
       sort_order = EXCLUDED.sort_order,
       updated_at = NOW()
     RETURNING *`,
    [p.key, p.name, p.station_type, p.printer_key, p.printer_host, p.printer_port,
     p.width_chars, p.thai_cp, p.render_mode,
     p.paper_width_mm, p.paper_height_mm, p.paper_gap_mm, p.width_px,
     p.feed_lines, p.bottom_feed_px, p.raster_band_height, p.cut_mode,
     p.is_active, p.sort_order]
  );
  res.json(rows[0]);
});

router.post('/stations/:key/test', authRequired, requireRole('admin', 'staff'), async (req, res) => {
  const key = normalizeStationKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'invalid station key' });
  const station = await loadStation(key);
  if (!station) return res.status(404).json({ error: 'station not found' });
  const job = await printer.queueTest({
    createdBy: req.user.sub,
    force: req.query.force === '1' || req.body?.force === true,
    printerOverride: station,
  });
  res.status(202).json({ queued: true, station_key: key, ...job });
});

router.post('/stations/:key/health/check', authRequired, requireRole('admin', 'staff'), async (req, res) => {
  const key = normalizeStationKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'invalid station key' });
  const station = await loadStation(key);
  if (!station) return res.status(404).json({ error: 'station not found' });
  res.json(await printer.runHealthCheck(station));
});

router.get('/health', authRequired, async (_req, res) => {
  res.json(await printer.getPrinterStatus());
});

router.post('/health/check', authRequired, requireRole('admin', 'staff'), async (_req, res) => {
  res.json(await printer.runHealthCheck());
});

router.post('/mobile-claim', authRequired, requireRole('admin', 'staff', 'kitchen'), async (req, res) => {
  const orderId = parseInt(req.body?.order_id, 10);
  const type = String(req.body?.type || '').toLowerCase();
  if (!orderId || !['kitchen', 'receipt'].includes(type)) {
    return res.status(400).json({ error: 'order_id and type required' });
  }
  if (!enforceReceiptPrintRole(req, res, type)) return;
  const order = await loadOrder(orderId);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (!enforceOrderStoreAccess(req, res, order)) return;

  const client = await require('../db').getClient();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id, status, expires_at
         FROM mobile_print_claims
        WHERE order_id = $1 AND type = $2
        FOR UPDATE`,
      [orderId, type]
    );
    const row = existing.rows[0];
    if (!row) {
      const inserted = await client.query(
        `INSERT INTO mobile_print_claims
           (order_id, type, claimed_by, status, claimed_at, expires_at, updated_at)
         VALUES ($1, $2, $3, 'claimed', NOW(), NOW() + INTERVAL '${MOBILE_PRINT_CLAIM_TTL}', NOW())
         RETURNING id, status, expires_at`,
        [orderId, type, req.user.sub || null]
      );
      await client.query('COMMIT');
      return res.status(201).json({ claimed: true, ...inserted.rows[0] });
    }
    if (row.status === 'success') {
      await client.query('COMMIT');
      return res.json({ claimed: false, reason: 'already_printed', ...row });
    }
    const expired = new Date(row.expires_at).getTime() <= Date.now();
    if (expired || row.status === 'failed' || row.status === 'expired') {
      const updated = await client.query(
        `UPDATE mobile_print_claims
            SET status = 'claimed',
                claimed_by = $2,
                claimed_at = NOW(),
                expires_at = NOW() + INTERVAL '${MOBILE_PRINT_CLAIM_TTL}',
                completed_at = NULL,
                error = NULL,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, status, expires_at`,
        [row.id, req.user.sub || null]
      );
      await client.query('COMMIT');
      return res.json({ claimed: true, ...updated.rows[0] });
    }
    await client.query('COMMIT');
    return res.json({ claimed: false, reason: 'claimed_elsewhere', ...row });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '42P01') return res.status(503).json({ error: 'mobile print claim migration required' });
    throw e;
  } finally {
    client.release();
  }
});

router.post('/mobile-claim/:id/complete', authRequired, requireRole('admin', 'staff', 'kitchen'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ok = req.body?.ok === true;
  const error = req.body?.error ? String(req.body.error).slice(0, 500) : null;
  if (!id) return res.status(400).json({ error: 'claim id required' });
  const { rows } = await require('../db').query(
    `UPDATE mobile_print_claims
        SET status = $2::varchar,
            completed_at = CASE WHEN $2::varchar = 'success' THEN NOW() ELSE completed_at END,
            error = $3,
            updated_at = NOW()
      WHERE id = $1 AND status = 'claimed'
      RETURNING id, order_id, type, status`,
    [id, ok ? 'success' : 'failed', error]
  );
  if (!rows[0]) return res.status(404).json({ error: 'claim not found or already completed' });
  res.json(rows[0]);
});

// Enqueue a test print
router.post('/test', authRequired, requireRole('admin', 'staff'), async (req, res) => {
  const force = req.query.force === '1' || req.body?.force === true;
  const job = await printer.queueTest({ createdBy: req.user.sub, force });
  res.status(202).json({ queued: true, ...job });
});

// Enqueue a QR-label print so staff can hand a paper QR to customers
// who can't scan from the screen. Body: { url, table_name, table_code,
// store_name, store_logo, note, footer, copies }
router.post('/qr', authRequired, requireRole('admin', 'staff'), async (req, res) => {
  const body = req.body || {};
  const url = String(body.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'url (http/https) required' });
  }
  const copies = Math.max(1, Math.min(8, parseInt(body.copies, 10) || 1));
  const force = req.query.force === '1' || body.force === true;
  const opts = {
    url,
    tableName: String(body.table_name || body.tableName || '').slice(0, 80),
    tableCode: String(body.table_code || body.tableCode || '').slice(0, 40),
    storeName: String(body.store_name || body.storeName || '').slice(0, 80),
    storeLogo: String(body.store_logo || body.storeLogo || '').slice(0, 8),
    note: String(body.note || 'สแกน QR เพื่อสั่งอาหาร').slice(0, 80),
    footer: String(body.footer || 'ขอบคุณที่ใช้บริการ').slice(0, 80),
    qrSize: Math.max(3, Math.min(8, parseInt(body.qr_size, 10) || 8)),
  };
  const jobs = [];
  for (let i = 0; i < copies; i += 1) {
    // Each copy is queued separately so they print sequentially and a
    // single failure doesn't block the rest.
    const job = await printer.queueQrLabel(opts, { createdBy: req.user.sub, force: force || i > 0 });
    jobs.push(job);
  }
  res.status(202).json({ queued: true, copies, jobs, ...(jobs[0] || {}) });
});

// Enqueue a barcode-label print for a product. Optional ?station_key=
// or body.station_key selects a specific thermal printer (otherwise the
// default printer is used). Body: { copies, barcode_height_px }
router.post('/barcode/:productId', authRequired, requireRole('admin', 'staff'), async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ error: 'invalid product id' });
  }
  const storeId = require('../lib/storeScope').resolveStoreId(req);
  const { rows } = await require('../db').query(
    `SELECT id, name, price, barcode, stock_qty
       FROM products WHERE id = $1 AND store_id = $2`,
    [productId, storeId]
  );
  const product = rows[0];
  if (!product) return res.status(404).json({ error: 'not found' });
  if (!product.barcode) return res.status(400).json({ error: 'product has no barcode' });
  const body = req.body || {};
  const copies = Math.max(1, Math.min(8, parseInt(body.copies, 10) || 1));
  const force = req.query.force === '1' || body.force === true;
  const stationKey = normalizeStationKey(req.query.station_key || body.station_key);
  const station = stationKey ? await loadStation(stationKey) : null;
  if (stationKey && !station) return res.status(404).json({ error: 'station not found' });
  const opts = {
    barcode: product.barcode,
    name: product.name,
    price: product.price != null ? Number(product.price) : null,
    stockQty: product.stock_qty != null ? Number(product.stock_qty) : null,
    barcodeHeightPx: Math.max(40, Math.min(140, parseInt(body.barcode_height_px, 10) || 80)),
  };
  const jobs = [];
  for (let i = 0; i < copies; i += 1) {
    const job = await printer.queueBarcodeLabel(opts, {
      createdBy: req.user.sub,
      force: force || i > 0,
      station,
    });
    jobs.push(job);
  }
  res.status(202).json({ queued: true, copies, station_key: stationKey || null, jobs, ...(jobs[0] || {}) });
});

// Enqueue an order print
router.post('/order/:id', authRequired, requireRole('admin', 'staff', 'kitchen'), async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (!enforceOrderStoreAccess(req, res, order)) return;
  const type = (req.query.type || req.body?.type || 'kitchen').toLowerCase();
  if (!['kitchen', 'receipt'].includes(type)) {
    return res.status(400).json({ error: `unknown type "${type}"` });
  }
  if (!enforceReceiptPrintRole(req, res, type)) return;
  const force = req.query.force === '1' || req.body?.force === true;
  const settings = await loadOrderSettings(order);
  const opts = { createdBy: req.user.sub, force };
  let job;
  if (type === 'receipt') {
    job = await printer.queueOrderReceipt(order, {
      ...opts,
      restaurantName: settings.name,
      paymentSettings: settings,
    });
  }
  else if (type === 'kitchen') {
    const stationKey = normalizeStationKey(req.query.station_key || req.body?.station_key);
    if (stationKey) {
      const station = await loadStation(stationKey);
      if (!station) return res.status(404).json({ error: 'station not found' });
      const items = (order.items || []).filter((it) => (it.print_station_key || 'kitchen') === stationKey);
      if (!items.length) return res.status(400).json({ error: 'order has no items for this station' });
      job = await printer.queueOrderKitchen({ ...order, items }, {
        ...opts,
        stationKey,
        stationLabel: station.name,
        printerOverride: station,
      });
    } else {
      job = await queueKitchenStationPrints(order, opts);
    }
  }
  const jobs = Array.isArray(job) ? job : [job];
  res.status(202).json({ queued: true, type, order_id: order.id, jobs, ...(jobs[0] || {}) });
});

// List queue (for admin UI)
router.get('/jobs', authRequired, async (req, res) => {
  const list = await printer.listJobs({
    status: req.query.status,
    limit: parseInt(req.query.limit, 10) || 50,
  });
  res.json(list);
});

router.post('/jobs/:id/retry', authRequired, requireRole('admin'), async (req, res) => {
  const r = await printer.retryJob(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found or not retryable' });
  res.json(r);
});

router.post('/jobs/:id/cancel', authRequired, requireRole('admin', 'staff'), async (req, res) => {
  const r = await printer.cancelJob(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found or already finished' });
  res.json(r);
});

// ─── Payload endpoints (for mobile Bluetooth printers) ───────────────────
// Returns the rendered ESC/POS bytes as base64. Mobile fetches this then
// sends to a Bluetooth-paired printer via print_bluetooth_thermal.

function buildPayload(order, type, cfg) {
  // TSPL = label printers (AYIN, IPRT) — always uses bitmap inside TSPL wrapper
  if (cfg.protocol === 'tspl') {
    return type === 'receipt'
      ? tspl.buildReceiptTSPL(order, cfg)
      : tspl.buildKitchenTSPL(order, cfg);
  }
  // ESC/POS — text or image mode
  if (cfg.renderMode === 'image') {
    return type === 'receipt'
      ? bitmap.buildReceiptBitmap(order, cfg)
      : bitmap.buildKitchenBitmap(order, cfg);
  }
  return type === 'receipt'
    ? printer.buildCustomerReceipt(order, cfg)
    : printer.buildKitchenReceipt(order, cfg);
}

/// Per-request config: respects ?width_px=, ?width_chars=, ?render_mode=,
/// ?protocol=, ?paper_width_mm=, ?paper_height_mm=, ?gap_mm= overrides from
/// the mobile (each phone may have its own printer + label stock).
///
/// When `label_width_mm` is provided we auto-derive widthPx = mm * 8 (203 DPI
/// thermal printers print at 8 dots/mm) so the bitmap matches the actual
/// label exactly. An explicit `width_px=` still wins if both are set.
function cfgFromQuery(req) {
  const cfg = { ...printer.printerConfig() };
  const px = parseInt(req.query.width_px, 10);
  const ch = parseInt(req.query.width_chars, 10);
  const lw = parseInt(req.query.paper_width_mm ?? req.query.label_width_mm, 10);
  const lh = parseInt(req.query.paper_height_mm ?? req.query.label_height_mm, 10);
  const gap = parseInt(req.query.gap_mm, 10);
  const bline = parseInt(req.query.bline_mm, 10);
  const feedLines = parseInt(req.query.feed_lines, 10);
  const bottomFeedPx = parseInt(req.query.bottom_feed_px, 10);
  const rasterBandHeight = parseInt(req.query.raster_band_height, 10);
  if (Number.isFinite(lw) && lw >= 20 && lw <= 200) {
    cfg.labelWidthMm = lw;
    cfg.paperWidthMm = lw;
    cfg.widthPx = lw * 8;
  }
  if (Number.isFinite(lh) && lh >= 0 && lh <= 300) {
    cfg.labelHeightMm = lh;
    cfg.paperHeightMm = lh;
  }
  if (Number.isFinite(gap) && gap >= 0 && gap <= 60) {
    cfg.gapMm = gap;
    cfg.paperGapMm = gap;
  }
  if (Number.isFinite(bline) && bline >= 0 && bline <= 10) cfg.blineMm = bline;
  if (Number.isFinite(px) && px >= 200 && px <= 1600) cfg.widthPx = px;
  if (Number.isFinite(ch) && ch >= 16  && ch <= 80)  cfg.width = ch;
  if (Number.isFinite(feedLines) && feedLines >= 0 && feedLines <= 24) {
    cfg.feedLines = feedLines;
  }
  if (Number.isFinite(bottomFeedPx) && bottomFeedPx >= 0 && bottomFeedPx <= 1200) {
    cfg.bottomFeedPx = bottomFeedPx;
  }
  if (Number.isFinite(rasterBandHeight) && rasterBandHeight >= 64 && rasterBandHeight <= 256) {
    cfg.rasterBandHeight = rasterBandHeight;
  }
  const pt = req.query.paper_type;
  if (pt === 'continuous' || pt === 'gap' || pt === 'bline') {
    cfg.paperType = pt;
  }
  if (req.query.render_mode === 'text' || req.query.render_mode === 'image') {
    cfg.renderMode = req.query.render_mode;
  }
  if (['none', 'partial', 'full'].includes(req.query.cut_mode)) {
    cfg.cutMode = req.query.cut_mode;
  }
  if (req.query.protocol === 'tspl' || req.query.protocol === 'escpos') {
    cfg.protocol = req.query.protocol;
  } else {
    cfg.protocol = cfg.protocol || 'escpos';
  }
  return cfg;
}

router.get('/payload/order/:id', authRequired, requireRole('admin', 'staff', 'kitchen'), async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (!enforceOrderStoreAccess(req, res, order)) return;
  const type = (req.query.type || 'kitchen').toLowerCase();
  if (!['kitchen', 'receipt'].includes(type)) {
    return res.status(400).json({ error: `unknown type "${type}"` });
  }
  if (!enforceReceiptPrintRole(req, res, type)) return;
  const settings = await loadOrderSettings(order);
  const cfg = {
    ...cfgFromQuery(req),
    restaurantName: settings.name,
    paymentSettings: settings,
  };
  const buf = buildPayload(order, type, cfg);
  res.json({
    type, order_id: order.id,
    bytes_base64: buf.toString('base64'),
    bytes_length: buf.length,
    protocol: cfg.protocol || 'escpos',
    render_mode: cfg.renderMode,
    width_px: cfg.widthPx,
    width_chars: cfg.width,
    feed_lines: cfg.feedLines,
    bottom_feed_px: cfg.bottomFeedPx,
    raster_band_height: cfg.rasterBandHeight,
    label_width_mm: cfg.labelWidthMm,
    label_height_mm: cfg.labelHeightMm,
    gap_mm: cfg.gapMm,
    bline_mm: cfg.blineMm,
    paper_type: cfg.paperType,
  });
});

router.get('/payload/test', authRequired, async (req, res) => {
  const cfg = cfgFromQuery(req);
  let buf;
  if (cfg.protocol === 'tspl') {
    buf = tspl.buildTestTSPL(cfg);
  } else if (cfg.renderMode === 'image') {
    buf = bitmap.buildTestBitmap(cfg);
  } else {
    buf = printer.buildTestPayload(cfg);
  }
  res.json({
    type: 'test',
    bytes_base64: buf.toString('base64'),
    bytes_length: buf.length,
    protocol: cfg.protocol,
    render_mode: cfg.renderMode,
    width_px: cfg.widthPx,
    width_chars: cfg.width,
    feed_lines: cfg.feedLines,
    bottom_feed_px: cfg.bottomFeedPx,
    raster_band_height: cfg.rasterBandHeight,
    label_width_mm: cfg.labelWidthMm,
    label_height_mm: cfg.labelHeightMm,
    gap_mm: cfg.gapMm,
    bline_mm: cfg.blineMm,
    paper_type: cfg.paperType,
  });
});

// One-shot calibration payload — feeds paper through sensor to learn the
// gap/black-mark positions. Use after switching paper stock.
router.get('/payload/calibrate', authRequired, requireRole('admin', 'staff', 'kitchen'), async (req, res) => {
  const cfg = cfgFromQuery(req);
  if (cfg.protocol !== 'tspl') {
    return res.status(400).json({ error: 'calibrate is only valid for TSPL printers' });
  }
  const buf = tspl.buildCalibrateTSPL(cfg);
  res.json({
    type: 'calibrate',
    bytes_base64: buf.toString('base64'),
    bytes_length: buf.length,
    paper_type: cfg.paperType,
    label_width_mm: cfg.labelWidthMm,
    label_height_mm: cfg.labelHeightMm,
  });
});

module.exports = router;

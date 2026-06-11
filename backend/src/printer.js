// ESC/POS Thermal Printer driver for A70Pro (and compatible) over TCP/IP.
//
// Public API:
//   queueOrderKitchen(order, opts)    -> { ok, queued, job_id }
//   queueOrderReceipt(order, opts)    -> { ok, queued, job_id }
//   queueTest(opts)                   -> { ok, queued, job_id }
//   startWorker() / stopWorker()      <- lifecycle from server.js
//   wakeWorker()                      <- internal nudge (auto-called on enqueue)
//   recoverOrphanJobs()               <- boot: processing -> retrying
//   listJobs({ status?, limit? })
//   retryJob(id)
//   cancelJob(id)
//   getPrinterStatus()
//   printerConfig()
//
// Persisted in `print_jobs` table. Queue state machine:
// pending -> processing -> success
// pending -> processing -> retrying -> processing -> failed
// pending/retrying/processing -> cancelled

const net = require('net');
const os = require('os');
const { randomUUID } = require('crypto');
const iconv = require('iconv-lite');
const db = require('./db');
const bitmap = require('./printer-bitmap');
const logger = require('./lib/logger');
const { paymentQrMeta } = require('./lib/thaiQrPayment');

// ESC/POS byte helpers
const ESC = 0x1b;
const GS = 0x1d;
const LF = Buffer.from([0x0a]);

const INIT = Buffer.from([ESC, 0x40]);
const CUT_FULL = Buffer.from([GS, 0x56, 0x00]);
const CUT_PARTIAL = Buffer.from([GS, 0x56, 0x01]);
const ALIGN_L = Buffer.from([ESC, 0x61, 0x00]);
const ALIGN_C = Buffer.from([ESC, 0x61, 0x01]);
const BOLD_ON = Buffer.from([ESC, 0x45, 0x01]);
const BOLD_OFF = Buffer.from([ESC, 0x45, 0x00]);
const SIZE_NORMAL = Buffer.from([GS, 0x21, 0x00]);
const SIZE_DOUBLE = Buffer.from([GS, 0x21, 0x11]);
const SIZE_TALL = Buffer.from([GS, 0x21, 0x01]);

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const LEGACY_STATUS = {
  queued: 'pending',
  printing: 'processing',
  printed: 'success',
};

function selectCodePage(n) { return Buffer.from([ESC, 0x74, n & 0xff]); }
function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  const picked = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, picked));
}
function thaiText(str) {
  try { return iconv.encode(String(str ?? ''), 'tis620'); }
  catch { return iconv.encode(String(str ?? ''), 'cp874'); }
}
function line(text = '') { return Buffer.concat([thaiText(text), LF]); }
function rule(width, ch = '-') { return line(ch.repeat(width)); }
function pad(left, right, width) {
  const l = String(left ?? '');
  const r = String(right ?? '');
  const space = Math.max(1, width - l.length - r.length);
  return l + ' '.repeat(space) + r;
}
function feedLines(opts = {}) {
  const configured = Number(opts.feedLines ?? process.env.PRINTER_FEED_LINES);
  const lines = Number.isFinite(configured) ? configured : 4;
  const clamped = Math.max(0, Math.min(24, Math.floor(lines)));
  return clamped > 0 ? Buffer.from([ESC, 0x64, clamped]) : Buffer.alloc(0);
}
function cutCommand(opts = {}, fallback = 'partial') {
  const mode = String(opts.cutMode || opts.cut_mode || fallback || 'partial').toLowerCase();
  if (mode === 'none') return Buffer.alloc(0);
  return mode === 'full' ? CUT_FULL : CUT_PARTIAL;
}
function orderSequence(order) { return order?.daily_seq || order?.id; }
function orderQueueLabel(order) { return `ลำดับที่ ${orderSequence(order)}`; }
function itemFulfillmentType(order, item) {
  return item?.fulfillment_type === 'takeaway' ? 'takeaway' : (order?.order_type === 'takeaway' ? 'takeaway' : 'dine-in');
}
function fulfillmentText(type) { return type === 'takeaway' ? 'กลับบ้าน' : 'ทานที่ร้าน'; }
function fulfillmentSummary(order) {
  const types = new Set((order?.items || []).map((it) => itemFulfillmentType(order, it)));
  if (types.size > 1) return 'mixed';
  return types.has('takeaway') ? 'takeaway' : 'dine-in';
}
function orderModeLabel(order) {
  const summary = order?.fulfillment_summary || fulfillmentSummary(order);
  if (summary === 'mixed') return 'ทานที่ร้าน + กลับบ้าน';
  return fulfillmentText(summary);
}
function orderLocationLabel(order) {
  const summary = order?.fulfillment_summary || fulfillmentSummary(order);
  if (summary === 'mixed') {
    return `${order?.table_name || `Table ${order?.table_id}`} / มีรับกลับบ้าน`;
  }
  if (summary === 'takeaway') {
    return order.customer_name ? `กลับบ้าน: ${order.customer_name}` : 'สั่งกลับบ้าน';
  }
  return order.table_name || `Table ${order.table_id}`;
}
function kitchenSections(order) {
  const indexed = (order?.items || []).map((item, index) => ({
    item,
    index,
    type: itemFulfillmentType(order, item),
  }));
  const hasDineIn = indexed.some((x) => x.type === 'dine-in');
  const hasTakeaway = indexed.some((x) => x.type === 'takeaway');
  if (!hasDineIn || !hasTakeaway) {
    return [{ type: hasTakeaway ? 'takeaway' : 'dine-in', label: fulfillmentText(hasTakeaway ? 'takeaway' : 'dine-in'), items: indexed }];
  }
  return [
    { type: 'dine-in', label: 'ทานที่ร้าน', items: indexed.filter((x) => x.type === 'dine-in') },
    { type: 'takeaway', label: 'กลับบ้าน', items: indexed.filter((x) => x.type === 'takeaway') },
  ];
}

function escposQr(payload, size = 6) {
  const data = Buffer.from(String(payload || ''), 'ascii');
  if (!data.length) return Buffer.alloc(0);
  const model = Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
  const moduleSize = Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.max(3, Math.min(8, size))]);
  const ecLevel = Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]);
  const len = data.length + 3;
  const pL = len & 0xff;
  const pH = (len >> 8) & 0xff;
  const store = Buffer.concat([Buffer.from([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]), data]);
  const print = Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
  return Buffer.concat([model, moduleSize, ecLevel, store, print]);
}

// Receipt builders
function buildKitchenReceipt(order, opts = {}) {
  const W = opts.width || 42;
  const cp = opts.thaiCp ?? 21;
  const stationHeader = opts.stationLabel || opts.station_label || 'KITCHEN';
  const parts = [INIT, selectCodePage(cp)];
  parts.push(ALIGN_C, SIZE_DOUBLE, BOLD_ON, line(`** ${stationHeader} **`), BOLD_OFF, SIZE_NORMAL);
  parts.push(ALIGN_C, SIZE_TALL, BOLD_ON, line(orderQueueLabel(order)), BOLD_OFF, SIZE_NORMAL);
  parts.push(ALIGN_C, SIZE_TALL, BOLD_ON, line(orderLocationLabel(order)), BOLD_OFF, SIZE_NORMAL);
  parts.push(ALIGN_C, BOLD_ON, line(orderModeLabel(order)), BOLD_OFF, ALIGN_L);
  parts.push(ALIGN_L, line(`Order #${order.id}    ${new Date(order.created_at).toLocaleString('th-TH')}`));
  if (order.source) parts.push(line(`source: ${order.source}`));
  parts.push(rule(W));
  for (const section of kitchenSections(order)) {
    parts.push(BOLD_ON, SIZE_TALL, line(`-- ${section.label} --`), BOLD_OFF, SIZE_NORMAL);
    for (const { item: it, index } of section.items) {
      const variantSuffix = it.variant_name ? ` (${it.variant_name})` : '';
      parts.push(BOLD_ON, SIZE_TALL, line(`${index + 1}. ${it.quantity} x ${it.product_name}${variantSuffix}`), BOLD_OFF, SIZE_NORMAL);
      if (Array.isArray(it.options_selected) && it.options_selected.length) {
        parts.push(line(`   > ${it.options_selected.map((o) => o.value).join(' · ')}`));
      }
      if (it.note) parts.push(line(`   *${it.note}`));
    }
  }
  parts.push(rule(W));
  if (order.note) {
    parts.push(BOLD_ON, line(`NOTE: ${order.note}`), BOLD_OFF);
    parts.push(rule(W));
  }
  parts.push(feedLines(opts), cutCommand(opts, 'partial'));
  return Buffer.concat(parts);
}

function buildCustomerReceipt(order, opts = {}) {
  const W = opts.width || 42;
  const cp = opts.thaiCp ?? 21;
  const restaurantName = opts.restaurantName || 'POS V2';
  const parts = [INIT, selectCodePage(cp)];
  parts.push(ALIGN_C, SIZE_DOUBLE, BOLD_ON, line(restaurantName), BOLD_OFF, SIZE_NORMAL);
  parts.push(ALIGN_C, line('--- ใบเสร็จ / RECEIPT ---'));
  parts.push(ALIGN_L, line(pad(orderQueueLabel(order), orderLocationLabel(order), W)));
  parts.push(line(`Order #${order.id}`));
  parts.push(line(new Date(order.created_at).toLocaleString('th-TH')));
  parts.push(rule(W));
  for (const [index, it] of order.items.entries()) {
    const variantSuffix = it.variant_name ? ` (${it.variant_name})` : '';
    parts.push(line(pad(`${index + 1}. ${it.quantity} x ${it.product_name}${variantSuffix}`, '', W - 8)));
    parts.push(line(`  [${fulfillmentText(itemFulfillmentType(order, it))}]`));
    const lineTotal = (Number(it.unit_price) * it.quantity).toFixed(2);
    parts.push(line(pad(`  @${Number(it.unit_price).toFixed(2)}`, lineTotal, W)));
    if (Array.isArray(it.options_selected) && it.options_selected.length) {
      parts.push(line(`  > ${it.options_selected.map((o) => o.value).join(' · ')}`));
    }
    if (it.note) parts.push(line(`  *${it.note}`));
  }
  parts.push(rule(W));
  parts.push(BOLD_ON, SIZE_TALL, line(pad('TOTAL', Number(order.total_amount).toFixed(2), Math.floor(W / 2))), BOLD_OFF, SIZE_NORMAL);
  parts.push(rule(W, '='));
  const paymentQr = paymentQrMeta(order, opts.paymentSettings || opts);
  if (paymentQr) {
    parts.push(ALIGN_C, BOLD_ON, line(paymentQr.label), BOLD_OFF);
    parts.push(escposQr(paymentQr.payload, opts.paymentQrSize || 6));
    if (paymentQr.accountName) parts.push(line(paymentQr.accountName));
    if (paymentQr.accountId) parts.push(line(`รหัส: ${paymentQr.accountId}`));
    if (paymentQr.includeAmount) parts.push(line(`ยอดชำระ ${Number(order.total_amount).toFixed(2)} บาท`));
    parts.push(ALIGN_L, rule(W));
  }
  parts.push(ALIGN_C, line('ขอบคุณที่ใช้บริการ'), line('Thank you'));
  parts.push(feedLines(opts), cutCommand(opts, 'full'));
  return Buffer.concat(parts);
}

function buildTestPayload(opts = {}) {
  const W = opts.width || 42;
  const cp = opts.thaiCp ?? 21;
  return Buffer.concat([
    INIT, selectCodePage(cp),
    ALIGN_C, SIZE_DOUBLE, BOLD_ON, line('PRINT TEST'),
    BOLD_OFF, SIZE_NORMAL, line('--- ทดสอบภาษาไทย ---'),
    line('สวัสดีครับ ปริ้นเตอร์ทำงานปกติ'),
    line('ABC 123 abc !@#$%'),
    rule(W), feedLines(opts), cutCommand(opts, 'partial'),
  ]);
}

function classifyPrinterError(err) {
  const code = err?.code || (String(err?.message || '').toLowerCase().includes('timeout') ? 'PRINTER_TIMEOUT' : 'PRINTER_ERROR');
  return {
    code,
    message: err?.message || String(err),
    retryable: !['EINVAL', 'ENOTFOUND'].includes(code),
  };
}

function sendToPrinter(host, port, buffer, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    let writeAccepted = false;
    let settleTimer = null;
    const startedAt = Date.now();

    const finish = (err, meta = {}) => {
      if (done) return;
      done = true;
      if (settleTimer) clearTimeout(settleTimer);
      socket.removeAllListeners();
      try { socket.destroy(); } catch {}
      const result = {
        host,
        port,
        elapsed_ms: Date.now() - startedAt,
        bytes_written: socket.bytesWritten,
        ...meta,
      };
      if (err) {
        Object.assign(err, { printer_meta: result });
        reject(err);
      } else {
        resolve(result);
      }
    };

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 1000);
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => {
      const err = new Error(`printer timeout after ${timeoutMs}ms`);
      err.code = 'PRINTER_TIMEOUT';
      finish(err, { phase: writeAccepted ? 'after_write' : 'connect_or_write' });
    });
    socket.once('error', (err) => {
      // Many raw-port thermal printers accept the bytes, immediately close the
      // socket, then Windows reports ECONNRESET. After write callback we treat
      // that as accepted to avoid duplicate kitchen tickets.
      if (writeAccepted && ['ECONNRESET', 'EPIPE'].includes(err.code)) {
        logger.warn('printer.socket', 'socket reset after payload accepted', {
          code: err.code,
          host,
          port,
          bytes_written: socket.bytesWritten,
        });
        finish(null, { accepted_with_socket_error: err.code });
        return;
      }
      finish(err, { phase: writeAccepted ? 'after_write' : 'connect_or_write' });
    });
    socket.once('close', (hadError) => {
      if (!done && writeAccepted) finish(null, { closed: true, had_error: hadError });
    });
    socket.connect(port, host, () => {
      socket.write(buffer, (err) => {
        if (err) return finish(err, { phase: 'write_callback' });
        writeAccepted = true;
        socket.end();
        settleTimer = setTimeout(() => finish(null, { settled: true }), 250);
      });
    });
  });
}

// Config
function printerConfig() {
  const enabled = (process.env.PRINTER_ENABLED || 'true').toLowerCase() !== 'false';
  const host = process.env.PRINTER_HOST || null;
  const port = parseInt(process.env.PRINTER_PORT, 10) || 9100;
  return {
    enabled,
    host,
    port,
    printerKey: process.env.PRINTER_KEY || `${host || 'unconfigured'}:${port}`,
    timeout: parseInt(process.env.PRINTER_TIMEOUT_MS, 10) || 3000,
    thaiCp: parseInt(process.env.PRINTER_THAI_CP, 10) || 21,
    width: parseInt(process.env.PRINTER_WIDTH_CHARS, 10) || 42,
    pollIntervalMs: parseInt(process.env.PRINTER_POLL_MS, 10) || 1500,
    backoffBaseSec: parseInt(process.env.PRINTER_BACKOFF_BASE_SEC, 10) || 3,
    backoffMaxSec: parseInt(process.env.PRINTER_BACKOFF_MAX_SEC, 10) || 120,
    maxAttempts: parseInt(process.env.PRINTER_MAX_ATTEMPTS, 10) || 8,
    healthPollMs: parseInt(process.env.PRINTER_HEALTH_POLL_MS, 10) || 10000,
    renderMode: (process.env.PRINTER_RENDER_MODE || 'text').toLowerCase(),
    fontPath: process.env.PRINTER_FONT_PATH || null,
    widthPx: parseInt(process.env.PRINTER_WIDTH_PX, 10) || 384,
    feedLines: parseInt(process.env.PRINTER_FEED_LINES, 10) || 4,
    bottomFeedPx: parseInt(
      process.env.PRINTER_BITMAP_BOTTOM_FEED_PX || process.env.PRINTER_BOTTOM_FEED_PX,
      10
    ) || 80,
    rasterBandHeight: parseInt(process.env.PRINTER_RASTER_BAND_HEIGHT, 10) || 128,
    paperWidthMm: parseInt(process.env.PRINTER_PAPER_WIDTH_MM, 10) || 58,
    paperHeightMm: parseInt(process.env.PRINTER_PAPER_HEIGHT_MM, 10) || 0,
    paperGapMm: parseInt(process.env.PRINTER_PAPER_GAP_MM, 10) || 0,
    cutMode: (process.env.PRINTER_CUT_MODE || '').toLowerCase() || null,
  };
}

function printerConfigForTarget(target = {}) {
  const base = printerConfig();
  const stationKey = target.key || target.station_key || target.print_station_key;
  const host = target.printer_host ?? target.host ?? base.host;
  const port = parseInt(target.printer_port ?? target.port, 10) || base.port;
  const printerKey = target.printer_key || target.printerKey ||
    (stationKey ? `station:${stationKey}` : base.printerKey);
  return {
    ...base,
    host,
    port,
    printerKey,
    thaiCp: clampInt(target.thai_cp ?? target.thaiCp, base.thaiCp, 0, 255),
    width: clampInt(target.width_chars ?? target.width, base.width, 16, 80),
    renderMode: String(target.render_mode || target.renderMode || base.renderMode).toLowerCase(),
    paperWidthMm: clampInt(target.paper_width_mm ?? target.paperWidthMm, base.paperWidthMm, 30, 120),
    paperHeightMm: clampInt(target.paper_height_mm ?? target.paperHeightMm, base.paperHeightMm, 0, 1000),
    paperGapMm: clampInt(target.paper_gap_mm ?? target.paperGapMm, base.paperGapMm, 0, 60),
    widthPx: clampInt(target.width_px ?? target.widthPx, base.widthPx, 128, 832),
    feedLines: clampInt(target.feed_lines ?? target.feedLines, base.feedLines, 0, 24),
    bottomFeedPx: clampInt(target.bottom_feed_px ?? target.bottomFeedPx, base.bottomFeedPx, 0, 1200),
    rasterBandHeight: clampInt(target.raster_band_height ?? target.rasterBandHeight, base.rasterBandHeight, 64, 256),
    cutMode: ['none', 'partial', 'full'].includes(String(target.cut_mode || target.cutMode || '').toLowerCase())
      ? String(target.cut_mode || target.cutMode).toLowerCase()
      : (base.cutMode || null),
    stationKey: stationKey || null,
    stationLabel: target.name || target.station_label || target.stationLabel || null,
  };
}

async function loadActivePrintStation(key) {
  try {
    const { rows } = await db.query(
      `SELECT *
         FROM print_stations
        WHERE key = $1 AND is_active = TRUE
        LIMIT 1`,
      [key]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

async function recordPrinterStatus(status, details = {}, target = null) {
  const cfg = target ? printerConfigForTarget(target) : printerConfig();
  try {
    await db.query(
      `INSERT INTO printer_status
         (printer_key, host, port, status, last_seen_at, last_error, last_error_code,
          last_latency_ms, consecutive_failures, updated_at)
       VALUES ($1, $2, $3, $4::varchar,
               CASE WHEN $4::varchar = 'online' THEN NOW() ELSE NULL END,
               $5, $6, $7, CASE WHEN $4::varchar = 'online' THEN 0 ELSE 1 END, NOW())
       ON CONFLICT (printer_key) DO UPDATE SET
          host = EXCLUDED.host,
          port = EXCLUDED.port,
          status = EXCLUDED.status,
          last_seen_at = CASE WHEN EXCLUDED.status = 'online' THEN NOW() ELSE printer_status.last_seen_at END,
          last_error = EXCLUDED.last_error,
          last_error_code = EXCLUDED.last_error_code,
          last_latency_ms = EXCLUDED.last_latency_ms,
          consecutive_failures = CASE
            WHEN EXCLUDED.status = 'online' THEN 0
            ELSE printer_status.consecutive_failures + 1
          END,
          updated_at = NOW()`,
      [cfg.printerKey, cfg.host, cfg.port, status,
       details.error || null, details.code || null, details.latency_ms || null]
    );
  } catch (err) {
    if (err.code !== '42P01') logger.warn('printer.health', 'failed to record printer status', { error: err.message, code: err.code });
  }
}

function probePrinter(host, port, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    const startedAt = Date.now();
    const finish = (err) => {
      if (done) return;
      done = true;
      socket.removeAllListeners();
      try { socket.destroy(); } catch {}
      if (err) reject(err);
      else resolve(Date.now() - startedAt);
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => {
      const err = new Error(`printer health timeout after ${timeoutMs}ms`);
      err.code = 'PRINTER_TIMEOUT';
      finish(err);
    });
    socket.once('error', finish);
    socket.connect(port, host, () => finish(null));
  });
}

async function runHealthCheck(target = null) {
  const cfg = target ? printerConfigForTarget(target) : printerConfig();
  if (!cfg.enabled || !cfg.host) {
    await recordPrinterStatus('unconfigured', { error: `enabled=${cfg.enabled}, host=${cfg.host}` }, cfg);
    return { status: 'unconfigured' };
  }
  try {
    const latencyMs = await probePrinter(cfg.host, cfg.port, Math.min(cfg.timeout, 2000));
    await recordPrinterStatus('online', { latency_ms: latencyMs }, cfg);
    logger.debug('printer.health', 'printer online', { host: cfg.host, port: cfg.port, latency_ms: latencyMs });
    return { status: 'online', latency_ms: latencyMs };
  } catch (err) {
    const classified = classifyPrinterError(err);
    await recordPrinterStatus('offline', classified, cfg);
    logger.warn('printer.health', 'printer offline', {
      host: cfg.host,
      port: cfg.port,
      code: classified.code,
      error: classified.message,
    });
    return { status: 'offline', ...classified };
  }
}

async function getPrinterStatus(target = null) {
  const cfg = target ? printerConfigForTarget(target) : printerConfig();
  try {
    const { rows } = await db.query('SELECT * FROM printer_status WHERE printer_key = $1', [cfg.printerKey]);
    return rows[0] || { printer_key: cfg.printerKey, host: cfg.host, port: cfg.port, status: 'unknown' };
  } catch (err) {
    if (err.code === '42P01') return { printer_key: cfg.printerKey, host: cfg.host, port: cfg.port, status: 'migration_required' };
    throw err;
  }
}

function normalizeStatus(status) {
  return LEGACY_STATUS[status] || status;
}

// Persistent queue
async function enqueueJob({
  type,
  orderId = null,
  label = null,
  payload,
  createdBy = null,
  dedupeKey = null,
  force = false,
  printerOverride = null,
}) {
  const cfg = printerOverride ? printerConfigForTarget(printerOverride) : printerConfig();
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    if (dedupeKey && !force) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [dedupeKey]);
      const existing = await client.query(
        `SELECT id, status, attempts, max_attempts, created_at, updated_at, printed_at
           FROM print_jobs
          WHERE dedupe_key = $1 AND status <> 'cancelled'
          ORDER BY id DESC LIMIT 1`,
        [dedupeKey]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        wakeWorker();
        return { ...existing.rows[0], deduped: true };
      }
    }
    const { rows } = await client.query(
      `INSERT INTO print_jobs
         (job_uuid, type, order_id, label, payload, status, max_attempts,
          next_attempt_at, created_by, dedupe_key, printer_key, printer_host, printer_port)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW(), $7, $8, $9, $10, $11)
       RETURNING id, job_uuid, status, attempts, max_attempts, created_at`,
      [randomUUID(), type, orderId, label, payload, cfg.maxAttempts, createdBy,
       force && dedupeKey ? `${dedupeKey}:force:${randomUUID()}` : dedupeKey,
       cfg.printerKey, cfg.host, cfg.port]
    );
    await client.query('COMMIT');
    wakeWorker();
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listJobs({ status, limit = 50 } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(normalizeStatus(status));
    where = `WHERE status = $${params.length}`;
  }
  params.push(Math.min(500, Math.max(1, limit)));
  const { rows } = await db.query(
    `SELECT id, job_uuid, type, order_id, label, status, attempts, max_attempts,
            error, last_error_code, dedupe_key, printer_key, printer_host, printer_port,
            next_attempt_at, locked_by, locked_at, created_at, updated_at,
            printed_at, completed_at, octet_length(payload) AS bytes
       FROM print_jobs ${where}
      ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function retryJob(id) {
  const { rows } = await db.query(
    `UPDATE print_jobs
        SET status = 'pending',
            attempts = 0,
            error = NULL,
            last_error_code = NULL,
            locked_by = NULL,
            locked_at = NULL,
            processing_deadline_at = NULL,
            next_attempt_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND status IN ('failed', 'cancelled', 'retrying')
      RETURNING id, status`,
    [id]
  );
  if (!rows[0]) return null;
  wakeWorker();
  return rows[0];
}

async function cancelJob(id) {
  const { rows } = await db.query(
    `UPDATE print_jobs
        SET status = 'cancelled',
            locked_by = NULL,
            locked_at = NULL,
            processing_deadline_at = NULL,
            updated_at = NOW()
      WHERE id = $1 AND status IN ('pending', 'retrying', 'processing')
      RETURNING id, status`,
    [id]
  );
  return rows[0] || null;
}

async function recoverOrphanJobs() {
  const { rowCount } = await db.query(
    `UPDATE print_jobs
        SET status = 'retrying',
            error = COALESCE(error, 'worker recovered stale processing job'),
            last_error_code = COALESCE(last_error_code, 'WORKER_RECOVERY'),
            locked_by = NULL,
            locked_at = NULL,
            processing_deadline_at = NULL,
            next_attempt_at = NOW(),
            updated_at = NOW()
      WHERE status = 'processing'
        AND (processing_deadline_at IS NULL OR processing_deadline_at <= NOW())`
  );
  if (rowCount > 0) logger.warn('printer.queue', 'recovered stale processing jobs', { count: rowCount });
}

async function claimNextJob() {
  const cfg = printerConfig();
  const { rows } = await db.query(
    `WITH next_job AS (
       SELECT id FROM print_jobs
        WHERE status IN ('pending', 'retrying')
          AND next_attempt_at <= NOW()
        ORDER BY priority DESC, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE print_jobs pj
        SET status = 'processing',
            attempts = attempts + 1,
            locked_by = $1,
            locked_at = NOW(),
            processing_deadline_at = NOW() + ($2 || ' milliseconds')::interval,
            updated_at = NOW()
       FROM next_job
      WHERE pj.id = next_job.id
      RETURNING pj.*`,
    [INSTANCE_ID, String(Math.max(cfg.timeout * 3, 10000))]
  );
  return rows[0] || null;
}

async function markSuccess(job, meta, target = null) {
  await db.query(
    `UPDATE print_jobs
        SET status = 'success',
            error = NULL,
            last_error_code = NULL,
            locked_by = NULL,
            locked_at = NULL,
            processing_deadline_at = NULL,
            printed_at = NOW(),
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND locked_by = $2`,
    [job.id, INSTANCE_ID]
  );
  await recordPrinterStatus('online', { latency_ms: meta?.elapsed_ms }, target);
}

function nextBackoffSeconds(attempts, cfg) {
  const base = Math.max(1, cfg.backoffBaseSec);
  const cap = Math.max(base, cfg.backoffMaxSec);
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempts - 1)));
  const jitter = Math.floor(Math.random() * Math.min(5, exp));
  return Math.min(cap, exp + jitter);
}

async function markFailedOrRequeue(job, err, classified, cfg) {
  if (job.attempts >= job.max_attempts || classified.retryable === false) {
    await db.query(
      `UPDATE print_jobs
          SET status = 'failed',
              error = $2,
              last_error_code = $3,
              locked_by = NULL,
              locked_at = NULL,
              processing_deadline_at = NULL,
              completed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND locked_by = $4`,
      [job.id, classified.message, classified.code, INSTANCE_ID]
    );
    return 'failed';
  }
  const delay = nextBackoffSeconds(job.attempts, cfg);
  await db.query(
    `UPDATE print_jobs
        SET status = 'retrying',
            error = $2,
            last_error_code = $3,
            locked_by = NULL,
            locked_at = NULL,
            processing_deadline_at = NULL,
            next_attempt_at = NOW() + ($4 || ' seconds')::interval,
            updated_at = NOW()
      WHERE id = $1 AND locked_by = $5`,
    [job.id, classified.message, classified.code, String(delay), INSTANCE_ID]
  );
  return 'retrying';
}

// Worker loop
let _workerRunning = false;
let _workerStopRequested = false;
let _wakeup = null;
let _healthTimer = null;

function wakeWorker() {
  if (_wakeup) {
    const f = _wakeup;
    _wakeup = null;
    f();
  }
}

function sleepWithWake(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { _wakeup = null; resolve(); }, ms);
    _wakeup = () => { clearTimeout(t); _wakeup = null; resolve(); };
  });
}

async function workerLoop() {
  logger.info('printer.queue', 'worker started', { instance_id: INSTANCE_ID });
  while (!_workerStopRequested) {
    const cfg = printerConfig();
    let job = null;
    try {
      await recoverOrphanJobs();
      job = await claimNextJob();
    } catch (err) {
      logger.error('printer.queue', 'claim error', { error: err.message, code: err.code });
    }

    if (!job) {
      await sleepWithWake(cfg.pollIntervalMs);
      continue;
    }

    const jobCfg = printerConfigForTarget({
      printer_key: job.printer_key,
      printer_host: job.printer_host,
      printer_port: job.printer_port,
    });

    if (!jobCfg.enabled || !jobCfg.host) {
      const err = new Error(`printer not configured (enabled=${jobCfg.enabled}, host=${jobCfg.host})`);
      err.code = 'PRINTER_UNCONFIGURED';
      const classified = classifyPrinterError(err);
      const nextStatus = await markFailedOrRequeue(job, err, classified, jobCfg);
      logger.warn('printer.queue', 'job deferred because printer is not configured', {
        job_id: job.id,
        printer_key: jobCfg.printerKey,
        status: nextStatus,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
      });
      continue;
    }

    try {
      const meta = await sendToPrinter(jobCfg.host, jobCfg.port, job.payload, jobCfg.timeout);
      await markSuccess(job, meta, jobCfg);
      logger.info('printer.queue', 'job printed', {
        job_id: job.id,
        type: job.type,
        order_id: job.order_id,
        printer_key: jobCfg.printerKey,
        host: jobCfg.host,
        port: jobCfg.port,
        attempts: job.attempts,
        elapsed_ms: meta.elapsed_ms,
        bytes_written: meta.bytes_written,
        accepted_with_socket_error: meta.accepted_with_socket_error,
      });
    } catch (err) {
      const classified = classifyPrinterError(err);
      await recordPrinterStatus('offline', classified, jobCfg);
      const nextStatus = await markFailedOrRequeue(job, err, classified, jobCfg);
      logger.warn('printer.queue', 'job print failed', {
        job_id: job.id,
        type: job.type,
        order_id: job.order_id,
        printer_key: jobCfg.printerKey,
        host: jobCfg.host,
        port: jobCfg.port,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
        status: nextStatus,
        code: classified.code,
        error: classified.message,
        meta: err.printer_meta,
      });
    }
  }
  _workerRunning = false;
  logger.info('printer.queue', 'worker stopped', { instance_id: INSTANCE_ID });
}

function startHealthMonitor() {
  if (_healthTimer) return;
  const tick = () => runHealthCheck().catch((err) => {
    logger.warn('printer.health', 'health check crashed', { error: err.message, code: err.code });
  });
  tick();
  _healthTimer = setInterval(tick, printerConfig().healthPollMs);
  _healthTimer.unref?.();
}

function stopHealthMonitor() {
  if (_healthTimer) clearInterval(_healthTimer);
  _healthTimer = null;
}

function startWorker() {
  startHealthMonitor();
  if (_workerRunning) return;
  _workerRunning = true;
  _workerStopRequested = false;
  workerLoop().catch((err) => {
    logger.error('printer.queue', 'worker crashed', { error: err.message, stack: err.stack });
    _workerRunning = false;
  });
}

function stopWorker() {
  _workerStopRequested = true;
  stopHealthMonitor();
  wakeWorker();
}

// High-level helpers
async function queueOrderKitchen(order, {
  createdBy,
  dedupeKey,
  force,
  printerOverride = null,
  stationKey = null,
  stationLabel = null,
} = {}) {
  const cfg = printerOverride
    ? printerConfigForTarget({ ...printerOverride, key: stationKey || printerOverride.key, station_label: stationLabel })
    : printerConfig();
  const payloadOpts = { ...cfg, stationLabel: stationLabel || cfg.stationLabel };
  const payload = cfg.renderMode === 'image'
    ? bitmap.buildKitchenBitmap(order, payloadOpts)
    : buildKitchenReceipt(order, payloadOpts);
  const stationSuffix = stationKey || cfg.stationKey || 'kitchen';
  const labelPrefix = stationLabel || cfg.stationLabel || 'ครัว';
  return enqueueJob({
    type: 'kitchen',
    orderId: order.id,
    createdBy,
    dedupeKey: dedupeKey || `order:${order.id}:station:${stationSuffix}`,
    force,
    label: `${labelPrefix} ${orderQueueLabel(order)} #${order.id} ${order.table_name || ''}`.trim(),
    payload,
    printerOverride: cfg,
  });
}

async function queueOrderReceipt(order, {
  createdBy,
  restaurantName,
  paymentSettings,
  dedupeKey,
  force,
  printerOverride = null,
} = {}) {
  const receiptStation = printerOverride || await loadActivePrintStation('receipt');
  const cfg = receiptStation ? printerConfigForTarget(receiptStation) : printerConfig();
  const payload = cfg.renderMode === 'image'
    ? bitmap.buildReceiptBitmap(order, { ...cfg, restaurantName, paymentSettings })
    : buildCustomerReceipt(order, { ...cfg, restaurantName, paymentSettings });
  return enqueueJob({
    type: 'receipt',
    orderId: order.id,
    createdBy,
    dedupeKey: dedupeKey || `order:${order.id}:receipt`,
    force,
    label: `ใบเสร็จ ${orderQueueLabel(order)} #${order.id} ${order.table_name || ''}`.trim(),
    payload,
    printerOverride: cfg,
  });
}

async function queueTest({ createdBy, force, printerOverride = null } = {}) {
  const cfg = printerOverride ? printerConfigForTarget(printerOverride) : printerConfig();
  const payload = cfg.renderMode === 'image'
    ? bitmap.buildTestBitmap(cfg)
    : buildTestPayload(cfg);
  return enqueueJob({
    type: 'test',
    createdBy,
    force,
    dedupeKey: null,
    label: `Test print ${cfg.stationLabel || cfg.printerKey} (${cfg.renderMode})`,
    payload,
    printerOverride: cfg,
  });
}

module.exports = {
  buildKitchenReceipt,
  buildCustomerReceipt,
  buildTestPayload,
  sendToPrinter,
  classifyPrinterError,
  printerConfig,
  printerConfigForTarget,
  queueOrderKitchen,
  queueOrderReceipt,
  queueTest,
  listJobs,
  retryJob,
  cancelJob,
  getPrinterStatus,
  runHealthCheck,
  startWorker,
  stopWorker,
  wakeWorker,
  recoverOrphanJobs,
};

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
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
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
function thaiClusters(text) {
  const marks = /[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/;
  const out = [];
  for (const ch of Array.from(String(text ?? ''))) {
    if (marks.test(ch) && out.length) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}
function columnWidth(text) {
  return thaiClusters(text).filter((part) => !/^[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]+$/.test(part)).length;
}
function wrapTextColumns(text, maxColumns) {
  const max = Math.max(1, Math.floor(maxColumns));
  const result = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    const tokens = paragraph.split(/(\s+)/).filter((token) => token.length > 0);
    let current = '';
    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        if (current && !current.endsWith(' ')) current += ' ';
        continue;
      }
      const candidate = current ? current + token : token;
      if (columnWidth(candidate) <= max) {
        current = candidate;
        continue;
      }
      if (current.trim()) {
        result.push(current.trimEnd());
        current = '';
      }
      let chunk = '';
      for (const cluster of thaiClusters(token)) {
        const next = chunk + cluster;
        if (columnWidth(next) > max && chunk) {
          result.push(chunk);
          chunk = cluster;
        } else {
          chunk = next;
        }
      }
      current = chunk;
    }
    if (current.trim()) result.push(current.trimEnd());
  }
  return result.length ? result : [''];
}
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
    for (const { item: it } of section.items) {
      const variantSuffix = it.variant_name ? ` (${it.variant_name})` : '';
      parts.push(BOLD_ON, SIZE_TALL, line(`${it.quantity} x ${it.product_name}${variantSuffix}`), BOLD_OFF, SIZE_NORMAL);
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
  parts.push(ALIGN_C, SIZE_DOUBLE, BOLD_ON);
  for (const nameLine of wrapTextColumns(restaurantName, Math.floor(W / 2))) {
    parts.push(line(nameLine));
  }
  parts.push(BOLD_OFF, SIZE_NORMAL);
  parts.push(ALIGN_C, line('--- ใบเสร็จ / RECEIPT ---'));
  parts.push(ALIGN_L, line(pad(orderQueueLabel(order), orderLocationLabel(order), W)));
  parts.push(line(`Order #${order.id}`));
  parts.push(line(new Date(order.created_at).toLocaleString('th-TH')));
  parts.push(rule(W));
  for (const it of order.items) {
    const variantSuffix = it.variant_name ? ` (${it.variant_name})` : '';
    parts.push(line(pad(`${it.quantity} x ${it.product_name}${variantSuffix}`, '', W - 8)));
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

// QR label for handing a paper QR to customers as an alternative to
// showing the screen. Uses the existing thermal printer infrastructure
// so the label comes out on the same paper as receipts.
function buildQrLabel({
  url,
  tableName = '',
  tableCode = '',
  storeName = '',
  storeLogo = '',
  note = 'สแกน QR เพื่อสั่งอาหาร',
  footer = 'ขอบคุณที่ใช้บริการ',
  qrSize = 8,
} = {}, opts = {}) {
  const W = opts.width || 42;
  const cp = opts.thaiCp ?? 21;
  const parts = [INIT, selectCodePage(cp)];
  const header = [storeLogo, storeName].filter(Boolean).join(' ').trim();
  if (header) {
    parts.push(ALIGN_C, SIZE_DOUBLE, BOLD_ON);
    for (const headLine of wrapTextColumns(header, Math.floor(W / 2))) {
      parts.push(line(headLine));
    }
    parts.push(BOLD_OFF, SIZE_NORMAL);
  }
  parts.push(ALIGN_C, line(note));
  parts.push(rule(W));
  if (tableName) {
    parts.push(ALIGN_C, SIZE_DOUBLE, BOLD_ON, line(tableName), BOLD_OFF, SIZE_NORMAL);
  }
  if (tableCode) parts.push(ALIGN_C, line(tableCode));
  parts.push(LF);
  parts.push(ALIGN_C, escposQr(url || '', Math.max(3, Math.min(8, Number(qrSize) || 8))));
  parts.push(LF);
  if (url) parts.push(ALIGN_C, line(url));
  parts.push(rule(W));
  if (footer) parts.push(ALIGN_C, line(footer));
  parts.push(feedLines(opts), cutCommand(opts, 'partial'));
  return Buffer.concat(parts);
}

async function queueBarcodeLabel(opts, { createdBy, force, station } = {}) {
  if (!opts?.barcode) {
    const err = new Error('barcode required');
    err.status = 400;
    throw err;
  }
  const cfg = station ? printerConfigForTarget(station) : printerConfig();
  // Text-mode ESC/POS printers can request a CODE128 barcode natively
  // (GS k ...), but rendering reliability varies. The bitmap path works
  // on any thermal printer that accepts raster — including image-mode
  // A70Pro. Keep it simple: always bitmap.
  const payload = bitmap.buildBarcodeLabelBitmap(opts, cfg);
  const labelParts = ['Barcode'];
  if (opts.name) labelParts.push(opts.name);
  if (opts.barcode) labelParts.push(`(${opts.barcode})`);
  return enqueueJob({
    type: 'barcode',
    createdBy,
    force,
    dedupeKey: null,
    label: labelParts.join(' '),
    payload,
    printerOverride: cfg,
  });
}

async function queueQrLabel(opts, { createdBy, force } = {}) {
  if (!opts?.url) {
    const err = new Error('url required');
    err.status = 400;
    throw err;
  }
  const cfg = printerConfig();
  // Image-mode printers don't render Thai via TIS-620 — they render
  // glyphs from a font file. Use the bitmap builder for them so the
  // QR label shows correct Thai (ชื่อร้าน, ชื่อโต๊ะ, ขอบคุณ ...).
  const payload = cfg.renderMode === 'image'
    ? bitmap.buildQrLabelBitmap(opts, cfg)
    : buildQrLabel(opts, cfg);
  const labelParts = ['QR'];
  if (opts.tableName) labelParts.push(opts.tableName);
  if (opts.tableCode) labelParts.push(`(${opts.tableCode})`);
  return enqueueJob({
    type: 'qr',
    createdBy,
    force,
    dedupeKey: null,
    label: labelParts.join(' '),
    payload,
    printerOverride: cfg,
  });
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

const RAW_PRINT_POWERSHELL = `
$ErrorActionPreference = 'Stop'
$printerName = $args[0]
$dataPath = $args[1]
if ([string]::IsNullOrWhiteSpace($printerName)) { throw 'missing printer name' }
if (!(Test-Path -LiteralPath $dataPath)) { throw ('payload not found: ' + $dataPath) }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PosRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFO di);
  [DllImport("winspool.Drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  static Exception LastWin32(string action) {
    return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), action);
  }
  public static int SendBytes(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) throw LastWin32("OpenPrinter");
    IntPtr unmanaged = Marshal.AllocCoTaskMem(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, unmanaged, bytes.Length);
      DOCINFO di = new DOCINFO();
      di.pDocName = "POS V2 Raw Print";
      di.pDataType = "RAW";
      if (!StartDocPrinter(hPrinter, 1, di)) throw LastWin32("StartDocPrinter");
      try {
        if (!StartPagePrinter(hPrinter)) throw LastWin32("StartPagePrinter");
        try {
          int written;
          if (!WritePrinter(hPrinter, unmanaged, bytes.Length, out written)) throw LastWin32("WritePrinter");
          if (written != bytes.Length) throw new Exception("Short write: " + written + "/" + bytes.Length);
          return written;
        } finally { EndPagePrinter(hPrinter); }
      } finally { EndDocPrinter(hPrinter); }
    } finally {
      Marshal.FreeCoTaskMem(unmanaged);
      ClosePrinter(hPrinter);
    }
  }
}
'@
$bytes = [System.IO.File]::ReadAllBytes($dataPath)
$written = [PosRawPrinter]::SendBytes($printerName, $bytes)
Write-Output ("written=" + $written)
`;

function parseWindowsPrinterName(value) {
  const text = String(value || '').trim();
  const m = text.match(/^(?:winspool|windows-printer|windows|spooler):(.+)$/i);
  return m ? m[1].trim() : null;
}

function normalizeTransport(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['winspool', 'windows', 'windows-printer', 'windows_printer', 'spooler'].includes(text)) return 'winspool';
  return 'tcp';
}

function runPowerShell(args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const exe = process.env.POWERSHELL_EXE || 'powershell.exe';
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      const err = new Error(`PowerShell timeout after ${timeoutMs}ms`);
      err.code = 'POWERSHELL_TIMEOUT';
      reject(err);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error((stderr || stdout || `PowerShell exited ${code}`).trim());
      err.code = 'WINDOWS_PRINTER_ERROR';
      reject(err);
    });
  });
}

async function runPowerShellFile(script, scriptArgs = [], timeoutMs = 8000) {
  const file = path.join(os.tmpdir(), `pos-v2-ps-${process.pid}-${randomUUID()}.ps1`);
  await fs.writeFile(file, script, 'utf8');
  try {
    return await runPowerShell([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      file,
      ...scriptArgs,
    ], timeoutMs);
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

async function sendToWindowsPrinter(printerName, buffer, timeoutMs = 8000) {
  if (!printerName) {
    const err = new Error('Windows printer name is not configured');
    err.code = 'WINDOWS_PRINTER_UNCONFIGURED';
    throw err;
  }
  const startedAt = Date.now();
  const file = path.join(os.tmpdir(), `pos-v2-print-${process.pid}-${randomUUID()}.bin`);
  await fs.writeFile(file, buffer);
  try {
    await runPowerShellFile(RAW_PRINT_POWERSHELL, [printerName, file], Math.max(timeoutMs, 8000));
    const queued = await inspectWindowsPrintQueue(printerName, Math.min(2500, Math.max(800, timeoutMs - 500)));
    if (queued?.has_error) {
      const err = new Error(`Windows print queue error for "${printerName}": ${queued.job_status || 'Error'}`);
      err.code = 'WINDOWS_PRINT_QUEUE_ERROR';
      throw err;
    }
    return {
      transport: 'winspool',
      windows_printer_name: printerName,
      elapsed_ms: Date.now() - startedAt,
      bytes_written: buffer.length,
    };
  } catch (err) {
    Object.assign(err, {
      code: err.code || 'WINDOWS_PRINTER_ERROR',
      printer_meta: {
        transport: 'winspool',
        windows_printer_name: printerName,
        elapsed_ms: Date.now() - startedAt,
        bytes_written: 0,
      },
    });
    throw err;
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

async function inspectWindowsPrintQueue(printerName, waitMs = 1000) {
  const script = `
$ErrorActionPreference = 'Stop'
Start-Sleep -Milliseconds ([int]$args[1])
$job = Get-PrintJob -PrinterName $args[0] -ErrorAction SilentlyContinue |
  Sort-Object SubmittedTime -Descending |
  Select-Object -First 1
if ($null -eq $job) {
  [pscustomobject]@{ has_job = $false; has_error = $false } | ConvertTo-Json -Compress
} else {
  $status = [string]$job.JobStatus
  [pscustomobject]@{
    has_job = $true
    has_error = $status -match 'Error|Blocked|Offline|Paper|UserIntervention'
    id = $job.Id
    job_status = $status
    document_name = $job.DocumentName
    size = $job.Size
  } | ConvertTo-Json -Compress
}
`;
  const { stdout } = await runPowerShellFile(script, [printerName, String(waitMs)], waitMs + 4000);
  try { return JSON.parse(stdout || '{}'); } catch { return null; }
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
  const windowsPrinterName = process.env.PRINTER_WINDOWS_NAME || parseWindowsPrinterName(process.env.PRINTER_KEY);
  const transport = normalizeTransport(process.env.PRINTER_TRANSPORT || (windowsPrinterName ? 'winspool' : 'tcp'));
  return {
    enabled,
    transport,
    host,
    port,
    windowsPrinterName,
    printerKey: process.env.PRINTER_KEY || (
      transport === 'winspool'
        ? `winspool:${windowsPrinterName || 'unconfigured'}`
        : `${host || 'unconfigured'}:${port}`
    ),
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
  const rawPrinterKey = target.printer_key || target.printerKey || null;
  const targetWindowsPrinterName = target.windows_printer_name || target.windowsPrinterName ||
    parseWindowsPrinterName(rawPrinterKey) || parseWindowsPrinterName(target.printer_host ?? target.host);
  const transport = normalizeTransport(target.printer_transport || target.transport || (targetWindowsPrinterName ? 'winspool' : base.transport));
  const windowsPrinterName = targetWindowsPrinterName || (transport === 'winspool' ? base.windowsPrinterName : null);
  const host = transport === 'winspool' ? null : (target.printer_host ?? target.host ?? base.host);
  const port = transport === 'winspool' ? null : (parseInt(target.printer_port ?? target.port, 10) || base.port);
  const printerKey = rawPrinterKey || (
    transport === 'winspool'
      ? `winspool:${windowsPrinterName || 'unconfigured'}`
      : (stationKey ? `station:${stationKey}` : base.printerKey)
  );
  return {
    ...base,
    transport,
    host,
    port,
    printerKey,
    windowsPrinterName,
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

async function loadPrintStation(key) {
  try {
    const { rows } = await db.query(
      `SELECT *
         FROM print_stations
        WHERE key = $1
        LIMIT 1`,
      [key]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

function disabledStationError(key) {
  const err = new Error(`print station "${key}" is disabled`);
  err.code = 'PRINT_STATION_DISABLED';
  err.status = 409;
  return err;
}

function printerStatusHost(cfg) {
  return cfg.transport === 'winspool' ? cfg.windowsPrinterName : cfg.host;
}

function isPrinterConfigured(cfg) {
  if (!cfg.enabled) return false;
  return cfg.transport === 'winspool' ? !!cfg.windowsPrinterName : !!cfg.host;
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
      [cfg.printerKey, printerStatusHost(cfg), cfg.port, status,
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

async function probeWindowsPrinter(printerName, timeoutMs = 3000) {
  const script = `
$ErrorActionPreference = 'Stop'
$p = Get-Printer -Name $args[0] -ErrorAction Stop
[pscustomobject]@{
  name = $p.Name
  driver_name = $p.DriverName
  port_name = $p.PortName
  printer_status = [string]$p.PrinterStatus
  work_offline = [bool]$p.WorkOffline
} | ConvertTo-Json -Compress
`;
  const startedAt = Date.now();
  const { stdout } = await runPowerShellFile(script, [printerName], Math.max(timeoutMs, 3000));
  let parsed = {};
  try { parsed = JSON.parse(stdout || '{}'); } catch {}
  if (parsed.work_offline) {
    const err = new Error(`Windows printer "${printerName}" is offline`);
    err.code = 'WINDOWS_PRINTER_OFFLINE';
    throw err;
  }
  return { latency_ms: Date.now() - startedAt, ...parsed };
}

async function listWindowsPrinters() {
  if (process.platform !== 'win32') return [];
  const script = `
$ErrorActionPreference = 'Stop'
Get-Printer |
  Select-Object Name, DriverName, PortName, PrinterStatus, WorkOffline |
  ConvertTo-Json -Compress
`;
  const { stdout } = await runPowerShellFile(script, [], 6000);
  const parsed = JSON.parse(stdout || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    name: p.Name,
    driver_name: p.DriverName,
    port_name: p.PortName,
    printer_status: String(p.PrinterStatus ?? ''),
    work_offline: !!p.WorkOffline,
  }));
}

async function runHealthCheck(target = null) {
  const cfg = target ? printerConfigForTarget(target) : printerConfig();
  if (!isPrinterConfigured(cfg)) {
    await recordPrinterStatus('unconfigured', {
      error: `enabled=${cfg.enabled}, transport=${cfg.transport}, target=${printerStatusHost(cfg) || 'none'}`,
    }, cfg);
    return { status: 'unconfigured' };
  }
  try {
    const health = cfg.transport === 'winspool'
      ? await probeWindowsPrinter(cfg.windowsPrinterName, Math.min(cfg.timeout, 4000))
      : { latency_ms: await probePrinter(cfg.host, cfg.port, Math.min(cfg.timeout, 2000)) };
    const latencyMs = health.latency_ms;
    await recordPrinterStatus('online', { latency_ms: latencyMs }, cfg);
    logger.debug('printer.health', 'printer online', {
      transport: cfg.transport,
      host: cfg.host,
      port: cfg.port,
      windows_printer_name: cfg.windowsPrinterName,
      latency_ms: latencyMs,
    });
    return { status: 'online', transport: cfg.transport, ...health };
  } catch (err) {
    const classified = classifyPrinterError(err);
    await recordPrinterStatus('offline', classified, cfg);
    logger.warn('printer.health', 'printer offline', {
      transport: cfg.transport,
      host: cfg.host,
      port: cfg.port,
      windows_printer_name: cfg.windowsPrinterName,
      code: classified.code,
      error: classified.message,
    });
    return { status: 'offline', transport: cfg.transport, ...classified };
  }
}

async function getPrinterStatus(target = null) {
  const cfg = target ? printerConfigForTarget(target) : printerConfig();
  try {
    const { rows } = await db.query('SELECT * FROM printer_status WHERE printer_key = $1', [cfg.printerKey]);
    return rows[0] || { printer_key: cfg.printerKey, host: printerStatusHost(cfg), port: cfg.port, status: 'unknown' };
  } catch (err) {
    if (err.code === '42P01') return { printer_key: cfg.printerKey, host: printerStatusHost(cfg), port: cfg.port, status: 'migration_required' };
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

    if (!isPrinterConfigured(jobCfg)) {
      const err = new Error(`printer not configured (enabled=${jobCfg.enabled}, transport=${jobCfg.transport}, target=${printerStatusHost(jobCfg) || 'none'})`);
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
      const meta = jobCfg.transport === 'winspool'
        ? await sendToWindowsPrinter(jobCfg.windowsPrinterName, job.payload, jobCfg.timeout)
        : await sendToPrinter(jobCfg.host, jobCfg.port, job.payload, jobCfg.timeout);
      await markSuccess(job, meta, jobCfg);
      logger.info('printer.queue', 'job printed', {
        job_id: job.id,
        type: job.type,
        order_id: job.order_id,
        printer_key: jobCfg.printerKey,
        transport: jobCfg.transport,
        host: jobCfg.host,
        port: jobCfg.port,
        windows_printer_name: jobCfg.windowsPrinterName,
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
        transport: jobCfg.transport,
        host: jobCfg.host,
        port: jobCfg.port,
        windows_printer_name: jobCfg.windowsPrinterName,
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
  if (printerOverride?.is_active === false) throw disabledStationError(stationKey || printerOverride.key || 'kitchen');
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
  const receiptStation = printerOverride || await loadPrintStation('receipt');
  if (receiptStation?.is_active === false) throw disabledStationError('receipt');
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
  buildQrLabel,
  buildTestPayload,
  sendToPrinter,
  sendToWindowsPrinter,
  classifyPrinterError,
  printerConfig,
  printerConfigForTarget,
  queueOrderKitchen,
  queueOrderReceipt,
  queueQrLabel,
  queueBarcodeLabel,
  queueTest,
  listJobs,
  retryJob,
  cancelJob,
  getPrinterStatus,
  runHealthCheck,
  listWindowsPrinters,
  startWorker,
  stopWorker,
  wakeWorker,
  recoverOrphanJobs,
};

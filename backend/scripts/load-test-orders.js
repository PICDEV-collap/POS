#!/usr/bin/env node
/**
 * Concurrent order load test — measures how many parallel createOrder() calls
 * the backend + PostgreSQL pool can handle.
 *
 * Usage:
 *   cd backend && node scripts/load-test-orders.js
 *   LOAD_LEVELS=10,20,30,50,80 node scripts/load-test-orders.js
 */
require('dotenv').config();

const db = require('../src/db');
const { createOrder } = require('../src/routes/orders');

const LEVEL_TIMEOUT_MS = Number(process.env.LOAD_LEVEL_TIMEOUT_MS || 120000);
const LEVELS = (process.env.LOAD_LEVELS || '10,15,20,25,30,35,40,45,50,55,60')
  .split(',')
  .map((n) => parseInt(n.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

const POOL_MAX = Number(process.env.PG_POOL_MAX || db.pool?.options?.max || 20);
const FAIL_RATE_MAX = Number(process.env.LOAD_FAIL_RATE_MAX || 0.05);
const CLEANUP = (process.env.LOAD_CLEANUP || 'true').toLowerCase() !== 'false';

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function loadFixture() {
  const tableRes = await db.query(
    `SELECT t.id, t.store_id, t.code, t.name
       FROM tables t
       JOIN stores s ON s.id = t.store_id
      WHERE t.is_active = TRUE
        AND s.is_active = TRUE
        AND COALESCE(t.seats, 4) > 0
      ORDER BY t.id
      LIMIT 1`
  );
  const table = tableRes.rows[0];
  if (!table) throw new Error('no active dine-in table');

  const productRes = await db.query(
    `SELECT p.id, p.name
       FROM products p
       JOIN categories c ON c.id = p.category_id
      WHERE p.store_id = $1
        AND c.store_id = $1
        AND p.is_available = TRUE
        AND c.is_active = TRUE
        AND COALESCE(p.product_type, 'food') <> 'stock'
        AND COALESCE(p.track_stock, FALSE) = FALSE
        AND COALESCE(jsonb_array_length(p.options), 0) = 0
      ORDER BY p.id
      LIMIT 1`,
    [table.store_id]
  );
  const product = productRes.rows[0];
  if (!product) throw new Error('no available product');

  return { table, product };
}

async function oneOrder(fixture, idx) {
  const started = Date.now();
  try {
    const order = await createOrder({
      table_id: fixture.table.id,
      items: [{ product_id: fixture.product.id, quantity: 1, fulfillment_type: 'dine-in' }],
      note: `load-test #${idx} ${Date.now()}`,
      source: 'staff',
      order_type: 'dine-in',
      store_id: fixture.table.store_id,
    });
    return { ok: true, ms: Date.now() - started, orderId: order.id };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err.message || String(err) };
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function runLevel(concurrency, fixture) {
  const started = Date.now();
  const tasks = Array.from({ length: concurrency }, (_, i) => oneOrder(fixture, i + 1));
  let results;
  try {
    results = await withTimeout(
      Promise.all(tasks),
      LEVEL_TIMEOUT_MS,
      `level ${concurrency}`,
    );
  } catch (err) {
    return {
      concurrency,
      elapsed: Date.now() - started,
      success: 0,
      failed: concurrency,
      failRate: 1,
      rps: '0.0',
      p50: 0,
      p95: 0,
      p99: 0,
      maxMs: 0,
      errors: { [err.message]: concurrency },
      orderIds: [],
      timedOut: true,
    };
  }
  const elapsed = Date.now() - started;
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
  const orderIds = ok.map((r) => r.orderId);
  const errCounts = {};
  for (const f of fail) {
    const key = f.error || 'unknown';
    errCounts[key] = (errCounts[key] || 0) + 1;
  }
  return {
    concurrency,
    elapsed,
    success: ok.length,
    failed: fail.length,
    failRate: fail.length / concurrency,
    rps: (ok.length / (elapsed / 1000)).toFixed(1),
    p50: pct(latencies, 50),
    p95: pct(latencies, 95),
    p99: pct(latencies, 99),
    maxMs: latencies.length ? latencies[latencies.length - 1] : 0,
    errors: errCounts,
    orderIds,
  };
}

async function main() {
  console.log('POS V2 — concurrent order load test');
  console.log(`PG pool max connections: ${POOL_MAX}`);
  console.log(`Levels: ${LEVELS.join(', ')}`);
  console.log('');

  const fixture = await loadFixture();
  console.log(
    `Fixture: store=${fixture.table.store_id} table=${fixture.table.code} product=${fixture.product.name}`,
  );
  console.log('');

  const allOrderIds = [];
  let lastGood = 0;

  console.log(
    'conc | ok | fail | fail% | rps  | p50ms | p95ms | p99ms | wallms | top error',
  );
  console.log(
    '-----+----+------+-------+------+-------+-------+-------+--------+----------',
  );

  for (const level of LEVELS) {
    const row = await runLevel(level, fixture);
    allOrderIds.push(...row.orderIds);
    const failPct = (row.failRate * 100).toFixed(1);
    const topErr = Object.keys(row.errors)[0] || '-';
    if (row.failed > 0 && process.env.LOAD_VERBOSE === '1') {
      for (const [msg, n] of Object.entries(row.errors)) {
        console.error(`  error x${n}: ${msg}`);
      }
    }
    console.log(
      `${String(row.concurrency).padStart(4)} | ${String(row.success).padStart(2)} | ${String(row.failed).padStart(4)} | ${failPct.padStart(5)}% | ${String(row.rps).padStart(4)} | ${String(row.p50).padStart(5)} | ${String(row.p95).padStart(5)} | ${String(row.p99).padStart(5)} | ${String(row.elapsed).padStart(6)} | ${topErr.slice(0, 40)}`,
    );
    if (row.failRate <= FAIL_RATE_MAX) lastGood = row.concurrency;
    if (row.timedOut || (row.failRate > FAIL_RATE_MAX && row.failed === row.concurrency)) {
      console.log('');
      console.log(
        row.timedOut
          ? `Stopped — level ${level} timed out (pool likely saturated at ~${POOL_MAX}).`
          : `Stopped — all ${level} concurrent orders failed.`,
      );
      break;
    }
  }

  console.log('');
  console.log(`Recommended safe concurrent orders (fail <= ${FAIL_RATE_MAX * 100}%): ~${lastGood}`);
  console.log(`Theoretical DB pool ceiling: ~${POOL_MAX} (each order holds 1 connection during transaction)`);

  if (CLEANUP && allOrderIds.length) {
    await db.query(
      `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = ANY($1::int[])`,
      [allOrderIds],
    );
    console.log(`Cleaned up ${allOrderIds.length} test orders (cancelled).`);
  }

  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  db.pool.end().catch(() => {});
  process.exit(1);
});

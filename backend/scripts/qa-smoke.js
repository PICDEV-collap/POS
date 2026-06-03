require('dotenv').config();

const bcrypt = require('bcrypt');
const iconv = require('iconv-lite');
const db = require('../src/db');
const { createOrder } = require('../src/routes/orders');

const BASE_URL = process.env.QA_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4000}`;
const ADMIN_USERNAME = process.env.QA_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD || 'admin123';
const QA_PASSWORD = process.env.QA_TEMP_PASSWORD || 'qa-smoke-pass-20260529';

const results = [];
const failures = [];
const createdOrderIds = [];
const tempUsernames = [];
let fixtures = [];
let adminByStore = new Map();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name, ms, detail });
    console.log(`PASS ${name}${detail ? ` - ${detail}` : ''} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - started;
    failures.push({ name, error: err });
    console.error(`FAIL ${name} - ${err.message} (${ms}ms)`);
  }
}

async function api(method, path, { token, storeId, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (storeId) headers['X-POS-Store-ID'] = String(storeId);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null;
    }
  }
  return { status: res.status, ok: res.ok, json, text };
}

function normalizeText(value) {
  return String(value || '').replace(/[\x00-\x1F\x7F]/g, '').replace(/\s+/g, '');
}

function decodePrintPayload(payload) {
  const bytes = Buffer.from(payload.bytes_base64, 'base64');
  return iconv.decode(bytes, 'tis620');
}

async function loadFixtures() {
  const { rows: stores } = await db.query(
    `SELECT id, name
       FROM stores
      WHERE is_active = TRUE
      ORDER BY id
      LIMIT 2`
  );
  assert(stores.length >= 1, 'no active stores found');

  const out = [];
  for (const store of stores) {
    const tableRes = await db.query(
      `SELECT id, store_id, code, name, seats, qr_token
         FROM tables
        WHERE store_id = $1
          AND is_active = TRUE
          AND COALESCE(seats, 4) > 0
        ORDER BY id
        LIMIT 1`,
      [store.id]
    );
    assert(tableRes.rows[0], `no active dine-in table for store ${store.id}`);

    const productRes = await db.query(
      `SELECT p.id, p.store_id, p.name, p.price
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
      [store.id]
    );
    assert(productRes.rows[0], `no simple available non-stock product for store ${store.id}`);
    out.push({ store, table: tableRes.rows[0], product: productRes.rows[0] });
  }
  return out;
}

async function login(username, password, storeId) {
  const res = await api('POST', '/api/auth/login', {
    body: { username, password, store_id: storeId },
  });
  assert(res.status === 200, `login failed for ${username}/store ${storeId}: ${res.status} ${res.text}`);
  assert(res.json?.token, 'login response missing token');
  assert(Number(res.json.user?.store_id) === Number(storeId), 'login store_id mismatch');
  return res.json;
}

async function ensureTempStoreUser(storeId) {
  const username = `qa_smoke_staff_store_${storeId}`;
  tempUsernames.push(username);
  const hash = await bcrypt.hash(QA_PASSWORD, 10);
  await db.query(
    `INSERT INTO users
       (username, password_hash, full_name, role, store_id, allowed_store_ids, permissions, is_active)
     VALUES ($1, $2, $3, 'staff', $4, ARRAY[$4]::int[], '[]'::jsonb, TRUE)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       full_name = EXCLUDED.full_name,
       role = EXCLUDED.role,
       store_id = EXCLUDED.store_id,
       allowed_store_ids = EXCLUDED.allowed_store_ids,
       permissions = EXCLUDED.permissions,
       is_active = TRUE`,
    [username, hash, `QA Smoke Staff Store ${storeId}`, storeId]
  );
  return username;
}

async function createQaOrder(fixture) {
  const order = await createOrder({
    table_id: fixture.table.id,
    items: [
      {
        product_id: fixture.product.id,
        quantity: 1,
        fulfillment_type: 'dine-in',
      },
    ],
    note: `QA smoke test ${new Date().toISOString()}`,
    source: 'staff',
    created_by: null,
    order_type: 'dine-in',
    store_id: fixture.store.id,
  });
  createdOrderIds.push(order.id);
  return order;
}

async function cleanup() {
  if (createdOrderIds.length) {
    await db.query(
      `UPDATE orders
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = ANY($1::int[])`,
      [createdOrderIds]
    );
  }
  if (tempUsernames.length) {
    await db.query('DELETE FROM users WHERE username = ANY($1::text[])', [tempUsernames]);
  }
}

async function main() {
  await step('service health', async () => {
    const apiHealth = await api('GET', '/api/health');
    assert(apiHealth.status === 200 && apiHealth.json?.ok === true, 'backend health failed');
    return BASE_URL;
  });

  await step('load database fixtures', async () => {
    fixtures = await loadFixtures();
    return fixtures.map((f) => `store ${f.store.id}: table ${f.table.id}, product ${f.product.id}`).join(' | ');
  });

  await step('admin login for each active store', async () => {
    for (const f of fixtures) {
      const auth = await login(ADMIN_USERNAME, ADMIN_PASSWORD, f.store.id);
      adminByStore.set(f.store.id, auth);
    }
    return `${adminByStore.size} store sessions`;
  });

  await step('invalid login is rejected', async () => {
    const res = await api('POST', '/api/auth/login', {
      body: { username: ADMIN_USERNAME, password: 'wrong-password', store_id: fixtures[0].store.id },
    });
    assert(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
    return `status ${res.status}`;
  });

  await step('public menu is scoped by store', async () => {
    for (const f of fixtures) {
      const res = await api('GET', `/api/public/menu?store_id=${f.store.id}`);
      assert(res.status === 200, `public menu failed for store ${f.store.id}: ${res.status}`);
      const ids = (res.json.products || []).map((p) => Number(p.id));
      assert(ids.includes(Number(f.product.id)), `store ${f.store.id} menu missing product ${f.product.id}`);
      if (fixtures.length > 1) {
        const other = fixtures.find((x) => x.store.id !== f.store.id);
        assert(!ids.includes(Number(other.product.id)), `store ${f.store.id} leaked product ${other.product.id}`);
      }
    }
    return `${fixtures.length} menus`;
  });

  await step('staff tables and orders are scoped by active store', async () => {
    for (const f of fixtures) {
      const token = adminByStore.get(f.store.id).token;
      const tables = await api('GET', '/api/tables', { token, storeId: f.store.id });
      assert(tables.status === 200, `tables failed for store ${f.store.id}: ${tables.status}`);
      assert((tables.json || []).every((t) => Number(t.store_id) === Number(f.store.id)), 'tables leaked another store');
      assert((tables.json || []).some((t) => Number(t.id) === Number(f.table.id)), 'fixture table not listed');

      const orders = await api('GET', '/api/orders', { token, storeId: f.store.id });
      assert(orders.status === 200, `orders failed for store ${f.store.id}: ${orders.status}`);
      assert((orders.json || []).every((o) => Number(o.store_id) === Number(f.store.id)), 'orders leaked another store');
    }
    return `${fixtures.length} store scopes`;
  });

  if (fixtures.length > 1) {
    await step('cross-store order attempts fail before creating orders', async () => {
      const store1 = fixtures[0];
      const store2 = fixtures[1];
      const token1 = adminByStore.get(store1.store.id).token;
      const token2 = adminByStore.get(store2.store.id).token;

      const wrongProduct = await api('POST', '/api/orders', {
        token: token2,
        storeId: store2.store.id,
        body: {
          table_id: store2.table.id,
          store_id: store2.store.id,
          items: [{ product_id: store1.product.id, quantity: 1, fulfillment_type: 'dine-in' }],
          order_type: 'dine-in',
        },
      });
      assert(wrongProduct.status === 400, `expected product mismatch 400, got ${wrongProduct.status}`);
      assert(/product .* not found/i.test(wrongProduct.text), 'wrong product error message changed');

      const wrongStore = await api('POST', '/api/orders', {
        token: token1,
        storeId: store1.store.id,
        body: {
          table_id: store2.table.id,
          store_id: store1.store.id,
          items: [{ product_id: store2.product.id, quantity: 1, fulfillment_type: 'dine-in' }],
          order_type: 'dine-in',
        },
      });
      assert(wrongStore.status === 403, `expected store mismatch 403, got ${wrongStore.status}`);
      return '400 product mismatch + 403 store mismatch';
    });
  }

  const qaOrders = [];
  await step('create QA orders without server auto-print', async () => {
    for (const f of fixtures) {
      const order = await createQaOrder(f);
      assert(Number(order.store_id) === Number(f.store.id), 'created order store mismatch');
      assert(order.items.length === 1, 'created order item count mismatch');
      qaOrders.push({ fixture: f, order });
    }
    return qaOrders.map(({ order }) => `#${order.id}`).join(', ');
  });

  await step('print payloads render correct store and item format', async () => {
    assert(qaOrders.length > 0, 'no QA orders available for print payload tests');
    for (const { fixture, order } of qaOrders) {
      const token = adminByStore.get(fixture.store.id).token;
      for (const type of ['receipt', 'kitchen']) {
        const res = await api(
          'GET',
          `/api/print/payload/order/${order.id}?type=${type}&render_mode=text&width_chars=42`,
          { token, storeId: fixture.store.id }
        );
        assert(res.status === 200, `${type} payload failed for order ${order.id}: ${res.status}`);
        assert(Number(res.json.bytes_length) > 0, `${type} payload is empty`);
        const decoded = decodePrintPayload(res.json);
        assert(!/\b\d+\.\s+\d+\s*x\b/.test(decoded), `${type} still has item sequence prefix`);
        if (type === 'receipt') {
          assert(
            normalizeText(decoded).includes(normalizeText(fixture.store.name)),
            `receipt missing store name ${fixture.store.name}`
          );
        }
      }
    }
    return `${qaOrders.length * 2} payloads`;
  });

  await step('public QR table and token menu work per store', async () => {
    for (const f of fixtures) {
      const table = await api('GET', `/api/public/table/${encodeURIComponent(f.table.qr_token)}`);
      assert(table.status === 200, `public table failed for store ${f.store.id}: ${table.status}`);
      assert(Number(table.json.id) === Number(f.table.id), 'public table id mismatch');

      const menu = await api('GET', `/api/public/menu?token=${encodeURIComponent(f.table.qr_token)}`);
      assert(menu.status === 200, `public token menu failed for store ${f.store.id}: ${menu.status}`);
      const ids = (menu.json.products || []).map((p) => Number(p.id));
      assert(ids.includes(Number(f.product.id)), 'public token menu missing fixture product');
    }
    const invalid = await api('GET', '/api/public/table/not-a-real-token');
    assert(invalid.status === 404, `invalid token expected 404, got ${invalid.status}`);
    return `${fixtures.length} QR fixtures + invalid token`;
  });

  await step('limited staff user cannot cross stores', async () => {
    const f = fixtures[0];
    const username = await ensureTempStoreUser(f.store.id);
    const auth = await login(username, QA_PASSWORD, f.store.id);
    if (fixtures.length > 1) {
      const other = fixtures[1];
      const forbiddenLogin = await api('POST', '/api/auth/login', {
        body: { username, password: QA_PASSWORD, store_id: other.store.id },
      });
      assert(forbiddenLogin.status === 403, `expected limited login 403, got ${forbiddenLogin.status}`);

      const forbiddenTables = await api('GET', '/api/tables', {
        token: auth.token,
        storeId: other.store.id,
      });
      assert(forbiddenTables.status === 403, `expected limited tables 403, got ${forbiddenTables.status}`);
    }
    return username;
  });
}

main()
  .catch((err) => {
    failures.push({ name: 'unhandled', error: err });
    console.error(err);
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (err) {
      failures.push({ name: 'cleanup', error: err });
      console.error(`FAIL cleanup - ${err.message}`);
    }
    await db.pool.end().catch(() => {});
    console.log(`\nQA smoke summary: ${results.length} passed, ${failures.length} failed`);
    if (failures.length) {
      process.exitCode = 1;
    }
  });

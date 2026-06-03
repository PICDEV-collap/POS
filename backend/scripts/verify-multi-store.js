#!/usr/bin/env node
// Quick multi-store API verification (run with backend up).
require('dotenv').config();

const BASE_URL = process.env.QA_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4000}`;
const USER = process.env.QA_ADMIN_USERNAME || 'admin';
const PASS = process.env.QA_ADMIN_PASSWORD || 'admin123';

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
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: res.status, ok: res.ok, json, text };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const stamp = Date.now();
  let passed = 0;
  let failed = 0;

  async function step(name, fn) {
    try {
      await fn();
      console.log(`PASS ${name}`);
      passed += 1;
    } catch (e) {
      console.error(`FAIL ${name} — ${e.message}`);
      failed += 1;
    }
  }

  let token1;
  let token2;
  let store2Id;

  await step('admin login store 1', async () => {
    const res = await api('POST', '/api/auth/login', {
      body: { username: USER, password: PASS, store_id: 1 },
    });
    assert(res.ok, `${res.status} ${res.text}`);
    token1 = res.json.token;
  });

  await step('create second store', async () => {
    const res = await api('POST', '/api/stores', {
      token: token1,
      storeId: 1,
      body: {
        code: `qa_${stamp}`,
        slug: `qa-store-${stamp}`,
        name: `QA Store ${stamp}`,
        logo: '🧪',
      },
    });
    assert(res.ok, `${res.status} ${res.text}`);
    store2Id = res.json.id;
    assert(store2Id, 'missing store id');
  });

  await step('store 2 has starter tables from migration 017', async () => {
    const res = await api('GET', '/api/tables', { token: token1, storeId: store2Id });
    assert(res.ok, `${res.status} ${res.text}`);
    assert((res.json || []).length >= 1, 'expected tables on new store');
  });

  await step('public menus are store-scoped', async () => {
    const m1 = await api('GET', '/api/public/menu?store_id=1');
    const m2 = await api('GET', `/api/public/menu?store_id=${store2Id}`);
    assert(m1.ok && m2.ok, 'menu fetch failed');
    const p1 = new Set((m1.json?.products || []).map((p) => p.id));
    const p2 = new Set((m2.json?.products || []).map((p) => p.id));
    const overlap = [...p1].filter((id) => p2.has(id));
    assert(overlap.length === 0 || p1.size === 0 || p2.size === 0,
      `unexpected shared product ids across stores: ${overlap.join(',')}`);
  });

  await step('admin login store 2', async () => {
    const res = await api('POST', '/api/auth/login', {
      body: { username: USER, password: PASS, store_id: store2Id },
    });
    assert(res.ok, `${res.status} ${res.text}`);
    token2 = res.json.token;
    assert(Number(res.json.user.store_id) === Number(store2Id), 'session store mismatch');
  });

  await step('tables list respects X-POS-Store-ID', async () => {
    const s1 = await api('GET', '/api/tables', { token: token1, storeId: 1 });
    const s2 = await api('GET', '/api/tables', { token: token2, storeId: store2Id });
    assert(s1.ok && s2.ok, 'tables fetch failed');
    assert((s1.json || []).every((t) => Number(t.store_id) === 1), 'store 1 leak');
    assert((s2.json || []).every((t) => Number(t.store_id) === Number(store2Id)), 'store 2 leak');
  });

  await step('deactivate QA store (cleanup)', async () => {
    const res = await api('PUT', `/api/stores/${store2Id}`, {
      token: token1,
      storeId: 1,
      body: { is_active: false },
    });
    assert(res.ok, `${res.status} ${res.text}`);
  });

  console.log(`\nMulti-store verify: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

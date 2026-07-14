// When env is "" (empty) -> same-origin via Next.js rewrites (Safari/ngrok-friendly).
// When env is unset -> fall back to localhost:4000 for default dev.
const BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';

async function request(path, opts = {}) {
  const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const hasBody = opts.body != null;
  const headers = {
    ...(hasBody && !isFormData ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${BASE}${path}`, {
    cache: 'no-store',
    credentials: BASE ? 'omit' : 'same-origin',
    ...opts,
    headers,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const body = await res.json(); if (body.error) msg = body.error; } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function locationQuery(location) {
  if (!location) return '';
  const qs = new URLSearchParams();
  if (Number.isFinite(Number(location.lat))) qs.set('lat', String(location.lat));
  if (Number.isFinite(Number(location.lng))) qs.set('lng', String(location.lng));
  if (Number.isFinite(Number(location.accuracy))) qs.set('accuracy', String(location.accuracy));
  const text = qs.toString();
  return text ? `?${text}` : '';
}

function locationHeaders(location) {
  if (!location) return {};
  const headers = {};
  if (Number.isFinite(Number(location.lat))) headers['X-POS-Customer-Lat'] = String(location.lat);
  if (Number.isFinite(Number(location.lng))) headers['X-POS-Customer-Lng'] = String(location.lng);
  if (Number.isFinite(Number(location.accuracy))) headers['X-POS-Customer-Accuracy'] = String(location.accuracy);
  return headers;
}

export const api = {
  getTable: (token, customerKey, location = null) => request(`/api/public/table/${encodeURIComponent(token)}${locationQuery(location)}`, {
    headers: {
      ...(customerKey ? { 'X-POS-Customer-Key': customerKey } : {}),
      ...locationHeaders(location),
    },
  }),
  getMenu: (token) => request(`/api/public/menu${token ? `?token=${encodeURIComponent(token)}` : ''}`),
  placeOrder: (token, items, note, opts = {}) =>
    request('/api/public/orders', {
      method: 'POST',
      body: JSON.stringify({
        token, items, note,
        order_type: opts.order_type,
        customer_name: opts.customer_name,
        customer_key: opts.customer_key,
        customer_session_token: opts.customer_session_token,
        customer_location: opts.customer_location,
      }),
    }),
  getOrder: (id, token) =>
    request(`/api/public/orders/${id}?token=${encodeURIComponent(token)}`),
  // Batch status poll — one request for every order this phone placed.
  getTableOrders: (token, ids) =>
    request(`/api/public/table-orders?token=${encodeURIComponent(token)}&ids=${ids.map(Number).filter(Boolean).join(',')}`),
  // Customer calls staff to the table (bill / service).
  callStaff: (token, type = 'bill') =>
    request('/api/public/call-staff', {
      method: 'POST',
      body: JSON.stringify({ token, type }),
    }),
};

export const apiBase = BASE;

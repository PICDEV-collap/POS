'use client';

import { apiBase } from './api';
import { storageGet, storageSet, storageRemove } from './browser';

const KEY = 'pos_v2_auth';
const STORE_KEY = 'pos_v2_active_store_id';

export function getAuth() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = storageGet(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function setAuth(auth) {
  if (typeof window === 'undefined') return;
  if (auth) storageSet(KEY, JSON.stringify(auth));
  else storageRemove(KEY);
}

export function clearAuth() {
  setAuth(null);
  if (typeof window !== 'undefined') storageRemove(STORE_KEY);
}

export async function logout() {
  const auth = getAuth();
  if (auth?.refresh_token) {
    try {
      await fetch(`${apiBase}/api/auth/logout`, {
        method: 'POST',
        cache: 'no-store',
        credentials: apiBase ? 'omit' : 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: auth.refresh_token }),
      });
    } catch { /* ignore */ }
  }
  clearAuth();
}

async function tryRefreshSession() {
  const auth = getAuth();
  if (!auth?.refresh_token) return false;
  const res = await fetch(`${apiBase}/api/auth/refresh`, {
    method: 'POST',
    cache: 'no-store',
    credentials: apiBase ? 'omit' : 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: auth.refresh_token,
      store_id: getActiveStoreId(auth.user?.store_id),
    }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  setAuth(data);
  setActiveStoreId(data.user?.store_id || 1);
  return true;
}

export function getActiveStoreId(fallback = 1) {
  if (typeof window === 'undefined') return fallback || 1;
  const raw = storageGet(STORE_KEY);
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return id;
  const fb = Number(fallback || getAuth()?.user?.store_id || 1);
  return Number.isInteger(fb) && fb > 0 ? fb : 1;
}

export function setActiveStoreId(storeId) {
  if (typeof window === 'undefined') return;
  const id = Number(storeId);
  if (Number.isInteger(id) && id > 0) storageSet(STORE_KEY, String(id));
  else storageRemove(STORE_KEY);
}

export function activeStoreHeaders(auth = getAuth()) {
  const storeId = getActiveStoreId(auth?.user?.store_id || 1);
  return storeId ? { 'X-POS-Store-ID': String(storeId) } : {};
}

export async function loginStores() {
  const res = await fetch(`${apiBase}/api/auth/stores`, {
    method: 'GET',
    cache: 'no-store',
    credentials: apiBase ? 'omit' : 'same-origin',
  });
  if (!res.ok) {
    let msg = 'load stores failed';
    try { const b = await res.json(); if (b.error) msg = b.error; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function login(username, password, storeId = null) {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    cache: 'no-store',
    credentials: apiBase ? 'omit' : 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      ...(storeId ? { store_id: Number(storeId) } : {}),
    }),
  });
  if (!res.ok) {
    let msg = 'login failed';
    try { const b = await res.json(); if (b.error) msg = b.error; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  setAuth(data);
  setActiveStoreId(data.user?.store_id || 1);
  return data;
}

export async function ensureStaffAuth() {
  const current = getAuth();
  if (current?.token && (
    current.user?.role === 'staff'
    || current.user?.role === 'admin'
    || current.user?.role === 'super_admin'
  )) {
    return current;
  }
  const res = await fetch(`${apiBase}/api/auth/staff-session`, {
    method: 'POST',
    cache: 'no-store',
    credentials: apiBase ? 'omit' : 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    let msg = 'staff session failed';
    try { const b = await res.json(); if (b.error) msg = b.error; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  setAuth(data);
  setActiveStoreId(data.user?.store_id || 1);
  return data;
}

async function authFetchOnce(path, opts = {}) {
  const auth = getAuth();
  if (!auth) throw new Error('not logged in');
  const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const hasBody = opts.body != null;
  return fetch(`${apiBase}${path}`, {
    cache: 'no-store',
    credentials: apiBase ? 'omit' : 'same-origin',
    ...opts,
    headers: {
      ...(hasBody && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${auth.token}`,
      ...activeStoreHeaders(auth),
      ...(opts.headers || {}),
    },
  });
}

export async function authFetch(path, opts = {}) {
  let res = await authFetchOnce(path, opts);
  if (res.status === 401 && (await tryRefreshSession())) {
    res = await authFetchOnce(path, opts);
  }
  if (res.status === 401) {
    clearAuth();
    throw new Error('session expired');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b.error) msg = b.error; } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

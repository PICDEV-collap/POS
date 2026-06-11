'use client';

import { apiBase } from './api';
import { storageGet, storageSet, storageRemove } from './browser';

const KEY = 'pos_v2_auth';

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

export function clearAuth() { setAuth(null); }

export async function login(username, password) {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    cache: 'no-store',
    credentials: apiBase ? 'omit' : 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    let msg = 'login failed';
    try { const b = await res.json(); if (b.error) msg = b.error; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  setAuth(data);
  return data;
}

export async function ensureStaffAuth() {
  const current = getAuth();
  if (current?.token && (current.user?.role === 'staff' || current.user?.role === 'admin')) {
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
  return data;
}

export async function authFetch(path, opts = {}) {
  const auth = getAuth();
  if (!auth) throw new Error('not logged in');
  const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const hasBody = opts.body != null;
  const res = await fetch(`${apiBase}${path}`, {
    cache: 'no-store',
    credentials: apiBase ? 'omit' : 'same-origin',
    ...opts,
    headers: {
      ...(hasBody && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${auth.token}`,
      ...(opts.headers || {}),
    },
  });
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

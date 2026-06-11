'use client';

export function storageGet(key) {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key, value) {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

export function storageRemove(key) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {}
}

export function storageJson(key, fallback = null) {
  const raw = storageGet(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function isSafariBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Safari/i.test(ua) && !/Chrome|CriOS|Chromium|Android|Edg/i.test(ua);
}

export function isSecureBrowserContext() {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext || window.location.hostname === 'localhost';
}

'use client';

import { authFetch } from './auth';
import { apiBase } from './api';
import { isSecureBrowserContext } from './browser';

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported() {
  return typeof window !== 'undefined'
      && isSecureBrowserContext()
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;
}

async function requestNotificationPermission() {
  const result = Notification.requestPermission();
  if (result && typeof result.then === 'function') return result;
  return new Promise((resolve) => Notification.requestPermission(resolve));
}

export async function ensureRegistered() {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (e) {
    console.warn('SW register failed', e);
    return null;
  }
}

export async function getSubscriptionState() {
  if (!pushSupported()) return { supported: false, status: 'unsupported' };
  if (Notification.permission === 'denied') return { supported: true, status: 'denied' };
  const reg = await ensureRegistered();
  if (!reg) return { supported: true, status: 'sw-failed' };
  const sub = await reg.pushManager.getSubscription();
  return { supported: true, status: sub ? 'subscribed' : (Notification.permission === 'granted' ? 'allowed' : 'default'), subscription: sub };
}

export async function subscribe(scope = 'kitchen') {
  if (!pushSupported()) throw new Error('push not supported');
  if (Notification.permission !== 'granted') {
    const p = await requestNotificationPermission();
    if (p !== 'granted') throw new Error('permission denied');
  }
  const reg = await ensureRegistered();
  if (!reg) throw new Error('service worker registration failed');

  // Get VAPID public key from backend
  const { key } = await fetch(`${apiBase}/api/push/vapid-public-key`, {
    cache: 'no-store',
    credentials: apiBase ? 'omit' : 'same-origin',
  }).then(r => r.json());
  if (!key) throw new Error('server has no VAPID key configured');

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  await authFetch('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription: sub.toJSON(), scope }),
  });
  return sub;
}

export async function unsubscribe() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await authFetch('/api/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  await sub.unsubscribe();
}

export async function sendTest() {
  return authFetch('/api/push/test', { method: 'POST', body: JSON.stringify({ scope: 'kitchen' }) });
}

'use client';

import { useEffect, useRef } from 'react';
import { ensureSocketConnected, requestRealtimeResume } from './socket';

const DEFAULT_EVENTS = ['order:new', 'order:update'];

export function useRealtimeRecovery(reload, options = {}) {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const intervalMs = Math.max(3000, Number(options.intervalMs || 12000));
  const reloadOnMount = options.reloadOnMount !== false;
  const pollWhenVisible = options.pollWhenVisible !== false;
  const eventKey = (options.events || DEFAULT_EVENTS).join('|');

  useEffect(() => {
    if (typeof window === 'undefined' || typeof reloadRef.current !== 'function') return;

    let disposed = false;
    let socket = null;
    const events = eventKey ? eventKey.split('|').filter(Boolean) : [];

    const safeReload = () => {
      if (disposed || typeof reloadRef.current !== 'function') return;
      Promise.resolve(reloadRef.current()).catch(() => {});
    };

    const onRealtimeEvent = () => safeReload();
    const onConnected = () => {
      requestRealtimeResume();
      safeReload();
    };

    const detach = () => {
      if (!socket) return;
      for (const event of events) socket.off(event, onRealtimeEvent);
      socket.off('connect', onConnected);
      socket.off('reconnect', onConnected);
      socket = null;
    };

    const attach = () => {
      const next = ensureSocketConnected();
      if (socket === next) return;
      detach();
      socket = next;
      for (const event of events) socket.on(event, onRealtimeEvent);
      socket.on('connect', onConnected);
      socket.on('reconnect', onConnected);
    };

    const recoverNow = () => {
      attach();
      ensureSocketConnected();
      requestRealtimeResume();
      safeReload();
    };

    const onSocketChanged = () => attach();
    const onOnline = () => recoverNow();
    const onFocus = () => recoverNow();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recoverNow();
    };

    attach();
    if (reloadOnMount) safeReload();

    window.addEventListener('pos:socket-changed', onSocketChanged);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    const timer = setInterval(() => {
      attach();
      const connected = !!socket?.connected;
      if (!connected) ensureSocketConnected();
      if (!connected || (pollWhenVisible && document.visibilityState !== 'hidden')) {
        safeReload();
      }
    }, intervalMs);

    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('pos:socket-changed', onSocketChanged);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      detach();
    };
  }, [eventKey, intervalMs, pollWhenVisible, reloadOnMount]);
}

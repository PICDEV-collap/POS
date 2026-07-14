'use client';

import { io } from 'socket.io-client';
import { apiBase } from './api';
import { storageGet, storageSet } from './browser';

const CLIENT_KEY = 'pos_v2_socket_client_id';
const EVENT_KEY = 'pos_v2_socket_last_event_id';
const MAX_BUFFERED_EMITS = 100;

let _socket = null;
let _buffer = [];
let _heartbeatTimer = null;
let _rebuildTimer = null;
let _lastDisconnectAt = 0;
const _seen = new Set();

function clientId() {
  let id = storageGet(CLIENT_KEY);
  if (!id) {
    id = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    storageSet(CLIENT_KEY, id);
  }
  return id;
}

function lastEventId() {
  const n = Number(storageGet(EVENT_KEY));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function rememberEvent(id) {
  if (!id) return;
  const n = Number(id);
  if (!Number.isFinite(n)) return;
  storageSet(EVENT_KEY, Math.max(lastEventId(), n));
  _seen.add(n);
  if (_seen.size > 500) {
    const first = _seen.values().next().value;
    _seen.delete(first);
  }
}

function flushBuffer() {
  if (!_socket?.connected || _buffer.length === 0) return;
  const pending = _buffer;
  _buffer = [];
  for (const item of pending) emitReliable(item.event, item.payload, item.options);
}

function clearHeartbeat() {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = null;
}

function clearRebuildTimer() {
  if (_rebuildTimer) clearTimeout(_rebuildTimer);
  _rebuildTimer = null;
}

function notifySocketChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('pos:socket-changed'));
}

function closeSocket(socket) {
  if (!socket) return;
  try { socket.removeAllListeners(); } catch {}
  try { socket.disconnect(); } catch {}
  try { socket.close?.(); } catch {}
}

function dispatchLocal(socket, event, payload) {
  const handlers = typeof socket.listeners === 'function' ? socket.listeners(event) : [];
  for (const handler of handlers) {
    try { handler(payload); } catch (err) { setTimeout(() => { throw err; }, 0); }
  }
}

function installRealtimeHandlers(socket) {
  socket.on('connect', () => {
    requestRealtimeResume();
    if (!_heartbeatTimer) {
      _heartbeatTimer = setInterval(() => {
        if (socket.connected) socket.timeout(2000).emit('heartbeat', { ts: Date.now() }, () => {});
      }, 10000);
    }
    flushBuffer();
  });

  socket.on('realtime:event', (envelope) => {
    const id = Number(envelope?.id);
    if (Number.isFinite(id)) {
      if (_seen.has(id)) {
        socket.emit('realtime:ack', { event_id: id });
        return;
      }
      rememberEvent(id);
      socket.emit('realtime:ack', { event_id: id });
    }
    if (envelope?.replay && envelope.event) {
      dispatchLocal(socket, envelope.event, envelope.payload);
    }
  });

  socket.on('disconnect', () => {
    _lastDisconnectAt = Date.now();
    clearHeartbeat();
  });
  socket.on('connect_error', () => {});
}

export function getSocket() {
  if (!_socket) {
    _socket = io(apiBase, {
      // The web is served same-origin behind `next start`, which can only proxy
      // Socket.io *polling* (a route handler can't upgrade WebSockets). Start on
      // polling everywhere so the connection establishes immediately; `upgrade`
      // still lets it move to WS if a real WS-capable proxy (Caddy) fronts it.
      transports: ['polling', 'websocket'],
      tryAllTransports: true,
      upgrade: true,
      rememberUpgrade: false,
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 400,
      reconnectionDelayMax: 2500,
      randomizationFactor: 0.35,
      timeout: 3000,
      auth: {
        client_id: clientId(),
        last_event_id: lastEventId(),
      },
      query: {
        client_id: clientId(),
        last_event_id: lastEventId(),
      },
    });
    installRealtimeHandlers(_socket);
    notifySocketChanged();
  }
  return _socket;
}

export function requestRealtimeResume() {
  const socket = _socket;
  if (!socket?.connected) return false;
  socket.emit('realtime:resume', { last_event_id: lastEventId() }, () => {});
  flushBuffer();
  return true;
}

export function ensureSocketConnected(options = {}) {
  const rebuildAfterMs = Number(options.rebuildAfterMs || 2500);
  const reconnectStartedAt = Date.now();
  if (options.forceNew && _socket) {
    closeSocket(_socket);
    _socket = null;
    clearHeartbeat();
    clearRebuildTimer();
  }

  const socket = getSocket();
  if (socket.connected) {
    requestRealtimeResume();
    return socket;
  }

  try {
    socket.connect();
  } catch {}

  clearRebuildTimer();
  _rebuildTimer = setTimeout(() => {
    if (!_socket || _socket.connected) return;
    const disconnectedMs = Date.now() - (_lastDisconnectAt || reconnectStartedAt);
    if (disconnectedMs < rebuildAfterMs - 250) return;
    const stale = _socket;
    closeSocket(stale);
    _socket = null;
    clearHeartbeat();
    const next = getSocket();
    try { next.connect(); } catch {}
  }, rebuildAfterMs);

  return socket;
}

export function emitReliable(event, payload, options = {}) {
  const socket = getSocket();
  if (!socket.connected) {
    _buffer.push({ event, payload, options });
    if (_buffer.length > MAX_BUFFERED_EMITS) _buffer.shift();
    return Promise.resolve({ buffered: true });
  }
  return new Promise((resolve, reject) => {
    socket.timeout(options.timeout || 2500).emit(event, payload, (err, response) => {
      if (err) {
        _buffer.push({ event, payload, options });
        if (_buffer.length > MAX_BUFFERED_EMITS) _buffer.shift();
        reject(err);
      } else {
        resolve(response || { ok: true });
      }
    });
  });
}

export function disconnectSocket() {
  if (_socket) {
    closeSocket(_socket);
    _socket = null;
    clearHeartbeat();
    clearRebuildTimer();
    notifySocketChanged();
  }
}

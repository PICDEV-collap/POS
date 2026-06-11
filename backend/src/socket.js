const { Server } = require('socket.io');
const db = require('./db');
const logger = require('./lib/logger');

let io = null;

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function createSession(socket, clientId) {
  try {
    const { rows } = await db.query(
      `INSERT INTO websocket_sessions
         (client_id, socket_id, user_agent, ip_address, last_event_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING session_id`,
      [
        clientId,
        socket.id,
        socket.handshake.headers['user-agent'] || null,
        socket.handshake.address || null,
        numberOrNull(socket.handshake.query?.last_event_id),
      ]
    );
    return rows[0]?.session_id || null;
  } catch (err) {
    if (err.code !== '42P01') logger.warn('websocket.session', 'failed to create session', { error: err.message, code: err.code });
    return null;
  }
}

async function closeSession(sessionId, lastEventId) {
  if (!sessionId) return;
  try {
    await db.query(
      `UPDATE websocket_sessions
          SET disconnected_at = NOW(),
              last_seen_at = NOW(),
              last_event_id = COALESCE($2, last_event_id)
        WHERE session_id = $1`,
      [sessionId, lastEventId || null]
    );
  } catch (err) {
    if (err.code !== '42P01') logger.warn('websocket.session', 'failed to close session', { error: err.message, code: err.code });
  }
}

async function ackSession(sessionId, eventId) {
  if (!sessionId) return;
  try {
    if (eventId) {
      await db.query(
        `UPDATE websocket_sessions
            SET last_seen_at = NOW(),
                last_event_id = GREATEST(COALESCE(last_event_id, 0), $2)
          WHERE session_id = $1`,
        [sessionId, eventId]
      );
    } else {
      await db.query('UPDATE websocket_sessions SET last_seen_at = NOW() WHERE session_id = $1', [sessionId]);
    }
  } catch (err) {
    if (err.code !== '42P01') logger.warn('websocket.ack', 'failed to ack event', { error: err.message, code: err.code, event_id: eventId });
  }
}

async function persistEvent(eventName, payload, room = null) {
  try {
    const { rows } = await db.query(
      `INSERT INTO realtime_events (event_name, room, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id`,
      [eventName, room, JSON.stringify(payload ?? null)]
    );
    if (Math.random() < 0.01) {
      db.query('DELETE FROM realtime_events WHERE expires_at < NOW()').catch(() => {});
    }
    return rows[0]?.id || null;
  } catch (err) {
    if (err.code !== '42P01') logger.warn('websocket.event', 'failed to persist realtime event', { error: err.message, code: err.code, event: eventName });
    return null;
  }
}

function emitEnvelope(target, eventName, payload, eventId, replay = false) {
  if (!target) return;
  if (eventId) {
    target.emit('realtime:event', {
      id: eventId,
      event: eventName,
      payload,
      replay,
      ts: Date.now(),
    });
  }
  target.emit(eventName, payload);
}

async function replayEvents(socket, lastEventId) {
  const fromId = numberOrNull(lastEventId);
  if (!fromId) return 0;
  try {
    const { rows } = await db.query(
      `SELECT id, event_name, payload, created_at
         FROM realtime_events
        WHERE id > $1 AND expires_at > NOW()
        ORDER BY id ASC
        LIMIT 200`,
      [fromId]
    );
    for (const row of rows) {
      socket.emit('realtime:event', {
        id: row.id,
        event: row.event_name,
        payload: row.payload,
        replay: true,
        ts: new Date(row.created_at).getTime(),
      });
    }
    if (rows.length) {
      logger.info('websocket.replay', 'replayed events to client', {
        socket_id: socket.id,
        from_event_id: fromId,
        count: rows.length,
      });
    }
    return rows.length;
  } catch (err) {
    if (err.code !== '42P01') logger.warn('websocket.replay', 'failed to replay events', { error: err.message, code: err.code, from_event_id: fromId });
    return 0;
  }
}

function initSocket(httpServer, corsOrigins) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigins, credentials: true },
    transports: ['websocket', 'polling'],
    pingInterval: 10000,
    pingTimeout: 5000,
    connectTimeout: 5000,
  });

  io.on('connection', async (socket) => {
    const clientId = String(
      socket.handshake.auth?.client_id ||
      socket.handshake.query?.client_id ||
      socket.id
    );
    const lastEventId = numberOrNull(socket.handshake.auth?.last_event_id || socket.handshake.query?.last_event_id);
    socket.data.clientId = clientId;
    socket.data.lastEventId = lastEventId;
    socket.data.sessionId = await createSession(socket, clientId);

    logger.info('websocket.connection', 'client connected', {
      socket_id: socket.id,
      client_id: clientId,
      last_event_id: lastEventId,
    });

    socket.on('join', (room, ack) => {
      if (typeof room === 'string' && room.length <= 128) {
        socket.join(room);
        if (typeof ack === 'function') ack({ ok: true, room });
      }
    });

    socket.on('heartbeat', (_payload, ack) => {
      ackSession(socket.data.sessionId, socket.data.lastEventId);
      if (typeof ack === 'function') ack({ ok: true, ts: Date.now() });
    });

    socket.on('realtime:ack', (payload, ack) => {
      const eventId = numberOrNull(payload?.event_id || payload?.id);
      socket.data.lastEventId = Math.max(socket.data.lastEventId || 0, eventId || 0);
      ackSession(socket.data.sessionId, eventId);
      if (typeof ack === 'function') ack({ ok: true, event_id: eventId });
    });

    socket.on('realtime:resume', async (payload, ack) => {
      const count = await replayEvents(socket, payload?.last_event_id || socket.data.lastEventId);
      if (typeof ack === 'function') ack({ ok: true, count });
    });

    socket.on('disconnect', (reason) => {
      closeSession(socket.data.sessionId, socket.data.lastEventId);
      logger.info('websocket.connection', 'client disconnected', {
        socket_id: socket.id,
        client_id: clientId,
        reason,
        last_event_id: socket.data.lastEventId,
      });
    });

    if (lastEventId) replayEvents(socket, lastEventId);
  });

  return io;
}

function emit(event, payload) {
  if (!io) return;
  persistEvent(event, payload)
    .then((eventId) => emitEnvelope(io, event, payload, eventId, false))
    .catch((err) => {
      logger.warn('websocket.event', 'emit fallback without replay persistence', { event, error: err.message });
      io.emit(event, payload);
    });
}

function emitToRoom(room, event, payload) {
  if (!io) return;
  persistEvent(event, payload, room)
    .then((eventId) => emitEnvelope(io.to(room), event, payload, eventId, false))
    .catch((err) => {
      logger.warn('websocket.event', 'room emit fallback without replay persistence', { event, room, error: err.message });
      io.to(room).emit(event, payload);
    });
}

module.exports = { initSocket, emit, emitToRoom };

const crypto = require('crypto');
const db = require('../db');
const logger = require('./logger');

const DEFAULT_TZ = 'Asia/Bangkok';
const SESSION_TTL_HOURS = 12;
const EARTH_RADIUS_M = 6371000;
const DAY_NAMES = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const GPS_GUARD_LOCKED = (process.env.PUBLIC_ORDER_GPS_GUARD_LOCKED || 'false').toLowerCase() === 'true';
const GPS_GUARD_RADIUS_M = 20;

function normalizeDays(value) {
  if (Array.isArray(value)) {
    const days = value.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    return days.length ? [...new Set(days)] : [0, 1, 2, 3, 4, 5, 6];
  }
  if (typeof value === 'string') {
    return normalizeDays(value.replace(/[{}]/g, '').split(','));
  }
  return [0, 1, 2, 3, 4, 5, 6];
}

function normalizeTime(value, fallback) {
  const raw = String(value || fallback || '00:00').trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return fallback;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const min = Math.max(0, Math.min(59, Number(m[2])));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function timeToMinutes(value) {
  const [h, m] = normalizeTime(value, '00:00').split(':').map(Number);
  return h * 60 + m;
}

function zonedNow(now, timezone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || DEFAULT_TZ,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TZ,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    day: DAY_NAMES[parts.weekday] ?? 0,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function isOrderingOpen(settings, now = new Date()) {
  const days = normalizeDays(settings.ordering_days);
  const open = timeToMinutes(settings.ordering_open_time);
  const close = timeToMinutes(settings.ordering_close_time);
  const current = zonedNow(now, settings.ordering_timezone);
  if (!settings.ordering_enabled) {
    return {
      open: false,
      reason: 'ปิดรับออเดอร์ด้วยสวิตช์หลัก',
      local_day: current.day,
      local_minute: current.minute,
    };
  }
  const dayAllowed = days.includes(current.day);
  const prevDayAllowed = days.includes((current.day + 6) % 7);

  let openNow;
  if (open === close) {
    openNow = dayAllowed;
  } else if (open < close) {
    openNow = dayAllowed && current.minute >= open && current.minute < close;
  } else {
    openNow = (dayAllowed && current.minute >= open) || (prevDayAllowed && current.minute < close);
  }

  return {
    open: openNow,
    reason: openNow ? null : 'อยู่นอกเวลาเปิดรับออเดอร์',
    local_day: current.day,
    local_minute: current.minute,
  };
}

async function loadPublicOrderingSettings(storeId = 1) {
  let s = null;
  try {
    const { rows } = await db.query(
      `SELECT ordering_enabled, ordering_open_time, ordering_close_time,
              ordering_timezone, ordering_days, ordering_require_session,
              ordering_require_private_ip, ordering_require_gps,
              ordering_shop_lat, ordering_shop_lng, ordering_max_distance_m
         FROM stores
        WHERE id = $1 AND is_active = TRUE`,
      [storeId || 1]
    );
    s = rows[0];
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  if (!s) {
    const fallback = await db.query(
      `SELECT ordering_enabled, ordering_open_time, ordering_close_time,
              ordering_timezone, ordering_days, ordering_require_session,
              ordering_require_private_ip, ordering_require_gps,
              ordering_shop_lat, ordering_shop_lng, ordering_max_distance_m
         FROM restaurant_settings
        WHERE id = 1`
    );
    s = fallback.rows[0] || {};
  }
  return {
    ordering_enabled: s.ordering_enabled !== false,
    ordering_open_time: normalizeTime(s.ordering_open_time, '00:00'),
    ordering_close_time: normalizeTime(s.ordering_close_time, '23:59'),
    ordering_timezone: s.ordering_timezone || DEFAULT_TZ,
    ordering_days: normalizeDays(s.ordering_days),
    ordering_require_session: s.ordering_require_session !== false,
    ordering_require_private_ip: !!s.ordering_require_private_ip,
    ordering_require_gps: GPS_GUARD_LOCKED ? true : !!s.ordering_require_gps,
    ordering_shop_lat: finiteNumber(s.ordering_shop_lat),
    ordering_shop_lng: finiteNumber(s.ordering_shop_lng),
    ordering_max_distance_m: GPS_GUARD_LOCKED ? GPS_GUARD_RADIUS_M : normalizeDistanceLimit(s.ordering_max_distance_m),
  };
}

function finiteNumber(value) {
  if (Array.isArray(value)) return finiteNumber(value[0]);
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeDistanceLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(10000, Math.round(n)));
}

function normalizeIp(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return '';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').split(',')[0].trim();
}

function requestHost(req) {
  const forwardedHost = firstHeaderValue(req.headers['x-forwarded-host']);
  const raw = forwardedHost || firstHeaderValue(req.headers.host);
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return (end > 0 ? raw.slice(1, end) : raw).toLowerCase();
  }
  return raw.replace(/:\d+$/, '').toLowerCase();
}

function clientIp(req) {
  const forwarded = firstHeaderValue(req.headers['x-forwarded-for']);
  if (forwarded) return normalizeIp(forwarded);
  return normalizeIp(firstHeaderValue(req.headers['x-real-ip']) || req.ip || req.socket?.remoteAddress || '');
}

function hasForwardedClientIp(req) {
  return !!(firstHeaderValue(req.headers['x-forwarded-for']) || firstHeaderValue(req.headers['x-real-ip']));
}

function isLoopbackIp(ip) {
  const value = normalizeIp(ip).toLowerCase();
  return value === 'localhost'
    || value === '::1'
    || value === '0:0:0:0:0:0:0:1'
    || /^127\./.test(value);
}

function isPrivateLanIp(ip) {
  const value = normalizeIp(ip);
  if (!value) return false;
  if (/^10\./.test(value)) return true;
  if (/^192\.168\./.test(value)) return true;
  const m = value.match(/^172\.(\d{1,2})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^(fc|fd)[0-9a-f]*:/i.test(value)) return true;
  if (/^fe80:/i.test(value)) return true;
  return false;
}

function isPrivateIp(ip) {
  return isLoopbackIp(ip) || isPrivateLanIp(ip);
}

function isPublicHost(host) {
  const value = String(host || '').toLowerCase();
  if (!value) return false;
  return !isLoopbackIp(value) && !isPrivateLanIp(value);
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function cidrContains(cidr, ip) {
  const [range, bitsRaw] = String(cidr || '').trim().split('/');
  const rangeInt = ipv4ToInt(range);
  const ipInt = ipv4ToInt(ip);
  if (rangeInt == null || ipInt == null) return normalizeIp(cidr) === normalizeIp(ip);
  const bits = bitsRaw == null || bitsRaw === '' ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (rangeInt & mask) === (ipInt & mask);
}

function configuredNetworkMatch(ip) {
  const raw = process.env.PUBLIC_ORDER_ALLOWED_CIDRS || process.env.PUBLIC_ORDER_ALLOWED_IPS || '';
  const entries = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return entries.find((entry) => cidrContains(entry, ip)) || null;
}

function getNetworkAccessState(req, settings) {
  const ip = clientIp(req);
  const host = requestHost(req);
  const forwardedIp = hasForwardedClientIp(req);

  const allowlist = configuredNetworkMatch(ip);
  if (allowlist) {
    return { allowed: true, reason: `allowlist:${allowlist}`, ip, host };
  }

  if (isPrivateLanIp(ip)) {
    return { allowed: true, reason: 'private-lan-ip', ip, host };
  }

  if (isLoopbackIp(ip)) {
    if (isPublicHost(host) && !forwardedIp) {
      if (!settings.ordering_require_private_ip) {
        return { allowed: true, reason: 'network-check-disabled', ip, host };
      }
      return { allowed: false, reason: 'public-host-loopback-without-client-ip', ip, host };
    }
    return { allowed: true, reason: 'loopback-local-host', ip, host };
  }

  if (!settings.ordering_require_private_ip) {
    return { allowed: true, reason: 'network-check-disabled', ip, host };
  }

  return { allowed: false, reason: 'public-client-ip', ip, host };
}

function hasShopLocation(settings) {
  return settings.ordering_shop_lat !== null
    && settings.ordering_shop_lng !== null
    && Math.abs(settings.ordering_shop_lat) <= 90
    && Math.abs(settings.ordering_shop_lng) <= 180;
}

function customerLocationFromRequest(req, body = null) {
  const loc = body?.customer_location && typeof body.customer_location === 'object'
    ? body.customer_location
    : {};
  const lat = finiteNumber(
    req.headers['x-pos-customer-lat']
    ?? req.query?.lat
    ?? req.query?.gps_lat
    ?? body?.gps_lat
    ?? loc.lat
    ?? loc.latitude
  );
  const lng = finiteNumber(
    req.headers['x-pos-customer-lng']
    ?? req.headers['x-pos-customer-lon']
    ?? req.query?.lng
    ?? req.query?.lon
    ?? req.query?.gps_lng
    ?? req.query?.gps_lon
    ?? body?.gps_lng
    ?? body?.gps_lon
    ?? loc.lng
    ?? loc.lon
    ?? loc.longitude
  );
  const accuracy = finiteNumber(
    req.headers['x-pos-customer-accuracy']
    ?? req.query?.accuracy
    ?? req.query?.gps_accuracy
    ?? body?.gps_accuracy
    ?? loc.accuracy
    ?? loc.accuracy_m
  );
  return { lat, lng, accuracy_m: accuracy };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getLocationAccessState(req, settings, body = null) {
  const maxDistanceM = normalizeDistanceLimit(settings.ordering_max_distance_m);
  const gpsConfigured = hasShopLocation(settings);
  if (!settings.ordering_require_gps) {
    return {
      allowed: true,
      reason: 'gps-check-disabled',
      gps_configured: gpsConfigured,
      max_distance_m: maxDistanceM,
    };
  }

  if (body?.__network_for_location?.allowed && isTrustedLocalNetwork(body.__network_for_location)) {
    return {
      allowed: true,
      reason: 'wifi-lan-bypass',
      gps_configured: gpsConfigured,
      max_distance_m: maxDistanceM,
    };
  }

  if (!gpsConfigured) {
    return {
      allowed: false,
      reason: 'shop-location-not-configured',
      gps_configured: false,
      max_distance_m: maxDistanceM,
    };
  }

  const loc = customerLocationFromRequest(req, body);
  if (loc.lat === null || loc.lng === null) {
    return {
      allowed: false,
      reason: 'customer-location-missing',
      gps_configured: true,
      max_distance_m: maxDistanceM,
      accuracy_m: loc.accuracy_m,
    };
  }
  if (Math.abs(loc.lat) > 90 || Math.abs(loc.lng) > 180) {
    return {
      allowed: false,
      reason: 'customer-location-invalid',
      gps_configured: true,
      max_distance_m: maxDistanceM,
      accuracy_m: loc.accuracy_m,
    };
  }

  const distanceM = haversineMeters(
    settings.ordering_shop_lat,
    settings.ordering_shop_lng,
    loc.lat,
    loc.lng
  );
  const roundedDistance = Math.round(distanceM * 10) / 10;
  return {
    allowed: distanceM <= maxDistanceM,
    reason: distanceM <= maxDistanceM ? 'within-radius' : 'outside-radius',
    gps_configured: true,
    distance_m: roundedDistance,
    accuracy_m: loc.accuracy_m == null ? null : Math.round(loc.accuracy_m * 10) / 10,
    max_distance_m: maxDistanceM,
  };
}

function isTrustedLocalNetwork(network) {
  const reason = String(network?.reason || '');
  const ip = normalizeIp(network?.ip || '');
  return reason === 'private-lan-ip'
    || reason === 'loopback-local-host'
    || reason.startsWith('allowlist:')
    || isPrivateLanIp(ip)
    || isLoopbackIp(ip);
}

function hashUserAgent(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (!ua) return null;
  return crypto.createHash('sha256').update(ua).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizeCustomerKey(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  return s.slice(0, 96);
}

function customerKeyFromRequest(req, body = null) {
  return normalizeCustomerKey(
    req.headers['x-pos-customer-key'] ||
    body?.customer_key ||
    req.query?.ck
  );
}

function sessionTokenFromRequest(req, body = null) {
  return normalizeCustomerKey(
    req.headers['x-pos-customer-session'] ||
    body?.customer_session_token ||
    req.query?.cs
  );
}

async function getPublicOrderState(req, body = null, storeId = 1) {
  const settings = await loadPublicOrderingSettings(storeId);
  const schedule = isOrderingOpen(settings);
  const network = getNetworkAccessState(req, settings);
  const location = getLocationAccessState(req, settings, {
    ...(body || {}),
    __network_for_location: network,
  });
  const networkAllowed = network.allowed;
  const locationAllowed = location.allowed;
  const allowed = schedule.open && networkAllowed && locationAllowed;
  let reason = schedule.reason;
  if (schedule.open && !networkAllowed) {
    reason = 'รับออเดอร์เฉพาะ WiFi ร้านเท่านั้น';
  } else if (schedule.open && networkAllowed && !locationAllowed) {
    if (location.reason === 'shop-location-not-configured') {
      reason = 'ยังไม่ได้ตั้งค่าพิกัดร้าน';
    } else if (location.reason === 'outside-radius') {
      reason = `ตำแหน่งอยู่นอกรัศมีร้าน ${location.distance_m ?? '-'}m/${location.max_distance_m}m`;
    } else {
      reason = 'กรุณาอนุญาตตำแหน่ง GPS ก่อนสั่งอาหาร';
    }
  }
  return {
    allowed,
    reason,
    open_now: schedule.open,
    network_allowed: networkAllowed,
    network_reason: network.reason,
    location_allowed: locationAllowed,
    location_reason: location.reason,
    location_distance_m: location.distance_m ?? null,
    location_accuracy_m: location.accuracy_m ?? null,
    location_max_distance_m: location.max_distance_m,
    gps_configured: !!location.gps_configured,
    ip: network.ip,
    host: network.host,
    settings,
  };
}

async function issueCustomerSession(tableId, req, customerKey, storeId = 1) {
  const key = normalizeCustomerKey(customerKey) || randomToken(18);
  const ip = clientIp(req);
  const uaHash = hashUserAgent(req);

  const existing = await db.query(
    `SELECT id, session_token, customer_key, expires_at
      FROM customer_order_sessions
      WHERE store_id = $4
        AND table_id = $1
        AND customer_key = $2
        AND is_active = TRUE
        AND expires_at > NOW()
        AND (user_agent_hash IS NULL OR user_agent_hash = $3)
      ORDER BY last_seen_at DESC
      LIMIT 1`,
    [tableId, key, uaHash, storeId || 1]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    await db.query(
      `UPDATE customer_order_sessions
          SET last_seen_at = NOW(), last_ip = $2
        WHERE id = $1`,
      [row.id, ip || null]
    );
    return row;
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
  const { rows } = await db.query(
    `INSERT INTO customer_order_sessions
       (store_id, session_token, table_id, customer_key, first_ip, last_ip, user_agent_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7)
     RETURNING id, session_token, customer_key, expires_at`,
    [storeId || 1, randomToken(36), tableId, key, ip || null, uaHash, expiresAt]
  );
  logger.info('public-order', 'customer order session issued', {
    session_id: rows[0].id,
    table_id: tableId,
    ip,
  });
  return rows[0];
}

async function validateCustomerSession({ tableId, req, settings, customerKey, sessionToken, storeId = 1 }) {
  if (settings.ordering_require_session === false) {
    return { ok: true, session_id: null };
  }
  const key = normalizeCustomerKey(customerKey);
  const token = normalizeCustomerKey(sessionToken);
  if (!key || !token) {
    return { ok: false, status: 403, message: 'กรุณาสแกน QR ใหม่อีกครั้ง' };
  }

  const { rows } = await db.query(
    `SELECT id, user_agent_hash
      FROM customer_order_sessions
      WHERE session_token = $1
        AND store_id = $4
        AND table_id = $2
        AND customer_key = $3
        AND is_active = TRUE
        AND expires_at > NOW()
      LIMIT 1`,
    [token, tableId, key, storeId || 1]
  );
  const row = rows[0];
  const uaHash = hashUserAgent(req);
  if (!row || (row.user_agent_hash && uaHash && row.user_agent_hash !== uaHash)) {
    return { ok: false, status: 403, message: 'QR session ไม่ถูกต้อง กรุณาสแกนใหม่' };
  }

  await db.query(
    `UPDATE customer_order_sessions
        SET last_seen_at = NOW(), last_ip = $2
      WHERE id = $1`,
    [row.id, clientIp(req) || null]
  );
  return { ok: true, session_id: row.id };
}

module.exports = {
  customerKeyFromRequest,
  getPublicOrderState,
  getLocationAccessState,
  issueCustomerSession,
  isOrderingOpen,
  isPrivateIp,
  getNetworkAccessState,
  sessionTokenFromRequest,
  validateCustomerSession,
};

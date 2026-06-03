// Restaurant-wide settings: name, logo, currency, base_url for QR,
// auto-print flags. Singleton row id=1.
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { assertValidPaymentQrSettings } = require('../lib/thaiQrPayment');
const logger = require('../lib/logger');
const { isOrderingOpen } = require('../lib/publicOrderGuard');
const { resolveStoreId } = require('../lib/storeScope');

const router = express.Router();
const GPS_GUARD_LOCKED = (process.env.PUBLIC_ORDER_GPS_GUARD_LOCKED || 'false').toLowerCase() === 'true';
const GPS_GUARD_RADIUS_M = 20;

const SETTINGS_COLS = `
  id, name, logo, currency, base_url,
  auto_print_kitchen, auto_print_receipt,
  payment_qr_enabled, payment_qr_type, payment_qr_id, payment_qr_raw_payload,
  payment_qr_account_name, payment_qr_label, payment_qr_include_amount,
  payment_qr_ref1_prefix, payment_qr_ref2, payment_auto_close_enabled,
  ordering_enabled, ordering_open_time, ordering_close_time,
  ordering_timezone, ordering_days, ordering_require_session,
  ordering_require_private_ip, ordering_require_gps,
  ordering_shop_lat, ordering_shop_lng, ordering_max_distance_m,
  updated_at
`;

async function loadSettings(storeId = 1) {
  const { rows } = await db.query(`SELECT ${SETTINGS_COLS} FROM restaurant_settings WHERE id = 1`);
  if (rows[0]) return withOrderingStatus(applyRuntimeLocks(await overlayStoreSettings(rows[0], storeId)));
  // Fallback: insert defaults if missing (safety net for fresh DBs that
  // didn't run seed.sql).
  await db.query("INSERT INTO restaurant_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
  const r2 = await db.query(`SELECT ${SETTINGS_COLS} FROM restaurant_settings WHERE id = 1`);
  return withOrderingStatus(applyRuntimeLocks(await overlayStoreSettings(r2.rows[0], storeId)));
}

async function overlayStoreSettings(base, storeId = 1) {
  const id = Number(storeId || 1);
  if (!base) return base;
  try {
    const { rows } = await db.query(
      `SELECT name, logo, currency, public_base_url,
              ordering_enabled, ordering_open_time, ordering_close_time,
              ordering_timezone, ordering_days, ordering_require_session,
              ordering_require_private_ip, ordering_require_gps,
              ordering_shop_lat, ordering_shop_lng, ordering_max_distance_m
         FROM stores
        WHERE id = $1 AND is_active = TRUE`,
      [id]
    );
    const store = rows[0];
    if (!store) return base;
    return {
      ...base,
      name: store.name || base.name,
      logo: store.logo || base.logo,
      currency: store.currency || base.currency,
      base_url: store.public_base_url || base.base_url,
      ordering_enabled: store.ordering_enabled,
      ordering_open_time: store.ordering_open_time,
      ordering_close_time: store.ordering_close_time,
      ordering_timezone: store.ordering_timezone,
      ordering_days: store.ordering_days,
      ordering_require_session: store.ordering_require_session,
      ordering_require_private_ip: store.ordering_require_private_ip,
      ordering_require_gps: store.ordering_require_gps,
      ordering_shop_lat: store.ordering_shop_lat,
      ordering_shop_lng: store.ordering_shop_lng,
      ordering_max_distance_m: store.ordering_max_distance_m,
    };
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return base;
    throw e;
  }
}

function applyRuntimeLocks(row) {
  if (!row || !GPS_GUARD_LOCKED) return row;
  return {
    ...row,
    ordering_require_gps: true,
    ordering_require_private_ip: false,
    ordering_max_distance_m: GPS_GUARD_RADIUS_M,
  };
}

function minutesToClock(value) {
  if (!Number.isFinite(value)) return null;
  const h = Math.floor(value / 60);
  const m = value % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function withOrderingStatus(row) {
  if (!row) return row;
  const schedule = isOrderingOpen(row);
  return {
    ...row,
    ordering_status: {
      open_now: schedule.open,
      reason: schedule.reason,
      local_day: schedule.local_day ?? null,
      local_time: minutesToClock(schedule.local_minute),
      server_time: new Date().toISOString(),
    },
  };
}

// Public — customer/web reads this for header rendering and auto-print flag.
router.get('/', async (req, res) => {
  const rawStoreId = req.headers['x-pos-store-id'] || req.query.store_id || 1;
  const storeId = Number(rawStoreId);
  res.json(await loadSettings(Number.isInteger(storeId) && storeId > 0 ? storeId : 1));
});

router.put('/', authRequired, requireRole('admin'), async (req, res) => {
  const {
    name,
    logo,
    currency,
    base_url,
    auto_print_kitchen,
    auto_print_receipt,
    payment_qr_enabled,
    payment_qr_type,
    payment_qr_id,
    payment_qr_raw_payload,
    payment_qr_account_name,
    payment_qr_label,
    payment_qr_include_amount,
    payment_qr_ref1_prefix,
    payment_qr_ref2,
    payment_auto_close_enabled,
    ordering_enabled,
    ordering_open_time,
    ordering_close_time,
    ordering_timezone,
    ordering_days,
    ordering_require_session,
    ordering_require_private_ip,
    ordering_require_gps,
    ordering_shop_lat,
    ordering_shop_lng,
    ordering_max_distance_m,
  } = req.body || {};

  const receiptAutoPrint = false;
  const storeId = resolveStoreId(req);
  const current = await loadSettings(storeId);
  const next = {
    ...current,
    ...(payment_qr_enabled !== undefined ? { payment_qr_enabled } : {}),
    ...(payment_qr_type !== undefined ? { payment_qr_type } : {}),
    ...(payment_qr_id !== undefined ? { payment_qr_id } : {}),
    ...(payment_qr_raw_payload !== undefined ? { payment_qr_raw_payload } : {}),
    ...(payment_qr_account_name !== undefined ? { payment_qr_account_name } : {}),
    ...(payment_qr_label !== undefined ? { payment_qr_label } : {}),
    ...(payment_qr_include_amount !== undefined ? { payment_qr_include_amount } : {}),
    ...(payment_qr_ref1_prefix !== undefined ? { payment_qr_ref1_prefix } : {}),
    ...(payment_qr_ref2 !== undefined ? { payment_qr_ref2 } : {}),
    ...(payment_auto_close_enabled !== undefined ? { payment_auto_close_enabled } : {}),
  };
  try {
    assertValidPaymentQrSettings(next);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  let normalizedOrdering;
  try {
    normalizedOrdering = normalizeOrderingInput({
      ordering_open_time,
      ordering_close_time,
      ordering_timezone,
      ordering_days,
      ordering_require_gps,
      ordering_shop_lat,
      ordering_shop_lng,
      ordering_max_distance_m,
    }, current);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  if (storeId !== 1) {
    const { rows } = await db.query(
      `UPDATE stores
          SET name = COALESCE($1, name),
              logo = COALESCE($2, logo),
              currency = COALESCE($3, currency),
              public_base_url = COALESCE($4, public_base_url),
              ordering_enabled = COALESCE($5, ordering_enabled),
              ordering_open_time = COALESCE($6::time, ordering_open_time),
              ordering_close_time = COALESCE($7::time, ordering_close_time),
              ordering_timezone = COALESCE(NULLIF($8, ''), ordering_timezone),
              ordering_days = COALESCE($9::int[], ordering_days),
              ordering_require_session = COALESCE($10, ordering_require_session),
              ordering_require_private_ip = COALESCE($11, ordering_require_private_ip),
              ordering_require_gps = COALESCE($12, ordering_require_gps),
              ordering_shop_lat = CASE WHEN $13::boolean THEN $14::double precision ELSE ordering_shop_lat END,
              ordering_shop_lng = CASE WHEN $15::boolean THEN $16::double precision ELSE ordering_shop_lng END,
              ordering_max_distance_m = COALESCE($17::int, ordering_max_distance_m),
              updated_at = NOW()
        WHERE id = $18
        RETURNING id`,
      [
        name, logo, currency, base_url,
        ordering_enabled,
        normalizedOrdering.ordering_open_time,
        normalizedOrdering.ordering_close_time,
        normalizedOrdering.ordering_timezone,
        normalizedOrdering.ordering_days,
        ordering_require_session,
        ordering_require_private_ip,
        normalizedOrdering.ordering_require_gps,
        normalizedOrdering.has_ordering_shop_lat,
        normalizedOrdering.ordering_shop_lat,
        normalizedOrdering.has_ordering_shop_lng,
        normalizedOrdering.ordering_shop_lng,
        normalizedOrdering.ordering_max_distance_m,
        storeId,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'store not found' });
    await db.query(
      `UPDATE restaurant_settings
          SET auto_print_kitchen = COALESCE($1, auto_print_kitchen),
              auto_print_receipt = COALESCE($2, auto_print_receipt),
              payment_qr_enabled = COALESCE($3, payment_qr_enabled),
              payment_qr_type = COALESCE(NULLIF($4, ''), payment_qr_type),
              payment_qr_id = COALESCE($5, payment_qr_id),
              payment_qr_raw_payload = COALESCE($6, payment_qr_raw_payload),
              payment_qr_account_name = COALESCE($7, payment_qr_account_name),
              payment_qr_label = COALESCE(NULLIF($8, ''), payment_qr_label),
              payment_qr_include_amount = COALESCE($9, payment_qr_include_amount),
              payment_qr_ref1_prefix = COALESCE(NULLIF($10, ''), payment_qr_ref1_prefix),
              payment_qr_ref2 = COALESCE($11, payment_qr_ref2),
              payment_auto_close_enabled = COALESCE($12, payment_auto_close_enabled),
              updated_at = NOW()
        WHERE id = 1`,
      [
        auto_print_kitchen, receiptAutoPrint,
        payment_qr_enabled, payment_qr_type, payment_qr_id, payment_qr_raw_payload,
        payment_qr_account_name, payment_qr_label, payment_qr_include_amount,
        payment_qr_ref1_prefix, payment_qr_ref2, payment_auto_close_enabled,
      ]
    );
    const updated = await loadSettings(storeId);
    logger.info('settings', 'store ordering settings updated', {
      store_id: storeId,
      ordering_enabled: updated.ordering_enabled,
      ordering_open_time: updated.ordering_open_time,
      ordering_close_time: updated.ordering_close_time,
      ordering_timezone: updated.ordering_timezone,
      ordering_require_gps: updated.ordering_require_gps,
      ordering_max_distance_m: updated.ordering_max_distance_m,
      ordering_open_now: updated.ordering_status?.open_now,
      ordering_reason: updated.ordering_status?.reason,
    });
    return res.json(updated);
  }

  const { rows } = await db.query(
    `UPDATE restaurant_settings
        SET name               = COALESCE($1, name),
            logo               = COALESCE($2, logo),
            currency           = COALESCE($3, currency),
            base_url           = COALESCE($4, base_url),
            auto_print_kitchen = COALESCE($5, auto_print_kitchen),
            auto_print_receipt = COALESCE($6, auto_print_receipt),
            payment_qr_enabled = COALESCE($7, payment_qr_enabled),
            payment_qr_type = COALESCE(NULLIF($8, ''), payment_qr_type),
            payment_qr_id = COALESCE($9, payment_qr_id),
            payment_qr_raw_payload = COALESCE($10, payment_qr_raw_payload),
            payment_qr_account_name = COALESCE($11, payment_qr_account_name),
            payment_qr_label = COALESCE(NULLIF($12, ''), payment_qr_label),
            payment_qr_include_amount = COALESCE($13, payment_qr_include_amount),
            payment_qr_ref1_prefix = COALESCE(NULLIF($14, ''), payment_qr_ref1_prefix),
            payment_qr_ref2 = COALESCE($15, payment_qr_ref2),
            payment_auto_close_enabled = COALESCE($16, payment_auto_close_enabled),
            ordering_enabled = COALESCE($17, ordering_enabled),
            ordering_open_time = COALESCE($18::time, ordering_open_time),
            ordering_close_time = COALESCE($19::time, ordering_close_time),
            ordering_timezone = COALESCE(NULLIF($20, ''), ordering_timezone),
            ordering_days = COALESCE($21::int[], ordering_days),
            ordering_require_session = COALESCE($22, ordering_require_session),
            ordering_require_private_ip = COALESCE($23, ordering_require_private_ip),
            ordering_require_gps = COALESCE($24, ordering_require_gps),
            ordering_shop_lat = CASE WHEN $25::boolean THEN $26::double precision ELSE ordering_shop_lat END,
            ordering_shop_lng = CASE WHEN $27::boolean THEN $28::double precision ELSE ordering_shop_lng END,
            ordering_max_distance_m = COALESCE($29::int, ordering_max_distance_m),
            updated_at = NOW()
      WHERE id = 1
      RETURNING ${SETTINGS_COLS}`,
    [
      name, logo, currency, base_url, auto_print_kitchen, receiptAutoPrint,
      payment_qr_enabled, payment_qr_type, payment_qr_id, payment_qr_raw_payload,
      payment_qr_account_name, payment_qr_label, payment_qr_include_amount,
      payment_qr_ref1_prefix, payment_qr_ref2, payment_auto_close_enabled,
      ordering_enabled,
      normalizedOrdering.ordering_open_time,
      normalizedOrdering.ordering_close_time,
      normalizedOrdering.ordering_timezone,
      normalizedOrdering.ordering_days,
      ordering_require_session,
      ordering_require_private_ip,
      normalizedOrdering.ordering_require_gps,
      normalizedOrdering.has_ordering_shop_lat,
      normalizedOrdering.ordering_shop_lat,
      normalizedOrdering.has_ordering_shop_lng,
      normalizedOrdering.ordering_shop_lng,
      normalizedOrdering.ordering_max_distance_m,
    ]
  );
  await db.query(
    `UPDATE stores
        SET name = COALESCE($1, name),
            logo = COALESCE($2, logo),
            currency = COALESCE($3, currency),
            public_base_url = COALESCE($4, public_base_url),
            ordering_enabled = COALESCE($5, ordering_enabled),
            ordering_open_time = COALESCE($6::time, ordering_open_time),
            ordering_close_time = COALESCE($7::time, ordering_close_time),
            ordering_timezone = COALESCE(NULLIF($8, ''), ordering_timezone),
            ordering_days = COALESCE($9::int[], ordering_days),
            ordering_require_session = COALESCE($10, ordering_require_session),
            ordering_require_private_ip = COALESCE($11, ordering_require_private_ip),
            ordering_require_gps = COALESCE($12, ordering_require_gps),
            ordering_shop_lat = CASE WHEN $13::boolean THEN $14::double precision ELSE ordering_shop_lat END,
            ordering_shop_lng = CASE WHEN $15::boolean THEN $16::double precision ELSE ordering_shop_lng END,
            ordering_max_distance_m = COALESCE($17::int, ordering_max_distance_m),
            updated_at = NOW()
      WHERE id = 1`,
    [
      name, logo, currency, base_url,
      ordering_enabled,
      normalizedOrdering.ordering_open_time,
      normalizedOrdering.ordering_close_time,
      normalizedOrdering.ordering_timezone,
      normalizedOrdering.ordering_days,
      ordering_require_session,
      ordering_require_private_ip,
      normalizedOrdering.ordering_require_gps,
      normalizedOrdering.has_ordering_shop_lat,
      normalizedOrdering.ordering_shop_lat,
      normalizedOrdering.has_ordering_shop_lng,
      normalizedOrdering.ordering_shop_lng,
      normalizedOrdering.ordering_max_distance_m,
    ]
  );
  const updated = await loadSettings(storeId);
  logger.info('settings', 'ordering settings updated', {
    ordering_enabled: updated.ordering_enabled,
    ordering_open_time: updated.ordering_open_time,
    ordering_close_time: updated.ordering_close_time,
    ordering_timezone: updated.ordering_timezone,
    ordering_require_gps: updated.ordering_require_gps,
    ordering_max_distance_m: updated.ordering_max_distance_m,
    ordering_open_now: updated.ordering_status?.open_now,
    ordering_reason: updated.ordering_status?.reason,
  });
  res.json(updated);
});

function normalizeFiniteNumber(value) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n;
}

function normalizeOrderingInput(input, current = {}) {
  const out = {};
  for (const key of ['ordering_open_time', 'ordering_close_time']) {
    if (input[key] === undefined) {
      out[key] = undefined;
      continue;
    }
    const value = String(input[key] || '').trim();
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(value)) {
      const e = new Error('invalid ordering time');
      e.status = 400;
      throw e;
    }
    out[key] = value.length === 5 ? `${value}:00` : value;
  }
  if (input.ordering_timezone !== undefined) {
    out.ordering_timezone = String(input.ordering_timezone || 'Asia/Bangkok').trim();
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: out.ordering_timezone }).format(new Date());
    } catch {
      const e = new Error('invalid ordering timezone');
      e.status = 400;
      throw e;
    }
  }
  if (input.ordering_days !== undefined) {
    if (!Array.isArray(input.ordering_days)) {
      const e = new Error('invalid ordering days');
      e.status = 400;
      throw e;
    }
    out.ordering_days = input.ordering_days
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    if (out.ordering_days.length === 0) {
      const e = new Error('ordering days required');
      e.status = 400;
      throw e;
    }
  }
  if (GPS_GUARD_LOCKED) {
    out.ordering_require_gps = true;
  } else if (input.ordering_require_gps !== undefined) {
    out.ordering_require_gps = !!input.ordering_require_gps;
  }

  out.has_ordering_shop_lat = input.ordering_shop_lat !== undefined;
  out.has_ordering_shop_lng = input.ordering_shop_lng !== undefined;
  out.ordering_shop_lat = normalizeFiniteNumber(input.ordering_shop_lat);
  out.ordering_shop_lng = normalizeFiniteNumber(input.ordering_shop_lng);
  if (Number.isNaN(out.ordering_shop_lat) || (out.ordering_shop_lat !== null && out.ordering_shop_lat !== undefined && Math.abs(out.ordering_shop_lat) > 90)) {
    const e = new Error('invalid shop latitude');
    e.status = 400;
    throw e;
  }
  if (Number.isNaN(out.ordering_shop_lng) || (out.ordering_shop_lng !== null && out.ordering_shop_lng !== undefined && Math.abs(out.ordering_shop_lng) > 180)) {
    const e = new Error('invalid shop longitude');
    e.status = 400;
    throw e;
  }
  if (GPS_GUARD_LOCKED) {
    out.ordering_max_distance_m = GPS_GUARD_RADIUS_M;
  } else if (input.ordering_max_distance_m !== undefined) {
    const distance = Number(input.ordering_max_distance_m);
    if (!Number.isFinite(distance) || distance < 1 || distance > 10000) {
      const e = new Error('invalid ordering GPS radius');
      e.status = 400;
      throw e;
    }
    out.ordering_max_distance_m = Math.round(distance);
  }

  const nextRequireGps = out.ordering_require_gps ?? !!current.ordering_require_gps;
  const nextLat = out.has_ordering_shop_lat ? out.ordering_shop_lat : normalizeFiniteNumber(current.ordering_shop_lat);
  const nextLng = out.has_ordering_shop_lng ? out.ordering_shop_lng : normalizeFiniteNumber(current.ordering_shop_lng);
  if (nextRequireGps && (nextLat === null || nextLat === undefined || nextLng === null || nextLng === undefined)) {
    const e = new Error('ต้องตั้งค่าพิกัดร้านก่อนเปิด GPS guard');
    e.status = 400;
    throw e;
  }
  return out;
}

module.exports = { router, loadSettings };

'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, apiBase } from '@/lib/api';
import { ensureSocketConnected } from '@/lib/socket';
import { useRealtimeRecovery } from '@/lib/realtimeRecovery';
import { storageGet, storageSet, storageJson } from '@/lib/browser';

export default function OrderPageWrapper() {
  return (
    <Suspense fallback={<main className="p-6 text-center text-gray-500">กำลังโหลด...</main>}>
      <OrderPage />
    </Suspense>
  );
}

// Mirrors the --pos-* design tokens in globals.css. Kept as literal hex here
// (not var()) because several styles derive alpha variants by string suffixing
// (e.g. `${GOLD}22`), which CSS variables cannot do. Change both together.
const NAVY = '#1c2342';   // --pos-navy-1
const NAVY2 = '#2c3567';  // --pos-navy-2
const BEIGE = '#f3f4fa';  // --pos-bg
const GOLD = '#f5b333';   // --pos-gold
const ORANGE = '#e85d04'; // --pos-accent
const ORANGE2 = '#c84f00';// --pos-accent-dark
const RED = '#e5476b';    // --pos-red
const GREEN = '#0fb98c';  // --pos-green

const STATUS_LABEL = {
  pending: '⏳ รอยืนยัน', cooking: '🍳 กำลังทำ', served: '✅ พร้อมเสิร์ฟ', paid: '💰 ชำระแล้ว', cancelled: '❌ ยกเลิก',
};
const STATUS_COLOR = {
  pending: RED, cooking: '#f5a623', served: GREEN, paid: '#aaa', cancelled: '#999',
};

function getOrCreateCustomerKey() {
  const existing = storageGet('pos_customer_key');
  if (existing) return existing;
  const key = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `ck_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  storageSet('pos_customer_key', key);
  return key;
}

function OrderPage() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('t');

  const [restaurant, setRestaurant] = useState({ name: 'POS V2', logo: '🍽️', currency: '฿' });
  const [table, setTable] = useState(null);
  const [menu, setMenu] = useState({ categories: [], products: [] });
  const [tableOrders, setTableOrders] = useState([]);
  const [cart, setCart] = useState({});
  const [activeCat, setActiveCat] = useState(null);
  const [tab, setTab] = useState('menu'); // menu | orders
  const [orderType, setOrderType] = useState('dine-in'); // dine-in | takeaway
  const [customerName, setCustomerName] = useState('');
  const [orderNote, setOrderNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [variantModal, setVariantModal] = useState(null); // product to pick variant for
  const [success, setSuccess] = useState(null);
  const [callState, setCallState] = useState('idle'); // idle | sending | sent
  const [customerKey, setCustomerKey] = useState(null);
  const [customerSessionToken, setCustomerSessionToken] = useState(null);
  const [ordering, setOrdering] = useState(null);
  const [customerLocation, setCustomerLocation] = useState(null);
  const [locationStatus, setLocationStatus] = useState('idle'); // idle | requesting | ready | denied
  const [locationError, setLocationError] = useState(null);

  // Bootstrap
  useEffect(() => {
    if (!token) { setError('ไม่พบรหัส QR ของโต๊ะ'); return; }
    const key = getOrCreateCustomerKey();
    setCustomerKey(key);
    Promise.all([api.getTable(token, key), api.getMenu(token)])
      .then(([t, m]) => {
        applyTableResponse(t, key);
        if (t?.is_takeaway) setOrderType('takeaway');
        setMenu({ categories: m.categories, products: m.products });
        if (m.restaurant) setRestaurant(m.restaurant);
        if (m.categories[0]) setActiveCat(m.categories[0].id);
      })
      .catch((e) => setError(e.message));
  }, [token]);

  // When staff/admin toggle product availability, refresh menu via the
  // proven useRealtimeRecovery hook (auto re-attach on socket rebuild +
  // polling fallback so the customer never gets stuck on a sold-out item).
  const reloadMenuForCustomer = useCallback(async () => {
    if (!token) return;
    try {
      const m = await api.getMenu(token);
      setMenu({ categories: m.categories, products: m.products });
    } catch (_e) { /* keep stale on fail */ }
  }, [token]);
  useRealtimeRecovery(reloadMenuForCustomer, {
    events: ['product:availability'],
    intervalMs: 8000,
    reloadOnMount: false,
  });

  // Poll table orders every 8s for the "ออเดอร์ของฉัน" tab
  useEffect(() => {
    if (!table) return;
    let alive = true;
    async function loadOrders() {
      try {
        // Order ids this phone placed live in localStorage; fetch them all in
        // one batch call instead of one request per order.
        const ids = storageJson(`pos_orders_${table.id}`, []);
        if (!ids.length) { if (alive) setTableOrders([]); return; }
        const res = await api.getTableOrders(token, ids);
        const orders = Array.isArray(res?.orders) ? res.orders : [];
        if (alive) setTableOrders(orders.filter((o) => o.status !== 'paid' && o.status !== 'cancelled'));
      } catch {}
    }
    loadOrders();
    // Pause polling while the tab is hidden — socket events + the next tick
    // after returning to the foreground keep the list fresh.
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      loadOrders();
    }, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [table, token]);

  const productsByCat = useMemo(() => {
    const map = new Map();
    for (const p of menu.products) {
      if (!map.has(p.category_id)) map.set(p.category_id, []);
      map.get(p.category_id).push(p);
    }
    return map;
  }, [menu.products]);

  const cartItems = Object.values(cart);
  const totalQty = cartItems.reduce((s, c) => s + c.quantity, 0);
  const totalPrice = cartItems.reduce((s, c) => s + Number(c.unitPrice) * c.quantity, 0);
  const grandTotal = tableOrders.reduce((s, o) => s + Number(o.total_amount), 0);
  const activeCount = tableOrders.filter((o) => o.status !== 'served').length;
  const isTakeawayPoint = !!table?.is_takeaway || String(table?.code || '').toUpperCase() === 'TAKEAWAY' || Number(table?.seats) === 0;
  const effectiveOrderType = isTakeawayPoint ? 'takeaway' : orderType;
  const cartFulfillmentTypes = new Set(cartItems.map((c) => isTakeawayPoint ? 'takeaway' : (c.fulfillmentType || effectiveOrderType)));
  const cartFulfillmentSummary = cartFulfillmentTypes.size > 1
    ? 'mixed'
    : (cartFulfillmentTypes.has('takeaway') ? 'takeaway' : effectiveOrderType);
  const orderingAllowed = ordering?.allowed !== false;
  const gpsRequired = !!ordering?.require_gps;
  const gpsBlocked = gpsRequired && ordering?.location_allowed === false;

  function applyTableResponse(t, fallbackKey = customerKey) {
    const nextKey = t.customer_key || fallbackKey || null;
    if (nextKey && nextKey !== customerKey) {
      storageSet('pos_customer_key', nextKey);
      setCustomerKey(nextKey);
    }
    setCustomerSessionToken(t.customer_session_token || null);
    setOrdering(t.ordering || null);
    setTable(t);
  }

  function geolocationPreflightMessage() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return 'เครื่องนี้ไม่รองรับ GPS ใน browser';
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      return 'GPS ต้องเปิดผ่าน HTTPS หรือ localhost เท่านั้น กรุณาใช้ลิงก์ HTTPS ของร้าน';
    }
    return null;
  }

  function requestCustomerLocation() {
    const preflight = geolocationPreflightMessage();
    if (preflight) return Promise.reject(new Error(preflight));
    setLocationStatus('requesting');
    setLocationError(null);
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          };
          setCustomerLocation(loc);
          setLocationStatus('ready');
          resolve(loc);
        },
        (err) => {
          const message = err?.code === 1
            ? 'กรุณาอนุญาตตำแหน่ง GPS ก่อนสั่งอาหาร'
            : 'อ่านตำแหน่ง GPS ไม่สำเร็จ กรุณาลองใหม่';
          setLocationStatus('denied');
          setLocationError(message);
          reject(new Error(message));
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
      );
    });
  }

  async function refreshTableWithLocation(location, keyOverride = customerKey) {
    const key = keyOverride || getOrCreateCustomerKey();
    const t = await api.getTable(token, key, location);
    applyTableResponse(t, key);
    return t;
  }

  async function ensureGpsReady() {
    if (!gpsRequired) return { ordering };
    if (ordering?.location_reason === 'wifi-lan-bypass') {
      return {
        ordering,
        customer_key: customerKey,
        customer_session_token: customerSessionToken,
      };
    }
    const loc = customerLocation || await requestCustomerLocation();
    const refreshed = await refreshTableWithLocation(loc);
    if (refreshed.ordering?.allowed === false) {
      throw new Error(refreshed.ordering?.reason || 'ตำแหน่งไม่ผ่านเงื่อนไขร้าน');
    }
    refreshed._gps_location = loc;
    return refreshed;
  }

  async function handleGpsRefresh() {
    setError(null);
    try {
      const loc = await requestCustomerLocation();
      await refreshTableWithLocation(loc);
    } catch (e) {
      setError(e.message);
    }
  }

  // A cart key unique per (product, variant, options-combo). Same dish with
  // different option picks (น้ำ vs แห้ง) becomes a separate line item.
  function cartKey(productId, variantName, optionsSelected, fulfillmentType = effectiveOrderType) {
    const opts = (optionsSelected || []).map((o) => `${o.group}=${o.value}`).join('|');
    return [productId, variantName || '', opts, fulfillmentType].join('::');
  }

  function optionPriceDelta(optionsSelected = []) {
    return optionsSelected.reduce((sum, option) => sum + Number(option.price_delta || 0), 0);
  }

  function addToCart(product, variantName = null, optionsSelected = null, itemNote = '', quantity = 1) {
    const addQty = Math.max(1, Math.min(99, Math.floor(Number(quantity) || 1)));
    const fulfillmentType = isTakeawayPoint ? 'takeaway' : effectiveOrderType;
    const unitPrice = variantName
      ? (product.variants?.find((v) => v.name === variantName)?.price ?? product.price)
      : product.price;
    const finalUnitPrice = Number(unitPrice) + optionPriceDelta(optionsSelected || []);
    setCart((prev) => {
      const key = cartKey(product.id, variantName, optionsSelected, fulfillmentType);
      const cur = prev[key];
      return { ...prev, [key]: {
        key,
        productId: product.id, name: product.name, emoji: product.emoji || '',
        unitPrice: finalUnitPrice, variantName,
        optionsSelected: optionsSelected || [],
        fulfillmentType,
        quantity: (cur?.quantity || 0) + addQty,
        note: cur?.note || itemNote || '',
      }};
    });
  }

  function setQty(key, qty) {
    const nextQty = Math.floor(Number(qty) || 0);
    setCart((prev) => {
      if (nextQty <= 0) { const { [key]: _g, ...rest } = prev; return rest; }
      return { ...prev, [key]: { ...prev[key], quantity: Math.min(99, nextQty) } };
    });
  }

  function setItemNote(key, note) {
    setCart((prev) => prev[key] ? { ...prev, [key]: { ...prev[key], note } } : prev);
  }

  function setItemFulfillment(key, type) {
    if (isTakeawayPoint) return;
    const nextType = type === 'takeaway' ? 'takeaway' : 'dine-in';
    setCart((prev) => {
      const current = prev[key];
      if (!current) return prev;
      const nextKey = cartKey(current.productId, current.variantName, current.optionsSelected, nextType);
      const { [key]: _removed, ...rest } = prev;
      const existing = rest[nextKey];
      if (existing) {
        return {
          ...rest,
          [nextKey]: {
            ...existing,
            quantity: Math.min(99, existing.quantity + current.quantity),
            note: existing.note || current.note,
          },
        };
      }
      return { ...rest, [nextKey]: { ...current, key: nextKey, fulfillmentType: nextType } };
    });
  }

  // Open the picker modal whenever the product needs the customer to make a
  // choice — either a paid variant (size) or a free option group (mutex).
  function onAddProduct(p) {
    const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
    const hasOptions = Array.isArray(p.options) && p.options.length > 0;
    if (hasVariants || hasOptions) {
      setVariantModal(p);
    } else {
      addToCart(p);
    }
  }

  async function submit() {
    if (isTakeawayPoint && !customerName.trim()) {
      setError('กรุณาใส่ชื่อสำหรับออเดอร์สั่งกลับบ้าน');
      return;
    }
    setSubmitting(true); setError(null);
    try {
      let liveCustomerKey = customerKey;
      let liveSessionToken = customerSessionToken;
      let liveOrdering = ordering;
      let liveLocation = customerLocation;
      if (gpsRequired) {
        const refreshed = await ensureGpsReady();
        liveOrdering = refreshed.ordering || liveOrdering;
        liveCustomerKey = refreshed.customer_key || liveCustomerKey;
        liveSessionToken = refreshed.customer_session_token || liveSessionToken;
        liveLocation = refreshed._gps_location || liveLocation;
      }
      if (liveOrdering?.allowed === false) {
        throw new Error(liveOrdering?.reason || 'ร้านยังไม่เปิดรับออเดอร์');
      }
      const items = cartItems.map((c) => ({
        product_id: c.productId, quantity: c.quantity,
        variant_name: c.variantName || undefined,
        options_selected: (c.optionsSelected && c.optionsSelected.length)
          ? c.optionsSelected : undefined,
        fulfillment_type: isTakeawayPoint ? 'takeaway' : (c.fulfillmentType || effectiveOrderType),
        note: c.note?.trim() || undefined,
      }));
      const order = await api.placeOrder(token, items, orderNote || undefined,
        {
          order_type: effectiveOrderType,
          customer_name: customerName || undefined,
          customer_key: liveCustomerKey,
          customer_session_token: liveSessionToken,
          customer_location: liveLocation,
        });
      // Track per-table for "my orders" tab
      const ids = storageJson(`pos_orders_${table.id}`, []);
      ids.push(order.id);
      storageSet(`pos_orders_${table.id}`, JSON.stringify(ids.slice(-30)));
      setCart({}); setOrderNote('');
      setSuccess(order);
      setTab('orders');
      // Refresh orders
      setTableOrders((prev) => [...prev, order]);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCallStaff() {
    if (callState !== 'idle' || !token) return;
    setCallState('sending');
    try {
      await api.callStaff(token, 'bill');
      setCallState('sent');
      // Re-enable after a cooldown so staff aren't spammed but the guest can
      // call again if no one comes.
      setTimeout(() => setCallState('idle'), 30000);
    } catch (e) {
      setError(e.message);
      setCallState('idle');
    }
  }

  if (error && !table) {
    return (
      <main className="max-w-md mx-auto p-6 text-center" style={{ background: BEIGE, minHeight: 'var(--app-height, 100vh)' }}>
        <h1 className="text-xl font-bold text-red-600 mb-3">เกิดข้อผิดพลาด</h1>
        <p>{error}</p>
      </main>
    );
  }
  if (!table) return <main className="p-6 text-center text-gray-500">กำลังโหลด...</main>;

  const cats = menu.categories.filter(() => true);
  const activeProducts = productsByCat.get(activeCat) || [];

  return (
    <main className="customer-order-shell" style={{ paddingBottom: totalQty > 0 ? 430 : 24 }}>
      {/* Header navy gradient */}
      <div style={{
        background: `radial-gradient(560px 240px at 90% -40%, rgba(232,93,4,.35), transparent 65%), linear-gradient(135deg, #181e3a, ${NAVY2})`,
        color: 'white', padding: '20px 18px 26px', position: 'relative', overflow: 'hidden',
        borderRadius: '0 0 24px 24px',
      }}>
        <div style={{
          position: 'absolute', top: -30, right: -30, width: 150, height: 150,
          borderRadius: '50%', background: 'rgba(245,179,51,.1)', pointerEvents: 'none',
        }} />
        <div style={{ fontSize: 11, opacity: .55, letterSpacing: 3, marginBottom: 8 }}>
          {esc(restaurant.name).toUpperCase()}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontSize: 28, width: 54, height: 54, display: 'grid', placeItems: 'center',
            background: 'rgba(255,255,255,.1)', borderRadius: 16,
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.14)',
          }}>{restaurant.logo || '🍽️'}</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 21, letterSpacing: .2 }}>{restaurant.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
              {effectiveOrderType === 'takeaway' ? (
                <>
                  <span style={{
                    background: 'rgba(232,93,4,.3)', color: '#ffb380',
                    borderRadius: 999, padding: '3px 12px', fontSize: 12, fontWeight: 700,
                    boxShadow: 'inset 0 0 0 1px rgba(232,93,4,.4)',
                  }}>🛍️ กลับบ้าน</span>
                  <span style={{ opacity: .75, fontSize: 13 }}>{customerName || table.name}</span>
                </>
              ) : (
                <span style={{
                  background: 'rgba(255,255,255,.12)', borderRadius: 999,
                  padding: '3px 12px', fontSize: 12.5, fontWeight: 600, opacity: .95,
                  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16)',
                }}>🪑 {table.name}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Ordering guard status */}
      {!orderingAllowed && (
        <div role="alert" style={{
          background: '#fff0f0', border: `1.5px solid ${RED}55`,
          margin: '10px 14px 0', borderRadius: 12, padding: '12px 14px',
          color: '#b4232e', fontSize: 13, fontWeight: 700,
        }}>
          {gpsBlocked ? 'ต้องยืนยันตำแหน่งในร้านก่อนสั่ง' : 'ร้านยังไม่เปิดรับออเดอร์'}
          <div style={{ color: '#8a1f29', opacity: .75, fontSize: 12, fontWeight: 500, marginTop: 3 }}>
            {ordering?.reason || 'กรุณาสั่งในเวลาเปิดร้าน'}
            {ordering?.open_time && ordering?.close_time ? ` · ${ordering.open_time.slice(0, 5)}-${ordering.close_time.slice(0, 5)}` : ''}
          </div>
          {gpsBlocked && (
            <button type="button" onClick={handleGpsRefresh}
              disabled={locationStatus === 'requesting'}
              style={{
                marginTop: 9, width: '100%', border: 'none', borderRadius: 10,
                background: NAVY, color: 'white', padding: '9px 12px',
                fontWeight: 800, cursor: locationStatus === 'requesting' ? 'wait' : 'pointer',
                opacity: locationStatus === 'requesting' ? .6 : 1,
              }}>
              {locationStatus === 'requesting' ? 'กำลังอ่าน GPS...' : '📍 อนุญาตตำแหน่ง GPS'}
            </button>
          )}
          {locationError && (
            <div style={{ color: '#8a1f29', fontSize: 12, fontWeight: 600, marginTop: 6 }}>
              {locationError}
            </div>
          )}
        </div>
      )}

      {gpsRequired && (
        <div style={{
          background: ordering?.location_allowed === false ? '#fff8e7' : '#ecfff8',
          border: `1.5px solid ${ordering?.location_allowed === false ? GOLD : GREEN}55`,
          margin: '10px 14px 0', borderRadius: 12, padding: '10px 14px',
          color: ordering?.location_allowed === false ? '#8a5c00' : '#05795c',
          fontSize: 12, fontWeight: 700,
        }}>
          {ordering?.location_reason === 'wifi-lan-bypass'
            ? `📶 ใช้ WiFi ร้าน · ไม่ต้องยืนยัน GPS · กติกา GPS ${ordering?.max_distance_m ?? 20}m`
            : ordering?.location_allowed === false
              ? `📍 ต้องอยู่ไม่เกิน ${ordering?.max_distance_m ?? 20}m จากร้าน`
              : `📍 GPS ผ่าน · ระยะ ${ordering?.distance_m ?? '-'}m / ${ordering?.max_distance_m ?? 20}m`}
          {ordering?.accuracy_m != null && ordering?.location_reason !== 'wifi-lan-bypass' && (
            <div style={{ opacity: .72, fontSize: 11, fontWeight: 600, marginTop: 2 }}>
              ความแม่นยำ GPS ประมาณ {ordering.accuracy_m}m
            </div>
          )}
        </div>
      )}

      {/* Status bar (clickable → orders tab) */}
      {tableOrders.length > 0 && (
        <div onClick={() => setTab('orders')}
             style={{
               background: activeCount > 0 ? `${GOLD}22` : `${GREEN}22`,
               border: `1.5px solid ${activeCount > 0 ? GOLD + '55' : GREEN + '55'}`,
               margin: '10px 14px 0', borderRadius: 12, padding: '10px 14px',
               display: 'flex', alignItems: 'center', justifyContent: 'space-between',
               cursor: 'pointer',
             }}>
          <span style={{ fontSize: 13, color: activeCount > 0 ? '#b8860b' : '#05a07a', fontWeight: 700 }}>
            {activeCount > 0 ? `⏳ ${activeCount} รอบกำลังดำเนินการ` : `✅ ออเดอร์ทุกรอบเสร็จแล้ว`}
          </span>
          <span style={{ fontSize: 13, fontWeight: 800, color: activeCount > 0 ? '#b8860b' : '#05a07a', whiteSpace: 'nowrap' }}>
            {restaurant.currency}{grandTotal.toFixed(0)}{' '}
            <span style={{ fontWeight: 500, opacity: .7, fontSize: 12 }}>ดูรายละเอียด ›</span>
          </span>
        </div>
      )}

      {/* Call staff to collect the bill */}
      {tableOrders.length > 0 && (
        <div style={{ margin: '10px 14px 0' }}>
          <button
            type="button"
            onClick={handleCallStaff}
            disabled={callState !== 'idle'}
            aria-label="เรียกพนักงานมาเก็บเงินที่โต๊ะ"
            style={{
              width: '100%', minHeight: 52, border: 'none', borderRadius: 14,
              background: callState === 'sent'
                ? `linear-gradient(135deg, ${GREEN}, #077a5d)`
                : `linear-gradient(135deg, ${NAVY}, ${NAVY2})`,
              color: '#fff', fontWeight: 800, fontSize: 15.5,
              cursor: callState === 'idle' ? 'pointer' : 'default',
              opacity: callState === 'sending' ? 0.7 : 1,
              boxShadow: '0 8px 20px rgba(28,35,66,.28)',
              transition: 'background .2s ease',
            }}>
            {callState === 'sent'
              ? '✅ เรียกแล้ว พนักงานกำลังไป'
              : callState === 'sending'
                ? 'กำลังเรียก...'
                : '🔔 เรียกพนักงานเก็บเงิน'}
          </button>
        </div>
      )}

      {/* Tab card */}
      <div className="customer-tab-card">
        {tableOrders.length > 0 && (
          <div style={{ display: 'flex', borderBottom: '1.5px solid #f0f0f0' }}>
            <TabBtn active={tab === 'menu'} onClick={() => setTab('menu')}>🍽️ เมนู</TabBtn>
            <TabBtn active={tab === 'orders'} onClick={() => setTab('orders')} badge={tableOrders.length}>
              📋 ออเดอร์ของฉัน
            </TabBtn>
          </div>
        )}

        {tab === 'menu' && (
          <div className="customer-category-rail">
            {cats.map((c) => {
              const active = activeCat === c.id;
              return (
                <button key={c.id} onClick={() => setActiveCat(c.id)}
                  className={`customer-category-pill${active ? ' is-active' : ''}`}>
                  {c.icon || ''} {c.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Tab content */}
      {tab === 'menu' && (
        <div className="customer-menu-list">
          {activeProducts.length === 0 && (
            <div style={{ textAlign: 'center', opacity: .4, padding: 40, fontSize: 15 }}>
              ไม่มีเมนูในหมวดนี้
            </div>
          )}
          {activeProducts.map((p) => {
            const totalQtyForP = cartItems
              .filter((c) => c.productId === p.id)
              .reduce((s, c) => s + c.quantity, 0);
            return (
              <div key={p.id} className="customer-menu-row">
                {p.image_url ? (
                  <img src={`${apiBase}${p.image_url}`} alt={p.name}
                    className="customer-menu-image" />
                ) : (
                  <div className="customer-menu-emoji">
                    {p.emoji || '🍽️'}
                  </div>
                )}
                <div className="customer-menu-info">
                  <div className="customer-menu-title-row">
                    <span className="customer-menu-title">{p.name}</span>
                    {p.is_popular && (
                      <span className="customer-popular-badge">🔥 ยอดนิยม</span>
                    )}
                  </div>
                  {p.description && (
                    <div className="customer-menu-description">{p.description}</div>
                  )}
                  {p.variants && p.variants.length > 0 && (
                    <div className="customer-menu-variants">
                      📐 {p.variants.map((v) => `${v.name} ${restaurant.currency}${v.price}`).join(' · ')}
                    </div>
                  )}
                  <div className="customer-menu-price">
                    {restaurant.currency}{p.price}
                  </div>
                </div>
                <div className="customer-menu-action">
                  {totalQtyForP > 0 && (
                    <span className="customer-menu-qty">
                      ×{totalQtyForP}
                    </span>
                  )}
                  <button onClick={() => onAddProduct(p)}
                    disabled={!orderingAllowed}
                    className="customer-menu-add"
                    aria-label={`เพิ่ม ${p.name} ลงตะกร้า`}
                    style={{ opacity: orderingAllowed ? 1 : .35 }}>+</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'orders' && tableOrders.length > 0 && (
        <div style={{ padding: 14 }}>
          {tableOrders.map((o) => (
            <div key={o.id} style={{
              background: 'white', borderRadius: 16, padding: 14, marginBottom: 12,
              boxShadow: '0 2px 10px rgba(0,0,0,.07)',
              borderLeft: `4px solid ${STATUS_COLOR[o.status] || '#aaa'}`,
              ...(((o.fulfillment_summary || o.order_type) === 'mixed' || o.order_type === 'takeaway') && { border: `2px solid ${ORANGE}` }),
            }}>
              {(o.fulfillment_summary || o.order_type) === 'mixed' ? (
                <div style={{
                  background: `linear-gradient(135deg, ${NAVY}, ${ORANGE})`, color: 'white',
                  borderRadius: 9, padding: '7px 12px', marginBottom: 10,
                  fontWeight: 800, fontSize: 14,
                }}>🍽️ + 🛍️ ทานที่ร้านและกลับบ้าน</div>
              ) : o.order_type === 'takeaway' ? (
                <div style={{
                  background: `linear-gradient(135deg, ${ORANGE}, ${ORANGE2})`, color: 'white',
                  borderRadius: 9, padding: '7px 12px', marginBottom: 10,
                  fontWeight: 800, fontSize: 14,
                }}>🛍️ สั่งกลับบ้าน{o.customer_name ? ` · ${o.customer_name}` : ''}</div>
              ) : (
                <div style={{
                  background: '#e8f4fd', color: '#2980b9', borderRadius: 9,
                  padding: '7px 12px', marginBottom: 10, fontWeight: 700, fontSize: 13,
                }}>🍽️ ทานที่ร้าน</div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: '#bbb' }}>
                  🕐 {new Date(o.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 700,
                  background: `${STATUS_COLOR[o.status]}18`, color: STATUS_COLOR[o.status],
                  borderRadius: 20, padding: '4px 12px',
                }}>{STATUS_LABEL[o.status] || o.status}</span>
              </div>
              {o.items.map((it) => (
                <div key={it.id} style={{ padding: '6px 0', borderBottom: '1px solid #f5f5f5', fontSize: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ flex: 1 }}>
                      {it.product_name}{it.variant_name ? ` (${it.variant_name})` : ''}
                      <span style={{ color: '#ccc' }}> ×{it.quantity}</span>
                    </span>
                    <span style={{ fontWeight: 700 }}>{restaurant.currency}{(Number(it.unit_price) * it.quantity).toFixed(0)}</span>
                  </div>
                  {Array.isArray(it.options_selected) && it.options_selected.length > 0 && (
                    <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                      {it.options_selected.map((o, idx) =>
                        <span key={idx}>{idx > 0 ? ' · ' : ''}{o.value}</span>
                      )}
                    </div>
                  )}
                  {it.note && (
                    <div style={{
                      marginTop: 3, fontSize: 12, color: ORANGE, fontWeight: 600,
                      background: '#fff8f0', borderRadius: 6, padding: '3px 8px', display: 'inline-block',
                    }}>📝 {it.note}</div>
                  )}
                  <span style={{
                    display: 'inline-block', marginTop: 4, marginRight: 6,
                    fontSize: 11, fontWeight: 800,
                    color: (it.fulfillment_type || o.order_type) === 'takeaway' ? ORANGE2 : '#2980b9',
                    background: (it.fulfillment_type || o.order_type) === 'takeaway' ? '#fff4e8' : '#e8f4fd',
                    borderRadius: 999, padding: '2px 8px',
                  }}>
                    {(it.fulfillment_type || o.order_type) === 'takeaway' ? '🛍️ กลับบ้าน' : '🍽️ ทานที่ร้าน'}
                  </span>
                </div>
              ))}
              {o.note && (
                <div style={{
                  marginTop: 8, fontSize: 12, background: '#fff8e1',
                  borderRadius: 7, padding: '5px 9px', color: '#856404',
                }}>📝 {o.note}</div>
              )}
              <div style={{ textAlign: 'right', fontWeight: 800, fontSize: 14, marginTop: 8, color: NAVY }}>
                รวม {restaurant.currency}{Number(o.total_amount).toFixed(0)}
              </div>
            </div>
          ))}

          <div style={{
            background: `linear-gradient(135deg, ${NAVY}, ${NAVY2})`, color: 'white',
            borderRadius: 16, padding: 16, display: 'flex',
            justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div style={{ fontSize: 13, opacity: .6 }}>💰 ยอดรวมทั้งหมด</div>
              <div style={{ fontSize: 11, opacity: .4, marginTop: 2 }}>
                {tableOrders.length} รอบ · {tableOrders.reduce((s, o) => s + o.items.reduce((ss, it) => ss + it.quantity, 0), 0)} รายการ
              </div>
            </div>
            <div style={{ fontSize: 24, fontWeight: 900, color: GOLD }}>
              {restaurant.currency}{grandTotal.toFixed(0)}
            </div>
          </div>

          <button onClick={() => setTab('menu')}
            style={{
              marginTop: 12, width: '100%',
              background: `linear-gradient(135deg, ${NAVY}, #203a43)`, color: 'white',
              border: 'none', borderRadius: 13, padding: 14, fontWeight: 700, fontSize: 15,
            }}>🍽️ สั่งอาหารเพิ่ม</button>
        </div>
      )}

      {/* Cart bottom bar */}
      {tab === 'menu' && totalQty > 0 && (
        <div style={{
          position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
          width: '100%', maxWidth: 480, padding: '12px 14px 18px',
          background: 'rgba(255,255,255,.97)', backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          borderRadius: '22px 22px 0 0', border: '1px solid #e6e8f2', borderBottom: 'none',
          boxShadow: '0 -10px 36px rgba(24,28,52,.16)', zIndex: 50,
        }}>
          {isTakeawayPoint ? (
            <div style={{
              marginBottom: 9, background: '#fff4e8', color: ORANGE2,
              border: `1.5px solid ${ORANGE}55`, borderRadius: 10,
              padding: '9px 12px', fontSize: 13, fontWeight: 800,
            }}>
              🛍️ จุดสั่งกลับบ้าน · ไม่ต้องเลือกโต๊ะ
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, marginBottom: 9, background: '#f3f3f3', borderRadius: 10, padding: 4 }}>
              <ToggleBtn active={orderType === 'dine-in'} onClick={() => setOrderType('dine-in')}
                activeBg={NAVY} activeColor="white">🍽️ ทานที่ร้าน</ToggleBtn>
              <ToggleBtn active={orderType === 'takeaway'} onClick={() => setOrderType('takeaway')}
                activeBg={ORANGE} activeColor="white">🛍️ กลับบ้าน</ToggleBtn>
            </div>
          )}
          {isTakeawayPoint && (
            <input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="ชื่อสำหรับเรียก (จำเป็น)"
              style={{
                width: '100%', border: `1.5px solid ${ORANGE}`, borderRadius: 10,
                padding: '8px 12px', fontSize: 13, marginBottom: 9, outline: 'none', boxSizing: 'border-box',
              }}
            />
          )}
          <div style={{ maxHeight: 142, overflowY: 'auto', marginBottom: 9 }}>
            {cartItems.map((c) => (
              <div key={c.key} style={{
                border: '1px solid #f0f0f0', borderRadius: 10, padding: 8,
                marginBottom: 6, background: '#fffdf9',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, fontWeight: 700, color: NAVY }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.name}{c.variantName ? ` (${c.variantName})` : ''}
                  </span>
                  <span>{restaurant.currency}{(Number(c.unitPrice) * c.quantity).toFixed(0)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 7 }}>
                  <button type="button"
                    onClick={() => setQty(c.key, c.quantity - 1)}
                    style={{
                      width: 30, height: 30, borderRadius: 8, border: '1px solid #e8e8e8',
                      background: '#fafafa', color: NAVY, fontWeight: 900, fontSize: 16,
                    }}>-</button>
                  <input
                    type="number"
                    min="1"
                    max="99"
                    inputMode="numeric"
                    value={c.quantity}
                    onChange={(e) => {
                      if (e.target.value === '') return;
                      setQty(c.key, e.target.value);
                    }}
                    style={{
                      width: 64, height: 30, border: '1.5px solid #e8e8e8', borderRadius: 8,
                      textAlign: 'center', fontWeight: 800, color: NAVY, outline: 'none',
                    }}
                  />
                  <button type="button"
                    onClick={() => setQty(c.key, c.quantity + 1)}
                    style={{
                      width: 30, height: 30, borderRadius: 8, border: '1px solid #e8e8e8',
                      background: NAVY, color: 'white', fontWeight: 900, fontSize: 16,
                    }}>+</button>
                </div>
                {Array.isArray(c.optionsSelected) && c.optionsSelected.length > 0 && (
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {c.optionsSelected.map((o) => o.value).join(' · ')}
                  </div>
                )}
                {!isTakeawayPoint && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 6, background: '#f4f4f4', borderRadius: 8, padding: 3 }}>
                    <ToggleBtn
                      active={(c.fulfillmentType || 'dine-in') === 'dine-in'}
                      onClick={() => setItemFulfillment(c.key, 'dine-in')}
                      activeBg={NAVY}
                      activeColor="white"
                    >🍽️ ทานที่ร้าน</ToggleBtn>
                    <ToggleBtn
                      active={c.fulfillmentType === 'takeaway'}
                      onClick={() => setItemFulfillment(c.key, 'takeaway')}
                      activeBg={ORANGE}
                      activeColor="white"
                    >🛍️ กลับบ้าน</ToggleBtn>
                  </div>
                )}
                <input
                  value={c.note || ''}
                  onChange={(e) => setItemNote(c.key, e.target.value)}
                  placeholder="คำอธิบายเพิ่มเติม เช่น ไม่ใส่ผัก แยกน้ำซุป"
                  style={{
                    width: '100%', border: '1px solid #eee', borderRadius: 8,
                    padding: '7px 9px', fontSize: 12, marginTop: 6,
                    outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
            ))}
          </div>
          <textarea
            value={orderNote}
            onChange={(e) => setOrderNote(e.target.value)}
            placeholder="หมายเหตุรวมของออเดอร์"
            style={{
              width: '100%', border: '1.5px solid #eee', borderRadius: 10,
              padding: '8px 12px', fontSize: 13, resize: 'none', height: 40, marginBottom: 9,
              outline: 'none', boxSizing: 'border-box',
            }}
          />
          {error && <p role="alert" style={{ color: 'red', fontSize: 12, margin: '0 0 6px' }}>{error}</p>}
          <button
            disabled={submitting || cartItems.length === 0 || !orderingAllowed}
            onClick={submit}
            style={{
              width: '100%',
              background: cartFulfillmentSummary === 'takeaway' || cartFulfillmentSummary === 'mixed'
                ? `linear-gradient(135deg, ${ORANGE}, #f0750f)`
                : `linear-gradient(135deg, ${NAVY}, ${NAVY2})`,
              color: 'white', border: 'none', borderRadius: 14, padding: '15px 16px',
              fontWeight: 800, fontSize: 15.5, display: 'flex', justifyContent: 'space-between',
              cursor: orderingAllowed ? 'pointer' : 'not-allowed',
              opacity: submitting || !orderingAllowed ? .5 : 1,
              boxShadow: cartFulfillmentSummary === 'takeaway' || cartFulfillmentSummary === 'mixed'
                ? '0 10px 24px rgba(232,93,4,.35)'
                : '0 10px 24px rgba(28,35,66,.35)',
            }}>
            <span>{cartFulfillmentSummary === 'mixed' ? '🍽️ + 🛍️ ยืนยันออเดอร์' : cartFulfillmentSummary === 'takeaway' ? '🛍️ สั่งกลับบ้าน' : '🛒 ยืนยันออเดอร์'} · {totalQty} รายการ</span>
            <span>{restaurant.currency}{totalPrice.toFixed(0)}</span>
          </button>
        </div>
      )}

      {/* Variant + option groups picker modal */}
      {variantModal && (
        <ProductPicker
          product={variantModal}
          currency={restaurant.currency}
          onCancel={() => setVariantModal(null)}
          onConfirm={(variantName, optionsSelected, itemNote, quantity) => {
            addToCart(variantModal, variantName, optionsSelected, itemNote, quantity);
            setVariantModal(null);
          }}
        />
      )}
    </main>
  );
}

// Modal that lets the customer pick a variant (size) and one choice per
// option group (mutex within group). Confirms only when every defined group
// has a selection.
//
// When the product has any variants we ALSO surface the base price as a
// synthetic "ธรรมดา" choice — so the customer always sees ธรรมดา ฿30 alongside
// พิเศษ ฿40, matching how Thai noodle menus actually work. Selecting ธรรมดา
// stores `variantName=null` (so order_items.variant_name stays NULL — the
// existing display logic already hides empty variant suffixes).
function ProductPicker({ product, currency, onCancel, onConfirm }) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const groups = Array.isArray(product.options) ? product.options.map((g, idx) => {
    const rawItems = Array.isArray(g.items) ? g.items : (g.choices || []).map((name) => ({ name }));
    const items = rawItems.map((it, itemIdx) => ({
      name: String(it.name ?? it.value ?? it),
      price_delta: Number(it.price_delta || it.extra_price || 0),
      is_default: !!it.is_default || (g.default_values || []).includes(String(it.name ?? it.value ?? it)),
      is_available: it.is_available !== false,
      sort_order: it.sort_order ?? itemIdx,
    })).filter((it) => it.name && it.is_available);
    const type = g.type === 'multiple' || g.selection_type === 'multiple' || g.mutex === false ? 'multiple' : 'single';
    const required = g.required ?? g.is_required ?? true;
    return {
      name: g.name,
      type,
      required: !!required,
      min_select: Number(g.min_select ?? g.min ?? (required ? 1 : 0)),
      max_select: type === 'single' ? 1 : Number((g.max_select ?? g.max ?? items.length) || 1),
      visible_when: g.visible_when || null,
      sort_order: g.sort_order ?? idx,
      items,
    };
  }).filter((g) => g.name && g.items.length > 0).sort((a, b) => a.sort_order - b.sort_order) : [];
  const variantOptions = variants.length > 0
    ? [
        { id: '__base__', label: 'ธรรมดา', price: product.price, variantName: null },
        ...variants.map((v) => ({ id: v.name, label: v.name, price: v.price, variantName: v.name })),
      ]
    : [];
  const initialPicks = {};
  for (const g of groups) {
    const defaults = g.items.filter((it) => it.is_default).map((it) => it.name);
    if (defaults.length) initialPicks[g.name] = g.type === 'single' ? defaults.slice(0, 1) : defaults.slice(0, g.max_select);
  }
  const [variantId, setVariantId] = useState(variantOptions[0]?.id ?? null);
  const [picks, setPicks] = useState(initialPicks);  // { [groupName]: [choice] }
  const [note, setNote] = useState('');
  const [quantity, setQuantity] = useState(1);
  const selectedVariant = variantOptions.find((v) => v.id === variantId);
  const variantName = selectedVariant?.variantName ?? null;
  const baseUnitPrice = Number(selectedVariant?.price ?? product.price);
  function isVisible(group) {
    if (!group.visible_when?.group) return true;
    const selected = picks[group.visible_when.group] || [];
    const expected = group.visible_when.values || (group.visible_when.value ? [group.visible_when.value] : []);
    return selected.some((value) => expected.includes(value));
  }
  const visibleGroups = groups.filter(isVisible);
  function selectedItems(group) {
    const selectedNames = picks[group.name] || [];
    return group.items.filter((it) => selectedNames.includes(it.name));
  }
  function togglePick(group, item) {
    setPicks((prev) => {
      const current = prev[group.name] || [];
      if (group.type === 'single') return { ...prev, [group.name]: [item.name] };
      const exists = current.includes(item.name);
      const next = exists
        ? current.filter((v) => v !== item.name)
        : (current.length >= group.max_select ? current : [...current, item.name]);
      return { ...prev, [group.name]: next };
    });
  }
  const optionSelections = visibleGroups.flatMap((g) =>
    selectedItems(g).map((it) => ({ group: g.name, value: it.name, price_delta: it.price_delta })));
  const optionDelta = optionSelections.reduce((sum, it) => sum + Number(it.price_delta || 0), 0);
  const unitPrice = baseUnitPrice + optionDelta;
  const setSafeQuantity = (value) => setQuantity(Math.max(1, Math.min(99, Math.floor(Number(value) || 1))));
  const allPicked = visibleGroups.every((g) => {
    const n = selectedItems(g).length;
    return n >= g.min_select && n <= g.max_select;
  });
  const canConfirm = (variantOptions.length === 0 || selectedVariant) && allPicked;
  return (
    <div onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
        display: 'flex', alignItems: 'flex-end', zIndex: 100,
      }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white', width: '100%', maxWidth: 480, margin: '0 auto',
          borderRadius: '24px 24px 0 0', padding: '12px 20px 20px',
          maxHeight: '85vh', overflowY: 'auto',
          boxShadow: '0 -16px 48px rgba(13,16,38,.3)',
        }}>
        <div style={{
          width: 44, height: 5, borderRadius: 999, background: '#e2e4ee',
          margin: '0 auto 14px',
        }} />
        <h3 style={{ fontWeight: 800, fontSize: 19, marginBottom: 12, color: NAVY }}>
          {product.emoji || ''} {product.name}
        </h3>

        {variantOptions.length > 0 && (
          <>
            <p style={{ fontSize: 13, color: '#888', margin: '0 0 8px' }}>เลือกขนาด</p>
            {variantOptions.map((v) => {
              const active = variantId === v.id;
              return (
                <button key={v.id} type="button"
                  onClick={() => setVariantId(v.id)}
                  style={{
                    width: '100%', display: 'flex', justifyContent: 'space-between',
                    padding: 12, marginBottom: 6,
                    background: active ? NAVY : '#f3f4fa',
                    color: active ? 'white' : NAVY,
                    border: '1.5px solid ' + (active ? NAVY : '#eee'),
                    borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: 'pointer',
                  }}>
                  <span>{v.label}</span>
                  <span style={{ fontWeight: 800 }}>{currency}{Number(v.price).toFixed(0)}</span>
                </button>
              );
            })}
          </>
        )}

        {visibleGroups.map((g) => (
          <div key={g.name} style={{ marginTop: 14 }}>
            <p style={{ fontSize: 13, color: '#888', margin: '0 0 8px' }}>
              {g.name}
              {g.required ? ' *' : ''}
              {g.type === 'multiple' ? ` (${g.min_select}-${g.max_select})` : ''}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {g.items.map((item) => {
                const active = (picks[g.name] || []).includes(item.name);
                const atMax = g.type === 'multiple' && !active && (picks[g.name] || []).length >= g.max_select;
                return (
                  <button key={item.name} type="button"
                    disabled={atMax}
                    onClick={() => togglePick(g, item)}
                    style={{
                      flex: '1 0 calc(50% - 3px)', padding: '10px 12px',
                      background: active ? NAVY : '#f3f4fa',
                      color: active ? 'white' : NAVY,
                      border: '1.5px solid ' + (active ? NAVY : '#eee'),
                      borderRadius: 10, fontSize: 14, fontWeight: 600,
                      cursor: atMax ? 'not-allowed' : 'pointer',
                      opacity: atMax ? .45 : 1,
                    }}>
                    <span>{item.name}</span>
                    {Number(item.price_delta) !== 0 && (
                      <span style={{ display: 'block', fontSize: 12, opacity: .75 }}>
                        {Number(item.price_delta) > 0 ? '+' : ''}{currency}{Number(item.price_delta).toFixed(0)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div style={{ marginTop: 14 }}>
          <p style={{ fontSize: 13, color: '#888', margin: '0 0 8px' }}>จำนวน</p>
          <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr 44px', gap: 8 }}>
            <button type="button"
              onClick={() => setSafeQuantity(quantity - 1)}
              style={{
                height: 42, borderRadius: 10, border: '1.5px solid #eee',
                background: '#f3f4fa', color: NAVY, fontSize: 20, fontWeight: 900,
              }}>-</button>
            <input
              type="number"
              min="1"
              max="99"
              inputMode="numeric"
              value={quantity}
              onChange={(e) => {
                if (e.target.value === '') return;
                setSafeQuantity(e.target.value);
              }}
              style={{
                height: 42, border: '1.5px solid #eee', borderRadius: 10,
                textAlign: 'center', fontSize: 18, fontWeight: 900,
                color: NAVY, outline: 'none',
              }}
            />
            <button type="button"
              onClick={() => setSafeQuantity(quantity + 1)}
              style={{
                height: 42, borderRadius: 10, border: 'none',
                background: NAVY, color: 'white', fontSize: 20, fontWeight: 900,
              }}>+</button>
          </div>
        </div>

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="คำอธิบายเพิ่มเติม เช่น ไม่ใส่ผัก แยกน้ำซุป"
          style={{
            width: '100%', border: '1.5px solid #eee', borderRadius: 10,
            padding: '10px 12px', fontSize: 14, resize: 'vertical',
            minHeight: 46, marginTop: 14, outline: 'none', boxSizing: 'border-box',
          }}
        />

        <button type="button"
          disabled={!canConfirm}
          onClick={() => {
            onConfirm(variantName, optionSelections, note.trim(), quantity);
          }}
          style={{
            width: '100%', padding: 15, marginTop: 16,
            background: canConfirm ? `linear-gradient(135deg, ${ORANGE}, #f0750f)` : '#ccc',
            color: 'white',
            border: 'none', borderRadius: 14, fontSize: 15.5, fontWeight: 800,
            cursor: canConfirm ? 'pointer' : 'not-allowed',
            boxShadow: canConfirm ? '0 10px 24px rgba(232,93,4,.35)' : 'none',
          }}>
          {canConfirm ? `เพิ่ม ${quantity} รายการ · ${currency}${Number(unitPrice * quantity).toFixed(0)}` : 'เลือกให้ครบทุกกลุ่ม'}
        </button>
        <button type="button" onClick={onCancel}
          style={{ width: '100%', padding: 12, background: 'transparent', border: 'none', color: '#888', marginTop: 6 }}>
          ยกเลิก
        </button>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, badge, children }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      padding: '12px 0', border: 'none', background: 'transparent',
      fontSize: 13.5, fontWeight: 700, color: active ? NAVY : '#9aa0b5',
      borderBottom: `2.5px solid ${active ? ORANGE : 'transparent'}`,
      marginBottom: '-1.5px', cursor: 'pointer', transition: 'color .15s ease',
    }}>
      {children}
      {badge != null && (
        <span style={{
          background: active ? ORANGE : '#ecedf4', color: active ? 'white' : '#888da6',
          borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 700,
        }}>{badge}</span>
      )}
    </button>
  );
}

function ToggleBtn({ active, onClick, activeBg, activeColor, children }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '8px 0', borderRadius: 8, border: 'none',
      fontSize: 13, fontWeight: 700, cursor: 'pointer',
      background: active ? activeBg : 'transparent',
      color: active ? activeColor : '#999',
      transition: 'all .15s',
    }}>{children}</button>
  );
}

function esc(s) { return String(s ?? '').replace(/[<>]/g, ''); }

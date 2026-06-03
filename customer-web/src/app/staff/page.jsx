'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, authFetch, clearAuth } from '@/lib/auth';
import { apiBase } from '@/lib/api';
import { useRealtimeRecovery } from '@/lib/realtimeRecovery';
import { ensureSocketConnected } from '@/lib/socket';
import { storageGet } from '@/lib/browser';
import { openQrPrintWindow } from '@/lib/printQr';

const STATUS_LABEL = {
  pending: 'รอยืนยัน', cooking: 'กำลังทำ', served: 'เสิร์ฟแล้ว', paid: 'ชำระแล้ว', cancelled: 'ยกเลิก',
};

function trimOrderRoot(value) {
  return String(value || '').trim().replace(/\/order\/?$/, '').replace(/\/$/, '');
}

function isLanLikeUrl(value) {
  try {
    const host = new URL(trimOrderRoot(value)).hostname.toLowerCase();
    if (host === 'localhost' || /^127\./.test(host)) return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const m = host.match(/^172\.(\d{1,2})\./);
    return !!(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
  } catch {
    return false;
  }
}

function apiWebOrigin() {
  try {
    const u = new URL(apiBase);
    if (u.port === '4000') u.port = '3000';
    return u.origin;
  } catch {
    return '';
  }
}

function localQrRoot() {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  if (isLanLikeUrl(origin)) return trimOrderRoot(origin);
  const apiOrigin = apiWebOrigin();
  return trimOrderRoot(apiOrigin || origin);
}

function lanWebRootFromDiscovery(info) {
  const addresses = Array.isArray(info?.addresses) ? info.addresses : [];
  const lanIp = addresses.find((ip) => isLanLikeUrl(`http://${ip}`));
  return lanIp ? `http://${lanIp}:3000` : '';
}

function urlHost(value) {
  try {
    return new URL(trimOrderRoot(value)).host.toLowerCase();
  } catch {
    return '';
  }
}

function isStaleQrBase(stored, currentLanRoot, currentPublicRoot) {
  if (!stored) return false;
  if (isLanLikeUrl(stored) && currentLanRoot) {
    return urlHost(stored) !== urlHost(currentLanRoot);
  }
  return !isLanLikeUrl(stored) && !!currentPublicRoot && isLanLikeUrl(currentPublicRoot);
}

export default function StaffPage() {
  const router = useRouter();
  const [auth, setAuthState] = useState(null);

  const [tables, setTables] = useState([]);
  const [orders, setOrders] = useState([]);
  const [menu, setMenu] = useState({ categories: [], products: [] });
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [activeCat, setActiveCat] = useState(null);
  const [cart, setCart] = useState({}); // { [productId]: { product, quantity, note } }
  const [orderNote, setOrderNote] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qrBase, setQrBase] = useState('');
  const [qrWifiOnly, setQrWifiOnly] = useState(false);
  const [pickerProduct, setPickerProduct] = useState(null);
  const [scanCode, setScanCode] = useState('');
  const [scanBusy, setScanBusy] = useState(false);

  // Resolve customer-facing base URL once on mount.
  // Order: LAN origin when WiFi-only → localStorage → backend PUBLIC_BASE_URL → window.origin.
  useEffect(() => {
    (async () => {
      let base = null;
      let settings = null;
      let discoveryLanRoot = null;
      let publicRoot = null;
      try {
        settings = await fetch(`${apiBase}/api/settings`, { cache: 'no-store' }).then((r) => r.json());
      } catch {}
      const wifiOnly = !!settings?.ordering_require_private_ip;
      setQrWifiOnly(wifiOnly);
      try {
        const res = await fetch(`${apiBase}/api/discovery/info`);
        const j = await res.json();
        if (j.public_base_url) publicRoot = trimOrderRoot(j.public_base_url);
        discoveryLanRoot = trimOrderRoot(lanWebRootFromDiscovery(j));
      } catch {}
      const stored = trimOrderRoot(storageGet('pos_v2_qr_base'));
      const currentLanRoot = discoveryLanRoot || localQrRoot();
      const currentPublicRoot = publicRoot || currentLanRoot;
      const usableStored = isStaleQrBase(stored, currentLanRoot, currentPublicRoot) ? '' : stored;
      base = wifiOnly
        ? (usableStored && isLanLikeUrl(usableStored) ? usableStored : currentLanRoot)
        : (usableStored || currentPublicRoot);
      if (!base && typeof window !== 'undefined') base = window.location.origin;
      setQrBase(trimOrderRoot(base));
    })();
  }, []);

  const reloadOrders = useCallback(async () => {
    try {
      const list = await authFetch('/api/orders');
      setOrders(list);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useRealtimeRecovery(reloadOrders, { intervalMs: 12000 });

  // Refetch menu when product:availability fires. Uses the same hook as
  // orders sync — proven to survive socket rebuilds, browser tab resume,
  // and network blips. The hook also polls every 15 s as a safety net so
  // we never get permanently stuck on stale data.
  const reloadMenu = useCallback(async () => {
    try {
      const m = await fetch(`${apiBase}/api/public/menu?include_unavailable=1`, {
        cache: 'no-store',
        credentials: apiBase ? 'omit' : 'same-origin',
      }).then((r) => r.json());
      setMenu((prev) => ({
        ...prev,
        categories: m.categories || prev.categories,
        products: m.products || prev.products,
      }));
    } catch (_e) { /* keep stale on fail */ }
  }, []);
  useRealtimeRecovery(reloadMenu, {
    events: ['product:availability'],
    intervalMs: 5000,
    reloadOnMount: false,
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const a = getAuth();
        if (!a?.token) {
          router.replace('/login?next=/staff');
          return;
        }
        const role = a.user?.role;
        if (role === 'kitchen') {
          router.replace('/kitchen');
          return;
        }
        if (role === 'admin' || role === 'super_admin') {
          router.replace('/admin');
          return;
        }
        if (role !== 'staff') {
          clearAuth();
          router.replace('/login?next=/staff');
          return;
        }
        if (cancelled) return;
        setAuthState(a);
        const [t, m] = await Promise.all([
          authFetch('/api/tables'),
          fetch(`${apiBase}/api/public/menu?include_unavailable=1`, {
            cache: 'no-store',
            credentials: apiBase ? 'omit' : 'same-origin',
          }).then(r => r.json()),
        ]);
        if (cancelled) return;
        setTables(t.filter((x) => x.is_active));
        setMenu(m);
        if (m.categories[0]) setActiveCat(m.categories[0].id);
        reloadOrders();
      } catch (e) {
        if (e.message === 'session expired') {
          router.replace('/login?next=/staff');
          return;
        }
        setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadOrders, router]);

  const productsByCat = useMemo(() => {
    const map = new Map();
    for (const p of menu.products) {
      if (!map.has(p.category_id)) map.set(p.category_id, []);
      map.get(p.category_id).push(p);
    }
    return map;
  }, [menu.products]);

  const ordersByTable = useMemo(() => {
    const map = new Map();
    for (const o of orders) {
      if (o.status === 'paid' || o.status === 'cancelled') continue;
      if (!map.has(o.table_id)) map.set(o.table_id, []);
      map.get(o.table_id).push(o);
    }
    return map;
  }, [orders]);

  const cartItems = Object.values(cart);
  const totalQty = cartItems.reduce((s, c) => s + c.quantity, 0);
  const totalPrice = cartItems.reduce((s, c) => s + Number(c.unitPrice) * c.quantity, 0);

  function cartKey(productId, variantName, optionsSelected) {
    const opts = (optionsSelected || []).map((o) => `${o.group}=${o.value}`).join('|');
    return [productId, variantName || '', opts].join('::');
  }
  function optionPriceDelta(optionsSelected = []) {
    return optionsSelected.reduce((sum, option) => sum + Number(option.price_delta || 0), 0);
  }
  function addToCart(product, variantName = null, optionsSelected = [], itemNote = '') {
    const variantPrice = variantName
      ? (product.variants?.find((v) => v.name === variantName)?.price ?? product.price)
      : product.price;
    const key = cartKey(product.id, variantName, optionsSelected);
    setCart((prev) => {
      const cur = prev[key];
      return { ...prev, [key]: {
        product,
        key,
        variantName,
        optionsSelected,
        unitPrice: Number(variantPrice) + optionPriceDelta(optionsSelected),
        quantity: (cur?.quantity || 0) + 1,
        note: cur?.note || itemNote || '',
      } };
    });
  }
  function onAddProduct(product) {
    const complex = (product.variants?.length || 0) > 0 || (product.options?.length || 0) > 0;
    if (complex) setPickerProduct(product);
    else addToCart(product);
  }
  function setQty(key, qty) {
    setCart((prev) => {
      if (qty <= 0) { const { [key]: _g, ...rest } = prev; return rest; }
      return { ...prev, [key]: { ...prev[key], quantity: qty } };
    });
  }
  function setItemNote(key, note) {
    setCart((prev) => prev[key] ? { ...prev, [key]: { ...prev[key], note } } : prev);
  }

  const [scannedPreview, setScannedPreview] = useState(null);
  async function addScannedProduct() {
    const code = scanCode.trim();
    if (!code) return;
    setScanBusy(true);
    setError(null);
    try {
      let product = menu.products.find((p) => String(p.barcode || '') === code);
      if (!product) product = await authFetch(`/api/products/barcode/${encodeURIComponent(code)}`);
      if ((product.track_stock || product.product_type === 'stock') && Number(product.stock_qty || 0) <= 0) {
        throw new Error(`สินค้า "${product.name}" หมดสต๊อก`);
      }
      // Show preview modal instead of auto-adding so staff can review the
      // scanned item (right product? right price?) before committing.
      setScannedPreview(product);
      setScanCode('');
    } catch (e) {
      setError(e.message);
    } finally {
      setScanBusy(false);
    }
  }
  function confirmScannedAdd(product, qty = 1, note = '') {
    const complex = (product.variants?.length || 0) > 0 || (product.options?.length || 0) > 0;
    if (complex) {
      setPickerProduct(product);
      setScannedPreview(null);
      return;
    }
    for (let i = 0; i < qty; i += 1) addToCart(product, null, [], note);
    setScannedPreview(null);
  }

  async function placeOrder() {
    if (!selectedTableId || cartItems.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const targetTable = tables.find((t) => t.id === selectedTableId);
      const takeawayPoint = !!targetTable?.is_takeaway || targetTable?.code === 'TAKEAWAY' || Number(targetTable?.seats) === 0;
      const items = cartItems.map((c) => ({
        product_id: c.product.id, quantity: c.quantity,
        variant_name: c.variantName || undefined,
        options_selected: c.optionsSelected?.length ? c.optionsSelected : undefined,
        fulfillment_type: takeawayPoint ? 'takeaway' : 'dine-in',
        note: c.note || undefined,
      }));
      await authFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          table_id: selectedTableId,
          items,
          note: orderNote || undefined,
          order_type: takeawayPoint ? 'takeaway' : 'dine-in',
        }),
      });
      setCart({});
      setOrderNote('');
      reloadOrders();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function changeStatus(id, status) {
    try {
      await authFetch(`/api/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      reloadOrders();
    } catch (e) { setError(e.message); }
  }

  const [togglingProductId, setTogglingProductId] = useState(null);
  async function toggleAvailability(product) {
    if (togglingProductId === product.id) return; // guard
    setTogglingProductId(product.id);
    const nextVal = !(product.is_available !== false);
    try {
      await authFetch(`/api/products/${product.id}/availability`, {
        method: 'PATCH',
        body: JSON.stringify({ is_available: nextVal }),
      });
      setMenu((prev) => ({
        ...prev,
        products: prev.products.map((p) =>
          p.id === product.id ? { ...p, is_available: nextVal } : p),
      }));
    } catch (e) {
      setError(`เปลี่ยนสถานะไม่สำเร็จ: ${e.message}`);
    } finally {
      setTogglingProductId(null);
    }
  }

  async function printOrder(id, type) {
    try {
      const r = await authFetch(`/api/print/order/${id}?type=${type}`, { method: 'POST' });
      if (r.skipped) setError(`พิมพ์ข้าม: ${r.reason}`);
    } catch (e) { setError(`พิมพ์ไม่สำเร็จ: ${e.message}`); }
  }

  function logout() {
    clearAuth();
    router.replace('/login');
  }

  if (!auth) return null;

  const selectedTable = tables.find((t) => t.id === selectedTableId);
  const selectedTableOrders = selectedTableId ? (ordersByTable.get(selectedTableId) || []) : [];

  return (
    <main className="pos-app-shell staff-page-shell" style={{ minHeight: 'var(--app-height, 100vh)', background: '#f0f0f5', fontFamily: 'system-ui, sans-serif' }}>
      <header className="pos-topbar staff-topbar" style={{
        background: 'linear-gradient(135deg,#1a1a2e,#16213e)', color: 'white',
        padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        position: 'sticky', top: 0, zIndex: 50, boxShadow: '0 2px 12px rgba(0,0,0,.3)'
      }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 18 }}>👤 หน้าพนักงาน</div>
          <div style={{ opacity: .55, fontSize: 12 }}>{auth.user.full_name}</div>
        </div>
        <div className="staff-topbar-actions" style={{ display: 'flex', gap: 8 }}>
          <button onClick={logout}
                  style={{ background: 'rgba(239,71,111,.15)', color: '#ef476f',
                           border: '1px solid rgba(239,71,111,.25)', padding: '7px 14px',
                           borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            🚪 ออก
          </button>
        </div>
      </header>

      {error && (
        <div style={{ background: '#ffe5e5', color: '#c00', padding: '8px 14px', fontSize: 13 }}>{error}</div>
      )}

      <div className="staff-layout" style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 0, minHeight: 'calc(var(--app-height, 100vh) - 56px)' }}>
        {/* Tables sidebar */}
        <aside className="staff-table-rail" style={{ background: 'white', borderRight: '1px solid #e5e5ea', padding: 12, overflowY: 'auto' }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: '#888', marginBottom: 8, fontWeight: 700 }}>
            🪑 เลือกโต๊ะ
          </div>
          {tables.map((t) => {
            const active = t.id === selectedTableId;
            const tOrders = ordersByTable.get(t.id) || [];
            const sum = tOrders.reduce((s, o) => s + Number(o.total_amount), 0);
            return (
              <button
                className="staff-table-button"
                key={t.id}
                onClick={() => setSelectedTableId(t.id)}
                style={{
                  width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 6,
                  borderRadius: 10, border: '2px solid ' + (active ? '#1a1a2e' : 'transparent'),
                  background: active ? '#1a1a2e' : '#f8f8fa', color: active ? 'white' : '#1a1a2e',
                  cursor: 'pointer', fontSize: 14
                }}
              >
                <div style={{ fontWeight: 700 }}>{t.name}</div>
                <div style={{ fontSize: 11, opacity: .65 }}>
                  {tOrders.length ? `${tOrders.length} รอบ · ฿${sum.toFixed(0)}` : 'ว่าง'}
                </div>
              </button>
            );
          })}
        </aside>

        {/* Main panel */}
        <section className="staff-main-panel" style={{ padding: 16, overflowY: 'auto' }}>
          {!selectedTable ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#999' }}>
              เลือกโต๊ะเพื่อรับออเดอร์
            </div>
          ) : (
            <>
              <div className="staff-table-header" style={{ display: 'flex', justifyContent: 'space-between',
                            alignItems: 'center', marginBottom: 12 }}>
                <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>{selectedTable.name}</h2>
                <div className="staff-table-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="staff-qr-token" style={{ fontSize: 12, color: '#888' }}>QR token: {selectedTable.qr_token.slice(0, 8)}…</span>
                  <button onClick={() => setShowQr(true)}
                          title="แสดง QR ให้ลูกค้าสแกน"
                          style={{ background: '#1a1a2e', color: 'white', border: 'none',
                                   borderRadius: 8, padding: '6px 12px', fontSize: 12,
                                   fontWeight: 700, cursor: 'pointer' }}>
                    📱 QR ลูกค้า
                  </button>
                </div>
              </div>

              {/* Existing orders for this table */}
              {selectedTableOrders.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 11, letterSpacing: 2, color: '#888',
                                marginBottom: 6, fontWeight: 700 }}>
                    📋 ออเดอร์ของโต๊ะนี้
                  </div>
                  {selectedTableOrders.map((o) => (
                    <div className="staff-order-row" key={o.id} style={{ background: 'white', borderRadius: 12, padding: 10,
                                              marginBottom: 6, display: 'flex',
                                              justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14 }}>
                        #{o.id} · <span style={{ fontWeight: 700, color: '#e85d04' }}>
                          {STATUS_LABEL[o.status] || o.status}
                        </span> · ฿{Number(o.total_amount).toFixed(0)}
                      </span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => printOrder(o.id, 'receipt')}
                                title="พิมพ์ใบเสร็จ"
                                style={{ background: '#f0f0f5', color: '#1a1a2e', border: 'none',
                                         borderRadius: 8, padding: '5px 10px',
                                         fontSize: 13, cursor: 'pointer' }}>
                          🖨️
                        </button>
                        {o.status !== 'paid' && (
                          <button onClick={() => changeStatus(o.id, 'paid')}
                                  style={{ background: '#06d6a0', color: 'white', border: 'none',
                                           borderRadius: 8, padding: '5px 10px',
                                           fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                            💰 ชำระ
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ background: 'white', borderRadius: 12, padding: 12,
                            marginBottom: 12, boxShadow: '0 2px 6px rgba(0,0,0,.04)' }}>
                <div style={{ fontSize: 11, letterSpacing: 2, color: '#888', marginBottom: 6, fontWeight: 700 }}>
                  📦 สแกนสินค้าหน้างาน
                </div>
                <div className="staff-scan-row" style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={scanCode}
                    onChange={(e) => setScanCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addScannedProduct();
                      }
                    }}
                    autoComplete="off"
                    placeholder="สแกนบาร์โค้ด / กรอกรหัสสินค้า"
                    style={{ flex: 1, border: '1.5px solid #eee', borderRadius: 10,
                             padding: '10px 12px', fontSize: 14, outline: 'none' }}
                  />
                  <button onClick={addScannedProduct}
                          disabled={scanBusy || !scanCode.trim()}
                          style={{ background: '#1a1a2e', color: 'white', border: 'none',
                                   borderRadius: 10, padding: '0 16px', fontWeight: 800,
                                   cursor: scanBusy ? 'wait' : 'pointer', opacity: scanCode.trim() ? 1 : .45 }}>
                    เพิ่ม
                  </button>
                </div>
              </div>

              {/* Category tabs */}
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10 }}>
                {menu.categories.map((c) => {
                  const active = activeCat === c.id;
                  return (
                    <button key={c.id}
                            onClick={() => setActiveCat(c.id)}
                            style={{ flex: 'none', padding: '8px 14px', borderRadius: 9,
                                     border: 'none', fontSize: 13, fontWeight: 600,
                                     background: active ? '#1a1a2e' : 'white',
                                     color: active ? 'white' : '#666', cursor: 'pointer',
                                     whiteSpace: 'nowrap' }}>
                      {c.name}
                    </button>
                  );
                })}
              </div>

              {/* Products grid */}
              <div className="staff-products-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
                {(productsByCat.get(activeCat) || []).map((p) => {
                  const productLines = cartItems.filter((c) => c.product.id === p.id);
                  const cur = productLines.reduce((sum, c) => sum + c.quantity, 0);
                  const firstKey = productLines[0]?.key;
                  const available = p.is_available !== false;
                  const toggling = togglingProductId === p.id;
                  return (
                    <div key={p.id} style={{ background: 'white', borderRadius: 12, padding: 12,
                                              boxShadow: '0 2px 6px rgba(0,0,0,.04)',
                                              opacity: available ? 1 : .55,
                                              position: 'relative' }}>
                      {!available && (
                        <div style={{ position: 'absolute', top: 8, right: 8,
                                      background: '#c0392b', color: 'white',
                                      fontSize: 10, fontWeight: 800,
                                      padding: '3px 8px', borderRadius: 10, zIndex: 1 }}>
                          ของหมด
                        </div>
                      )}
                      {p.image_url && (
                        <img src={`${apiBase}${p.image_url}`} alt={p.name}
                             style={{ width: '100%', height: 80, objectFit: 'cover',
                                      borderRadius: 8, marginBottom: 6, background: '#f5f5f7',
                                      filter: available ? 'none' : 'grayscale(0.7)' }} />
                      )}
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
                      {p.description && (
                        <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{p.description}</div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between',
                                    alignItems: 'center', marginTop: 8 }}>
                        <span style={{ color: '#e85d04', fontWeight: 800 }}>
                          ฿{Number(p.price).toFixed(0)}
                        </span>
                        {available ? (
                          cur > 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <button onClick={() => firstKey && setQty(firstKey, cart[firstKey].quantity - 1)}
                                      style={{ width: 26, height: 26, borderRadius: '50%',
                                               border: '1.5px solid #eee', background: 'white',
                                               cursor: 'pointer' }}>−</button>
                              <span style={{ fontWeight: 700, minWidth: 18, textAlign: 'center' }}>{cur}</span>
                              <button onClick={() => onAddProduct(p)}
                                      style={{ width: 26, height: 26, borderRadius: '50%',
                                               border: 'none', background: '#1a1a2e', color: 'white',
                                               cursor: 'pointer' }}>+</button>
                            </div>
                          ) : (
                            <button onClick={() => onAddProduct(p)}
                                    style={{ width: 30, height: 30, borderRadius: '50%',
                                             border: 'none', background: '#1a1a2e', color: 'white',
                                             fontSize: 18, cursor: 'pointer' }}>+</button>
                          )
                        ) : (
                          <span style={{ fontSize: 11, color: '#888' }}>ปิดขายอยู่</span>
                        )}
                      </div>
                      <button onClick={() => toggleAvailability(p)} disabled={toggling}
                              style={{ marginTop: 8, width: '100%', padding: '6px 8px',
                                       borderRadius: 8, border: 'none', cursor: 'pointer',
                                       fontSize: 12, fontWeight: 700,
                                       opacity: toggling ? .6 : 1,
                                       background: available ? '#fef0ef' : '#e8f5e9',
                                       color: available ? '#c0392b' : '#1f6f43' }}>
                        {toggling
                          ? 'กำลังเปลี่ยน...'
                          : (available ? '🛑 ปิดขาย (ของหมด)' : '✓ เปิดขายอีกครั้ง')}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Cart bar */}
              {totalQty > 0 && (
                <div style={{ position: 'sticky', bottom: 0, background: 'white',
                              padding: 12, borderRadius: 14, marginTop: 16,
                              boxShadow: '0 -4px 20px rgba(0,0,0,.12)' }}>
                  <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 10 }}>
                    {cartItems.map((c) => (
                      <div key={c.key} style={{
                        border: '1px solid #f0f0f5', borderRadius: 10, padding: 9,
                        marginBottom: 7, background: '#fbfbfd',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, color: '#1a1a2e',
                                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {c.product.name}{c.variantName ? ` (${c.variantName})` : ''} × {c.quantity}
                            </div>
                            {c.optionsSelected?.length > 0 && (
                              <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                                {c.optionsSelected.map((o) => o.value).join(' · ')}
                              </div>
                            )}
                          </div>
                          <div style={{ fontWeight: 800, color: '#e85d04', fontSize: 13 }}>
                            ฿{(Number(c.unitPrice) * c.quantity).toFixed(0)}
                          </div>
                        </div>
                        <input
                          value={c.note || ''}
                          onChange={(e) => setItemNote(c.key, e.target.value)}
                          placeholder="คำอธิบายเพิ่มเติม เช่น ไม่ใส่ผัก แยกน้ำซุป"
                          style={{ width: '100%', border: '1.5px solid #eee', borderRadius: 8,
                                   padding: '7px 10px', fontSize: 12, marginTop: 7,
                                   outline: 'none', boxSizing: 'border-box' }}
                        />
                      </div>
                    ))}
                  </div>
                  <input
                    value={orderNote}
                    onChange={(e) => setOrderNote(e.target.value)}
                    placeholder="หมายเหตุรวมของออเดอร์"
                    style={{ width: '100%', border: '1.5px solid #eee', borderRadius: 10,
                             padding: '8px 12px', fontSize: 13, marginBottom: 8,
                             outline: 'none', boxSizing: 'border-box' }}
                  />
                  <button
                    onClick={placeOrder}
                    disabled={submitting}
                    style={{ width: '100%', background: 'linear-gradient(135deg,#1a1a2e,#203a43)',
                             color: 'white', border: 'none', borderRadius: 13, padding: 14,
                             fontWeight: 700, fontSize: 15, cursor: 'pointer',
                             display: 'flex', justifyContent: 'space-between', opacity: submitting ? .5 : 1 }}
                  >
                    <span>{submitting ? 'กำลังบันทึก…' : '🛒 ยืนยันออเดอร์'} · {totalQty} รายการ</span>
                    <span>฿{totalPrice.toFixed(0)}</span>
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {showQr && selectedTable && (
        <CustomerQrModal
          table={selectedTable}
          base={qrBase}
          wifiOnly={qrWifiOnly}
          onClose={() => setShowQr(false)}
        />
      )}
      {pickerProduct && (
        <StaffProductPicker
          product={pickerProduct}
          onCancel={() => setPickerProduct(null)}
          onConfirm={(variantName, optionsSelected, itemNote) => {
            addToCart(pickerProduct, variantName, optionsSelected, itemNote);
            setPickerProduct(null);
          }}
        />
      )}
    </main>
  );
}

function StaffProductPicker({ product, onCancel, onConfirm }) {
  const currency = '฿';
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
  const [picks, setPicks] = useState(initialPicks);
  const [note, setNote] = useState('');
  const selectedVariant = variantOptions.find((v) => v.id === variantId);
  const variantName = selectedVariant?.variantName ?? null;
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
  const unitPrice = Number(selectedVariant?.price ?? product.price) + optionDelta;
  const allPicked = visibleGroups.every((g) => {
    const n = selectedItems(g).length;
    return n >= g.min_select && n <= g.max_select;
  });
  const canConfirm = (variantOptions.length === 0 || selectedVariant) && allPicked;

  return (
    <div onClick={onCancel}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)',
                  zIndex: 100, display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()}
           style={{ background: 'white', width: '100%', maxWidth: 520, margin: '0 auto',
                    borderRadius: '16px 16px 0 0', padding: 18, maxHeight: '86vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 18 }}>{product.emoji || ''} {product.name}</h3>
        {variantOptions.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>ขนาด</div>
            {variantOptions.map((v) => {
              const active = variantId === v.id;
              return (
                <button key={v.id} type="button" onClick={() => setVariantId(v.id)}
                        style={{ width: '100%', display: 'flex', justifyContent: 'space-between',
                                 padding: 11, marginBottom: 6, borderRadius: 10,
                                 border: `1.5px solid ${active ? '#1a1a2e' : '#eee'}`,
                                 background: active ? '#1a1a2e' : '#f8f8fa',
                                 color: active ? 'white' : '#1a1a2e',
                                 fontWeight: 700, cursor: 'pointer' }}>
                  <span>{v.label}</span><span>{currency}{Number(v.price).toFixed(0)}</span>
                </button>
              );
            })}
          </div>
        )}
        {visibleGroups.map((g) => (
          <div key={g.name} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
              {g.name}{g.required ? ' *' : ''}{g.type === 'multiple' ? ` (${g.min_select}-${g.max_select})` : ''}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {g.items.map((item) => {
                const active = (picks[g.name] || []).includes(item.name);
                const atMax = g.type === 'multiple' && !active && (picks[g.name] || []).length >= g.max_select;
                return (
                  <button key={item.name} type="button" disabled={atMax}
                          onClick={() => togglePick(g, item)}
                          style={{ flex: '1 0 calc(50% - 3px)', padding: '10px 12px',
                                   borderRadius: 10,
                                   border: `1.5px solid ${active ? '#1a1a2e' : '#eee'}`,
                                   background: active ? '#1a1a2e' : '#f8f8fa',
                                   color: active ? 'white' : '#1a1a2e',
                                   opacity: atMax ? .45 : 1, fontWeight: 700, cursor: atMax ? 'not-allowed' : 'pointer' }}>
                    {item.name}
                    {Number(item.price_delta) !== 0 && (
                      <span style={{ display: 'block', fontSize: 12 }}>
                        {Number(item.price_delta) > 0 ? '+' : ''}{currency}{Number(item.price_delta).toFixed(0)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="คำอธิบายเพิ่มเติม เช่น ไม่ใส่ผัก แยกน้ำซุป"
          style={{ width: '100%', border: '1.5px solid #eee', borderRadius: 10,
                   padding: '10px 12px', fontSize: 14, resize: 'vertical',
                   minHeight: 46, marginBottom: 12, outline: 'none',
                   boxSizing: 'border-box' }}
        />
        <button type="button" disabled={!canConfirm}
                onClick={() => onConfirm(variantName, optionSelections, note.trim())}
                style={{ width: '100%', padding: 13, border: 'none', borderRadius: 12,
                         background: canConfirm ? '#1a1a2e' : '#ccc', color: 'white',
                         fontWeight: 800, cursor: canConfirm ? 'pointer' : 'not-allowed' }}>
          {canConfirm ? `เพิ่ม · ${currency}${Number(unitPrice).toFixed(0)}` : 'เลือกให้ครบ'}
        </button>
        <button type="button" onClick={onCancel}
                style={{ width: '100%', padding: 10, border: 'none', background: 'transparent', color: '#888' }}>
          ยกเลิก
        </button>
      </div>
    </div>
  );
}

// Full-screen QR overlay so staff can show the customer's phone — or
// print a paper QR as an alternative for customers who can't scan.
// URL: <base>/order?t=<qr_token>
function CustomerQrModal({ table, base, wifiOnly, onClose }) {
  const url = `${base}/order?t=${table.qr_token}`;
  const qrSrc = `${apiBase}/api/qr?size=480&text=${encodeURIComponent(url)}`;
  const isLan = isLanLikeUrl(base);
  const [printing, setPrinting] = useState(false);
  const [notice, setNotice] = useState(null);

  async function printThermal() {
    setPrinting(true);
    setNotice(null);
    try {
      await authFetch('/api/print/qr', {
        method: 'POST',
        body: JSON.stringify({
          url,
          table_name: table.name,
          table_code: table.code,
          copies: 1,
        }),
      });
      setNotice('ส่งคิวพิมพ์ QR ไปเครื่องใบเสร็จแล้ว');
    } catch (e) {
      setNotice(`พิมพ์ไม่สำเร็จ: ${e.message}`);
    } finally {
      setPrinting(false);
    }
  }
  return (
    <div onClick={onClose}
         style={{
           position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', zIndex: 100,
           display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
         }}>
      <div onClick={(e) => e.stopPropagation()}
           style={{
             background: 'white', borderRadius: 18, padding: 24, maxWidth: 420,
             width: '100%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,.4)',
             maxHeight: 'calc(var(--app-height, 100vh) - 32px)',
             overflowY: 'auto',
           }}>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>📱 ให้ลูกค้าสแกนเพื่อสั่งอาหาร</div>
        <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 14 }}>{table.name}</div>
        <img src={qrSrc} alt={`QR ${table.code}`}
             style={{ width: '100%', maxWidth: 320, height: 'auto',
                      borderRadius: 12, background: '#f5f5f7' }} />
        <div style={{ fontSize: 11, color: '#888', marginTop: 12, wordBreak: 'break-all' }}>
          {url}
        </div>
        {wifiOnly && isLan ? (
          <div style={{ background: '#e8f5e9', color: '#1f6f43', padding: 8, borderRadius: 8,
                        fontSize: 11, marginTop: 10, textAlign: 'left' }}>
            โหมด WiFi ร้าน: ลูกค้าต้องต่อ WiFi ร้านก่อนสแกน QR นี้
          </div>
        ) : (!base.startsWith('http') || isLan) ? (
          <div style={{ background: '#fff5cc', color: '#8a6500', padding: 8, borderRadius: 8,
                        fontSize: 11, marginTop: 10, textAlign: 'left' }}>
            ⚠️ URL นี้เป็น LAN — ลูกค้าใช้เน็ตตัวเองสแกนไม่ได้
            ไปตั้ง <code>PUBLIC_BASE_URL</code> ใน <code>backend/.env</code> ก่อน
            (Caddy domain หรือ ngrok URL)
          </div>
        ) : null}
        {notice && (
          <div style={{ marginTop: 10, padding: 8, borderRadius: 8, fontSize: 12,
                        background: notice.startsWith('พิมพ์ไม่') ? '#ffe5e5' : '#e8f5e9',
                        color: notice.startsWith('พิมพ์ไม่') ? '#c00' : '#1f6f43' }}>
            {notice}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 14 }}>
          <button onClick={printThermal} disabled={printing}
                  style={{ background: '#1a1a2e', color: 'white',
                           border: 'none', borderRadius: 10, padding: '10px 18px',
                           fontWeight: 700, cursor: 'pointer', opacity: printing ? .6 : 1 }}>
            🧾 {printing ? 'กำลังส่ง…' : 'พิมพ์ผ่านเครื่องใบเสร็จ'}
          </button>
          <button onClick={() => openQrPrintWindow({
            url, tableName: table.name, tableCode: table.code,
            note: 'สแกน QR เพื่อสั่งอาหาร',
          })}
                  style={{ background: '#f0f0f5', color: '#1a1a2e',
                           border: 'none', borderRadius: 10, padding: '10px 18px',
                           fontWeight: 700, cursor: 'pointer' }}
                  title="สำหรับเครื่องพิมพ์ A4">
            🌐 เบราว์เซอร์
          </button>
          <button onClick={onClose}
                  style={{ background: '#f0f0f5', color: '#1a1a2e',
                           border: 'none', borderRadius: 10, padding: '10px 18px',
                           fontWeight: 700, cursor: 'pointer' }}>
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
}

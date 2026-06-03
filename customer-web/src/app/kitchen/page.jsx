'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, authFetch, clearAuth, logout } from '@/lib/auth';
import { useRealtimeRecovery } from '@/lib/realtimeRecovery';
import { pushSupported, getSubscriptionState, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe, sendTest as pushSendTest } from '@/lib/push';

const ACTIVE_STATUSES = ['pending', 'cooking', 'served'];

const STATUS_LABEL = {
  pending: 'รอยืนยัน',
  cooking: 'กำลังทำ',
  served: 'เสิร์ฟแล้ว',
  paid: 'ชำระแล้ว',
  cancelled: 'ยกเลิก',
};

const STATUS_COLOR = {
  pending: '#ff6b6b',
  cooking: '#ffd166',
  served: '#06d6a0',
  paid: '#888',
};

const NEXT_STATUS = {
  pending: { value: 'cooking', label: '▶ เริ่มทำ' },
  cooking: { value: 'served', label: '✅ เสิร์ฟแล้ว' },
  served:  { value: 'paid',    label: '💰 ชำระแล้ว' },
};

function timeOf(iso) {
  try {
    return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
function sequenceOf(order) { return order.daily_seq || order.id; }
function itemFulfillment(order, item) {
  return item.fulfillment_type === 'takeaway' ? 'takeaway' : (order.order_type === 'takeaway' ? 'takeaway' : 'dine-in');
}
function fulfillmentSummary(order) {
  if (order.fulfillment_summary) return order.fulfillment_summary;
  const types = new Set((order.items || []).map((it) => itemFulfillment(order, it)));
  if (types.size > 1) return 'mixed';
  return types.has('takeaway') ? 'takeaway' : 'dine-in';
}
function fulfillmentBadge(order) {
  const summary = fulfillmentSummary(order);
  if (summary === 'mixed') return { text: '🍽️ + 🛍️ ทานที่ร้านและกลับบ้าน', color: '#ffd166', bg: 'rgba(255,209,102,.16)' };
  if (summary === 'takeaway') return { text: '🛍️ กลับบ้าน', color: '#f4a261', bg: 'rgba(244,162,97,.16)' };
  return { text: '🍽️ ทานที่ร้าน', color: '#06d6a0', bg: 'rgba(6,214,160,.13)' };
}

export default function KitchenPage() {
  const router = useRouter();
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState(null);
  const [auth, setAuthState] = useState(null);
  const [pushStatus, setPushStatus] = useState('unknown');

  const reload = useCallback(async () => {
    try {
      const list = await authFetch('/api/orders');
      const detailed = await Promise.all(
        list.map((o) => authFetch(`/api/orders/${o.id}`))
      );
      setOrders(detailed);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useRealtimeRecovery(reload, { intervalMs: 10000 });

  useEffect(() => {
    const a = getAuth();
    if (!a) { router.replace('/login?next=/kitchen'); return; }
    const role = a.user?.role;
    if (role === 'staff') {
      router.replace('/staff');
      return;
    }
    if (role === 'admin' || role === 'super_admin') {
      router.replace('/admin');
      return;
    }
    if (role !== 'kitchen') {
      clearAuth();
      router.replace('/login?next=/kitchen');
      return;
    }
    setAuthState(a);
    reload();
    // Push state probe
    if (pushSupported()) {
      getSubscriptionState().then((s) => setPushStatus(s.status));
    } else {
      setPushStatus('unsupported');
    }
  }, [router, reload]);

  async function changeStatus(id, status) {
    try {
      await authFetch(`/api/orders/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      // Socket event will trigger reload, but do it now too for snappiness
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  async function printOrder(id, type) {
    try {
      const r = await authFetch(`/api/print/order/${id}?type=${type}`, { method: 'POST' });
      if (r.skipped) setError(`พิมพ์ข้าม: ${r.reason}`);
    } catch (e) {
      setError(`พิมพ์ไม่สำเร็จ: ${e.message}`);
    }
  }

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  async function togglePush() {
    try {
      if (pushStatus === 'subscribed') {
        await pushUnsubscribe();
        setPushStatus('allowed');
      } else {
        await pushSubscribe('kitchen');
        setPushStatus('subscribed');
      }
    } catch (e) {
      setError(`Push: ${e.message}`);
    }
  }
  async function testPush() {
    try {
      const r = await pushSendTest();
      setError(`Push test → ส่ง ${r.sent}/${r.total} subscriptions`);
    } catch (e) { setError(e.message); }
  }

  if (!auth) return null;

  const active = orders.filter((o) => ACTIVE_STATUSES.includes(o.status));
  const recentDone = orders.filter((o) => o.status === 'paid').slice(0, 8);

  return (
    <main className="pos-app-shell kitchen-page-shell" style={{ minHeight: 'var(--app-height, 100vh)', background: '#0f0f1a', color: 'white', fontFamily: 'system-ui, sans-serif' }}>
      <div className="pos-topbar kitchen-topbar" style={{
        background: '#16213e', padding: '14px 18px', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center',
        position: 'sticky', top: 0, zIndex: 50, boxShadow: '0 2px 12px rgba(0,0,0,.4)'
      }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 19 }}>🍳 ห้องครัว</div>
          <div style={{ opacity: .45, fontSize: 12 }}>{active.length} ออเดอร์รอดำเนินการ · {auth.user.full_name}</div>
        </div>
        <div className="kitchen-topbar-actions" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={togglePush}
                  title="เปิด/ปิดการแจ้งเตือน"
                  style={{ background: 'rgba(255,209,102,.15)', color: '#ffd166',
                           border: '1px solid rgba(255,209,102,.25)', padding: '7px 12px',
                           borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            {pushStatus === 'subscribed' ? '🔔 เปิด' :
              pushStatus === 'denied' ? '🔕 ถูกปิด' :
              pushStatus === 'unsupported' ? '🚫 ไม่รองรับ' : '🔕 ปิด'}
          </button>
          {pushStatus === 'subscribed' && (
            <button onClick={testPush}
                    title="ส่ง test notification"
                    style={{ background: 'rgba(255,255,255,.08)', color: 'white',
                             border: '1px solid rgba(255,255,255,.15)', padding: '7px 10px',
                             borderRadius: 20, fontSize: 12, cursor: 'pointer' }}>
              ทดสอบ
            </button>
          )}
          <button onClick={handleLogout}
                  style={{ background: 'rgba(239,71,111,.15)', color: '#ef476f',
                           border: '1px solid rgba(239,71,111,.25)', padding: '7px 14px',
                           borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            🚪 ออก
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: 'rgba(239,71,111,.15)', color: '#ef476f',
                      padding: '8px 14px', fontSize: 13 }}>
          {error}
        </div>
      )}

      <div className="kitchen-content" style={{ padding: 14, maxWidth: 1280, margin: '0 auto' }}>
        {!active.length && (
          <div style={{ textAlign: 'center', opacity: .3, padding: '60px 0', fontSize: 16 }}>
            ไม่มีออเดอร์รอดำเนินการ 🎉
          </div>
        )}

        <div className="kitchen-order-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {active.map((o) => {
            const stColor = STATUS_COLOR[o.status] || '#666';
            const next = NEXT_STATUS[o.status];
            const orderFulfillment = fulfillmentBadge(o);
            return (
              <div key={o.id}
                   className="kitchen-order-card"
                   style={{ background: 'rgba(255,255,255,.04)', borderRadius: 16, padding: 16,
                            borderLeft: `4px solid ${stColor}` }}>
                <div className="kitchen-order-header" style={{ display: 'flex', justifyContent: 'space-between',
                              alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <span style={{ fontWeight: 800, fontSize: 18 }}>{o.table_name}</span>
                    <span style={{ marginLeft: 10, opacity: .4, fontSize: 12 }}>
                      ลำดับ {sequenceOf(o)} · #{o.id} · {timeOf(o.created_at)}
                    </span>
                  </div>
                  <div style={{
                    marginTop: 5, display: 'inline-block',
                    background: orderFulfillment.bg, color: orderFulfillment.color,
                    borderRadius: 999, padding: '3px 9px',
                    fontSize: 12, fontWeight: 800,
                  }}>
                    {orderFulfillment.text}
                  </div>
                  <span style={{ background: stColor, color: '#1a1a2e', borderRadius: 20,
                                 padding: '4px 12px', fontSize: 12, fontWeight: 700 }}>
                    {STATUS_LABEL[o.status] || o.status}
                  </span>
                </div>

                {o.items.map((it) => {
                  const f = itemFulfillment(o, it);
                  return (
                  <div key={it.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,.05)',
                                            fontSize: 14, opacity: .9 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>{it.product_name}{it.variant_name ? ` (${it.variant_name})` : ''} × {it.quantity}</span>
                      <span style={{ opacity: .5 }}>฿{Number(it.unit_price * it.quantity).toFixed(0)}</span>
                    </div>
                    {Array.isArray(it.options_selected) && it.options_selected.length > 0 && (
                      <div style={{ fontSize: 12, color: '#06d6a0', marginTop: 2 }}>
                        ▸ {it.options_selected.map((o) => o.value).join(' · ')}
                      </div>
                    )}
                    {it.note && (
                      <div style={{ fontSize: 12, color: '#ffd166', marginTop: 2 }}>📝 {it.note}</div>
                    )}
                    <span style={{
                      display: 'inline-block', marginTop: 4,
                      background: f === 'takeaway' ? 'rgba(244,162,97,.16)' : 'rgba(6,214,160,.13)',
                      color: f === 'takeaway' ? '#f4a261' : '#06d6a0',
                      borderRadius: 999, padding: '2px 8px',
                      fontSize: 11, fontWeight: 800,
                    }}>
                      {f === 'takeaway' ? '🛍️ กลับบ้าน' : '🍽️ ทานที่ร้าน'}
                    </span>
                  </div>
                );})}

                {o.note && (
                  <div style={{ marginTop: 8, background: 'rgba(255,209,102,.1)',
                                borderRadius: 8, padding: '6px 10px', fontSize: 13, color: '#ffd166' }}>
                    📝 {o.note}
                  </div>
                )}

                <div className="kitchen-order-actions" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  {next && (
                    <button
                      onClick={() => changeStatus(o.id, next.value)}
                      style={{ flex: 1, background: STATUS_COLOR[next.value] || '#aaa',
                               color: '#1a1a2e', border: 'none', borderRadius: 10,
                               padding: 11, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
                    >
                      {next.label}
                    </button>
                  )}
                  <button
                    onClick={() => printOrder(o.id, 'kitchen')}
                    title="พิมพ์ใบสั่งครัว"
                    style={{ background: 'rgba(255,255,255,.1)', color: 'white',
                             border: 'none', borderRadius: 10, padding: '11px 14px',
                             fontSize: 16, cursor: 'pointer' }}
                  >
                    🖨️
                  </button>
                  <button
                    onClick={() => changeStatus(o.id, 'cancelled')}
                    style={{ background: 'rgba(239,71,111,.2)', color: '#ef476f',
                             border: 'none', borderRadius: 10, padding: '11px 14px',
                             fontSize: 13, cursor: 'pointer' }}
                  >
                    ยกเลิก
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {recentDone.length > 0 && (
          <div style={{ marginTop: 24, opacity: .35 }}>
            <div style={{ fontSize: 11, letterSpacing: 2, marginBottom: 8 }}>
              เสร็จล่าสุด ({recentDone.length})
            </div>
            {recentDone.map((o) => (
              <div key={o.id}
                   style={{ background: 'rgba(255,255,255,.02)', borderRadius: 10,
                            padding: '9px 14px', marginBottom: 6, fontSize: 13 }}>
                ลำดับ {sequenceOf(o)} · #{o.id} · {o.table_name} · ฿{Number(o.total_amount).toFixed(0)} · {timeOf(o.created_at)}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

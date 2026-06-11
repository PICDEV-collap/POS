'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

export default function OrderStatusPageWrapper() {
  return (
    <Suspense fallback={<main className="p-6 text-center text-gray-500">กำลังโหลด...</main>}>
      <OrderStatusPage />
    </Suspense>
  );
}

const STATUS_TH = {
  pending: 'รอดำเนินการ',
  cooking: 'กำลังปรุง',
  served: 'เสิร์ฟแล้ว',
  paid: 'ชำระเงินแล้ว',
  cancelled: 'ยกเลิก',
};

const STATUS_BADGE = {
  pending: { bg: '#fdf3dc', color: '#9a6700', icon: '⏳' },
  cooking: { bg: '#fff1e6', color: '#c84f00', icon: '🍳' },
  served: { bg: '#e2f8f0', color: '#077a5d', icon: '✅' },
  paid: { bg: '#e8f0fd', color: '#2d5fb8', icon: '💰' },
  cancelled: { bg: '#fdecf1', color: '#c23054', icon: '❌' },
};

function OrderStatusPage() {
  const params = useSearchParams();
  const id = params.get('id');
  const token = params.get('t');
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!id || !token) { setError('ลิงก์ไม่ถูกต้อง'); return; }
    let alive = true;
    async function load() {
      try {
        const o = await api.getOrder(id, token);
        if (alive) setOrder(o);
      } catch (e) {
        if (alive) setError(e.message);
      }
    }
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [id, token]);

  if (error) {
    return (
      <main className="max-w-md mx-auto p-6 text-center">
        <h1 className="text-xl font-bold text-red-600 mb-3">เกิดข้อผิดพลาด</h1>
        <p>{error}</p>
      </main>
    );
  }
  if (!order) {
    return <main className="p-6 text-center text-gray-500">กำลังโหลด...</main>;
  }

  const badge = STATUS_BADGE[order.status] || STATUS_BADGE.pending;

  return (
    <main className="customer-order-shell" style={{ paddingBottom: 28 }}>
      <header style={{
        background: 'radial-gradient(560px 240px at 90% -40%, rgba(232,93,4,.35), transparent 65%), linear-gradient(135deg, #181e3a, #2c3567)',
        color: 'white', padding: '22px 18px 26px', borderRadius: '0 0 24px 24px',
      }}>
        <div style={{ fontSize: 12, opacity: .6, letterSpacing: 1.5 }}>ORDER #{order.id}</div>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: '6px 0 0' }}>
          ลำดับที่ {order.daily_seq || order.id}
        </h1>
        <div style={{
          display: 'inline-block', marginTop: 8, background: 'rgba(255,255,255,.12)',
          borderRadius: 999, padding: '3px 12px', fontSize: 13, fontWeight: 600,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16)',
        }}>🪑 โต๊ะ {order.table_name}</div>
      </header>

      <div style={{ padding: '14px 14px 0' }}>
        <div style={{
          background: '#fff', border: '1px solid #e6e8f2', borderRadius: 18,
          padding: '14px 16px', display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', boxShadow: '0 1px 2px rgba(24,28,52,.05), 0 2px 8px rgba(24,28,52,.05)',
        }}>
          <div style={{ fontSize: 13, color: '#858ca6', fontWeight: 600 }}>สถานะออเดอร์</div>
          <div style={{
            background: badge.bg, color: badge.color, borderRadius: 999,
            padding: '6px 14px', fontSize: 14, fontWeight: 800,
          }}>{badge.icon} {STATUS_TH[order.status] || order.status}</div>
        </div>

        <h2 style={{ fontSize: 16, fontWeight: 800, margin: '18px 2px 10px', color: '#181c34' }}>รายการ</h2>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {order.items.map((it) => {
            const takeaway = (it.fulfillment_type || order.order_type) === 'takeaway';
            return (
              <li key={it.id} style={{
                background: '#fff', border: '1px solid #e6e8f2', borderRadius: 16,
                padding: '12px 14px', display: 'flex', justifyContent: 'space-between', gap: 10,
                boxShadow: '0 1px 2px rgba(24,28,52,.05), 0 2px 8px rgba(24,28,52,.05)',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14.5, color: '#181c34' }}>
                    {it.product_name} <span style={{ color: '#9aa0b5' }}>×{it.quantity}</span>
                  </div>
                  <span style={{
                    display: 'inline-block', marginTop: 5, fontSize: 11, fontWeight: 800,
                    color: takeaway ? '#c84f00' : '#2d5fb8',
                    background: takeaway ? '#fff1e6' : '#e8f0fd',
                    borderRadius: 999, padding: '2px 9px',
                  }}>{takeaway ? '🛍️ กลับบ้าน' : '🍽️ ทานที่ร้าน'}</span>
                  {it.note ? <div style={{ fontSize: 12.5, color: '#858ca6', marginTop: 5 }}>📝 {it.note}</div> : null}
                  <div style={{ fontSize: 11.5, color: '#b3b8ca', marginTop: 4 }}>{STATUS_TH[it.status] || it.status}</div>
                </div>
                <div style={{ fontWeight: 800, color: '#e85d04', whiteSpace: 'nowrap' }}>
                  ฿{(Number(it.unit_price) * it.quantity).toFixed(0)}
                </div>
              </li>
            );
          })}
        </ul>

        <div style={{
          marginTop: 14, background: 'linear-gradient(135deg, #181e3a, #2c3567)', color: '#fff',
          borderRadius: 18, padding: '15px 18px', display: 'flex',
          justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: 14, opacity: .75, fontWeight: 600 }}>ยอดรวม</span>
          <span style={{ fontSize: 22, fontWeight: 900, color: '#f5b333' }}>
            ฿{Number(order.total_amount).toFixed(0)}
          </span>
        </div>

        <p style={{ fontSize: 11.5, color: '#b3b8ca', marginTop: 14, textAlign: 'center' }}>
          หน้านี้รีเฟรชอัตโนมัติทุก 5 วินาที
        </p>
      </div>
    </main>
  );
}

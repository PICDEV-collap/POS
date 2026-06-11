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

  return (
    <main className="max-w-2xl mx-auto p-4">
      <header className="mb-4">
        <h1 className="text-2xl font-bold">ลำดับที่ {order.daily_seq || order.id}</h1>
        <p className="text-gray-500 text-sm">Order #{order.id}</p>
        <p className="text-gray-600">โต๊ะ {order.table_name}</p>
      </header>

      <div className="bg-white border rounded-xl p-4 mb-4">
        <div className="text-sm text-gray-500">สถานะ</div>
        <div className="text-xl font-bold text-brand">{STATUS_TH[order.status] || order.status}</div>
      </div>

      <h2 className="text-lg font-bold mb-2">รายการ</h2>
      <ul className="space-y-2">
        {order.items.map((it) => (
          <li key={it.id} className="bg-white border rounded-xl p-3 flex justify-between">
            <div>
              <div className="font-medium">{it.product_name} × {it.quantity}</div>
              <div className="text-xs font-bold mt-1" style={{ color: (it.fulfillment_type || order.order_type) === 'takeaway' ? '#d35400' : '#2980b9' }}>
                {(it.fulfillment_type || order.order_type) === 'takeaway' ? 'กลับบ้าน' : 'ทานที่ร้าน'}
              </div>
              {it.note ? <div className="text-sm text-gray-500">{it.note}</div> : null}
              <div className="text-xs text-gray-400 mt-1">{STATUS_TH[it.status] || it.status}</div>
            </div>
            <div className="font-bold text-brand">
              ฿{(Number(it.unit_price) * it.quantity).toFixed(2)}
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex justify-between text-lg font-bold border-t pt-3">
        <span>ยอดรวม</span>
        <span className="text-brand">฿{Number(order.total_amount).toFixed(2)}</span>
      </div>

      <p className="text-xs text-gray-400 mt-4">หน้านี้รีเฟรชอัตโนมัติทุก 5 วินาที</p>
    </main>
  );
}

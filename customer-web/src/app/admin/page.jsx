'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, authFetch, clearAuth } from '@/lib/auth';
import { apiBase } from '@/lib/api';
import { useRealtimeRecovery } from '@/lib/realtimeRecovery';
import { storageGet, storageSet } from '@/lib/browser';

const TABS = [
  { id: 'dashboard', label: '📊 ภาพรวม' },
  { id: 'orders',    label: '📋 ออเดอร์' },
  { id: 'accounting',label: '📒 บัญชี',    adminOnly: true },
  { id: 'products',  label: '🍽️ เมนู',     adminOnly: true },
  { id: 'categories',label: '📂 หมวด',     adminOnly: true },
  { id: 'tables',    label: '🪑 โต๊ะ',     adminOnly: true },
  { id: 'qrcodes',   label: '📲 QR Code' },
  { id: 'printer',   label: '🖨️ เครื่องพิมพ์', adminOnly: true },
  { id: 'printqueue',label: '📑 คิวพิมพ์' },
];

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

export default function AdminPage() {
  const router = useRouter();
  const [auth, setAuthState] = useState(null);
  const [tab, setTab] = useState('dashboard');

  useEffect(() => {
    const a = getAuth();
    if (!a) { router.replace('/login?next=/admin'); return; }
    if (a.user.role === 'kitchen') { router.replace('/kitchen'); return; }
    setAuthState(a);
  }, [router]);

  function logout() { clearAuth(); router.replace('/login'); }

  if (!auth) return null;
  const isAdmin = auth.user.role === 'admin';
  const visibleTabs = TABS.filter((t) => isAdmin || !t.adminOnly);
  const activeTab = visibleTabs.find((t) => t.id === tab) ? tab : 'dashboard';

  return (
    <main style={{ minHeight: 'var(--app-height, 100vh)', background: '#f0f0f5', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{
        background: 'linear-gradient(135deg,#1a1a2e,#16213e)', color: 'white',
        padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        position: 'sticky', top: 0, zIndex: 50, boxShadow: '0 2px 12px rgba(0,0,0,.3)'
      }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 18 }}>
            {isAdmin ? '⚙️ Admin Panel' : '👤 หน้าพนักงาน'}
          </div>
          <div style={{ opacity: .55, fontSize: 12 }}>
            {auth.user.full_name} · {auth.user.role}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a href="/staff" style={navLinkStyle}>🛒 รับออเดอร์</a>
          <a href="/kitchen" style={navLinkStyle}>🍳 ครัว</a>
          <button onClick={logout} style={{ ...navLinkStyle, background: 'rgba(239,71,111,.15)', color: '#ef476f', borderColor: 'rgba(239,71,111,.25)', border: '1px solid', cursor: 'pointer' }}>🚪 ออก</button>
        </div>
      </header>

      <nav style={{ background: 'white', padding: '8px 12px', display: 'flex', gap: 6,
                    overflowX: 'auto', boxShadow: '0 1px 4px rgba(0,0,0,.08)',
                    position: 'sticky', top: 56, zIndex: 40 }}>
        {visibleTabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
                  style={{ flex: 'none', padding: '7px 12px', borderRadius: 8, border: 'none',
                           fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                           background: activeTab === t.id ? '#1a1a2e' : 'transparent',
                           color: activeTab === t.id ? 'white' : '#666', cursor: 'pointer' }}>
            {t.label}
          </button>
        ))}
      </nav>

      <div style={{ padding: 16, maxWidth: 1280, margin: '0 auto' }}>
        {activeTab === 'dashboard'  && <DashboardTab />}
        {activeTab === 'orders'     && <OrdersTab />}
        {activeTab === 'accounting' && isAdmin && <AccountingTab />}
        {activeTab === 'products'   && isAdmin && <ProductsTab />}
        {activeTab === 'categories' && isAdmin && <CategoriesTab />}
        {activeTab === 'tables'     && isAdmin && <TablesTab />}
        {activeTab === 'qrcodes'    && <QRCodesTab />}
        {activeTab === 'printer'    && isAdmin && <PrinterTab />}
        {activeTab === 'printqueue' && <PrintQueueTab isAdmin={isAdmin} />}
      </div>
    </main>
  );
}

const navLinkStyle = {
  background: 'rgba(255,209,102,.15)', color: '#ffd166',
  border: '1px solid rgba(255,209,102,.25)', padding: '7px 14px',
  borderRadius: 20, textDecoration: 'none', fontSize: 12, fontWeight: 600,
};

const card = { background: 'white', borderRadius: 14, padding: 16,
               boxShadow: '0 2px 10px rgba(0,0,0,.05)', marginBottom: 12 };
const btnPrimary = { background: '#1a1a2e', color: 'white', border: 'none', borderRadius: 8,
                     padding: '8px 14px', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const btnSecondary = { background: '#f0f0f5', color: '#1a1a2e', border: 'none', borderRadius: 8,
                       padding: '8px 14px', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const btnDanger = { background: 'rgba(239,71,111,.15)', color: '#ef476f', border: 'none',
                    borderRadius: 8, padding: '8px 14px', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 8,
                     border: '1.5px solid #e5e5ea', fontSize: 14, outline: 'none', boxSizing: 'border-box' };

// ─────────────────────────────────────────────────────────────────────
function DashboardTab() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(async () => {
    try {
      const orders = await authFetch('/api/orders');
      const today = new Date().toISOString().slice(0, 10);
      const todayOrders = orders.filter((o) => o.created_at.slice(0, 10) === today);
      const active = orders.filter((o) => ['pending','cooking','served'].includes(o.status));
      const revenueToday = todayOrders
        .filter((o) => o.status === 'paid')
        .reduce((s, o) => s + Number(o.total_amount), 0);
      setStats({
        totalOrders: orders.length,
        todayOrders: todayOrders.length,
        activeOrders: active.length,
        revenueToday,
      });
      setError(null);
    } catch (e) { setError(e.message); }
  }, []);
  useRealtimeRecovery(reload, { intervalMs: 15000 });

  if (error) return <p style={{ color: '#c00' }}>{error}</p>;
  if (!stats) return <p>กำลังโหลด...</p>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
      <StatCard label="ออเดอร์วันนี้" value={stats.todayOrders} icon="📋" />
      <StatCard label="ยอดขายวันนี้" value={`฿${stats.revenueToday.toFixed(0)}`} icon="💰" highlight />
      <StatCard label="กำลังดำเนินการ" value={stats.activeOrders} icon="⏳" />
      <StatCard label="ออเดอร์ทั้งหมด" value={stats.totalOrders} icon="📦" />
    </div>
  );
}

function StatCard({ label, value, icon, highlight }) {
  return (
    <div style={{ ...card, marginBottom: 0,
                  background: highlight ? 'linear-gradient(135deg,#1a1a2e,#16213e)' : 'white',
                  color: highlight ? 'white' : '#1a1a2e' }}>
      <div style={{ fontSize: 11, opacity: .6, letterSpacing: 1 }}>{icon} {label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 4,
                    color: highlight ? '#ffd166' : '#1a1a2e' }}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
function OrdersTab() {
  const [orders, setOrders] = useState([]);
  const [filter, setFilter] = useState('active');
  const reload = useCallback(async () => {
    const list = await authFetch('/api/orders');
    setOrders(list);
  }, []);
  useRealtimeRecovery(reload, { intervalMs: 15000 });

  const filtered = filter === 'all'
    ? orders
    : filter === 'active'
      ? orders.filter((o) => ['pending','cooking','served'].includes(o.status))
      : orders.filter((o) => o.status === filter);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {['active', 'paid', 'all'].map((f) => (
          <button key={f} onClick={() => setFilter(f)}
                  style={{ ...btnSecondary, background: filter === f ? '#1a1a2e' : '#f0f0f5',
                           color: filter === f ? 'white' : '#1a1a2e' }}>
            {f === 'active' ? 'กำลังดำเนินการ' : f === 'paid' ? 'ชำระแล้ว' : 'ทั้งหมด'}
          </button>
        ))}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', borderRadius: 14, overflow: 'hidden' }}>
        <thead style={{ background: '#f8f8fa', fontSize: 12, color: '#888' }}>
          <tr>
            <th style={th}>#</th><th style={th}>โต๊ะ</th><th style={th}>สถานะ</th>
            <th style={th}>ยอด</th><th style={th}>เวลา</th><th style={th}>ที่มา</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((o) => (
            <tr key={o.id} style={{ borderTop: '1px solid #f0f0f5' }}>
              <td style={td}>#{o.id}</td>
              <td style={td}>{o.table_name}</td>
              <td style={td}>
                <span style={{ background: STATUS_BG[o.status] || '#eee', color: STATUS_FG[o.status] || '#333',
                               padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
                  {STATUS_LABEL[o.status] || o.status}
                </span>
              </td>
              <td style={td}>฿{Number(o.total_amount).toFixed(0)}</td>
              <td style={td}>{new Date(o.created_at).toLocaleString('th-TH')}</td>
              <td style={td}>{o.source}</td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan={6} style={{ textAlign: 'center', color: '#aaa', padding: 30 }}>ไม่มีข้อมูล</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
function AccountingTab() {
  const today = localDateInput();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from, to }).toString();
      setReport(await authFetch(`/api/accounting/summary?${qs}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { reload(); }, [reload]);

  async function downloadCsv(type) {
    const auth = getAuth();
    if (!auth?.token) return setError('not logged in');
    setExporting(type);
    setError(null);
    try {
      const qs = new URLSearchParams({ from, to, type }).toString();
      const res = await fetch(`${apiBase}/api/accounting/export?${qs}`, {
        cache: 'no-store',
        credentials: apiBase ? 'omit' : 'same-origin',
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const body = await res.json(); if (body.error) msg = body.error; } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pos-${type}-${from}-${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(null);
    }
  }

  const summary = report?.summary || {
    paid_orders: 0, items_sold: 0, gross_sales: 0, cogs: 0, gross_profit: 0, margin_pct: 0,
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>รายงานบัญชี Non-VAT</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                 style={{ ...inputStyle, width: 150 }} />
          <span style={{ color: '#888', fontSize: 12 }}>ถึง</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                 style={{ ...inputStyle, width: 150 }} />
          <button onClick={reload} style={btnSecondary} disabled={loading}>
            {loading ? 'กำลังโหลด...' : 'รีเฟรช'}
          </button>
        </div>
      </div>
      {error && <p style={{ color: '#c00' }}>{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 12 }}>
        <StatCard label="ยอดขาย" value={moneyText(summary.gross_sales)} icon="💰" highlight />
        <StatCard label="ต้นทุนขาย" value={moneyText(summary.cogs)} icon="📦" />
        <StatCard label="กำไรขั้นต้น" value={moneyText(summary.gross_profit)} icon="📈" />
        <StatCard label="Margin" value={`${Number(summary.margin_pct || 0).toFixed(1)}%`} icon="%" />
        <StatCard label="ออเดอร์ชำระแล้ว" value={summary.paid_orders} icon="✓" />
        <StatCard label="จำนวนที่ขาย" value={summary.items_sold} icon="×" />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {['summary', 'daily', 'payments', 'products', 'orders'].map((type) => (
          <button key={type} onClick={() => downloadCsv(type)}
                  disabled={exporting === type}
                  style={{ ...btnSecondary, fontSize: 12 }}>
            Export {type}{exporting === type ? '...' : ''}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        <ReportTable
          title="สรุปรายวัน"
          rows={report?.daily || []}
          columns={[
            ['business_date', 'วันที่'],
            ['paid_orders', 'บิล'],
            ['gross_sales', 'ยอดขาย', moneyText],
            ['cogs', 'ต้นทุน', moneyText],
            ['gross_profit', 'กำไร', moneyText],
          ]}
        />
        <ReportTable
          title="ช่องทางชำระเงิน"
          rows={report?.payments || []}
          columns={[
            ['payment_method', 'ช่องทาง'],
            ['paid_orders', 'บิล'],
            ['gross_sales', 'ยอดขาย', moneyText],
            ['gross_profit', 'กำไร', moneyText],
          ]}
        />
      </div>

      <ReportTable
        title="เมนูขายและกำไร"
        rows={report?.products || []}
        columns={[
          ['product_name', 'เมนู'],
          ['variant_name', 'ขนาด'],
          ['quantity', 'จำนวน'],
          ['gross_sales', 'ยอดขาย', moneyText],
          ['cogs', 'ต้นทุน', moneyText],
          ['gross_profit', 'กำไร', moneyText],
        ]}
      />

      <ReportTable
        title="รายการออเดอร์สำหรับบัญชี"
        rows={report?.orders || []}
        columns={[
          ['daily_seq', 'ลำดับ'],
          ['id', 'Order'],
          ['business_date', 'วันที่'],
          ['table_name', 'โต๊ะ/จุดขาย'],
          ['status', 'สถานะ'],
          ['payment_method', 'ชำระ'],
          ['gross_sales', 'ยอดขาย', moneyText],
          ['cogs', 'ต้นทุน', moneyText],
          ['gross_profit', 'กำไร', moneyText],
        ]}
      />
    </div>
  );
}

function ReportTable({ title, rows, columns }) {
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', fontWeight: 800, borderBottom: '1px solid #f0f0f5' }}>
        {title} ({rows.length})
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead style={{ background: '#f8f8fa', color: '#888' }}>
            <tr>{columns.map(([key, label]) => <th key={key} style={th}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={row.id || `${title}-${idx}`} style={{ borderTop: '1px solid #f0f0f5' }}>
                {columns.map(([key, _label, format]) => (
                  <td key={key} style={td}>{format ? format(row[key], row) : (row[key] ?? '—')}</td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={columns.length} style={{ textAlign: 'center', color: '#aaa', padding: 24 }}>ไม่มีข้อมูล</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function localDateInput(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

function moneyText(value) {
  return `฿${Number(value || 0).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const STATUS_LABEL = { pending: 'รอ', cooking: 'กำลังทำ', served: 'เสิร์ฟแล้ว', paid: 'ชำระแล้ว', cancelled: 'ยกเลิก' };
const STATUS_BG = { pending: '#fff0f0', cooking: '#fff8e1', served: '#e8f8f5', paid: '#f0f0f5', cancelled: '#ffe5e5' };
const STATUS_FG = { pending: '#c0392b', cooking: '#b8860b', served: '#06d6a0', paid: '#666', cancelled: '#c0392b' };
const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600 };
const td = { padding: '10px 12px', fontSize: 13 };

// ─────────────────────────────────────────────────────────────────────
function ProductsTab() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [stations, setStations] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | product object
  const [error, setError] = useState(null);
  const [barcodeBusy, setBarcodeBusy] = useState(null);

  const reload = useCallback(async () => {
    const [p, c, s] = await Promise.all([
      authFetch('/api/products/admin'),
      fetch(`${apiBase}/api/categories`).then(r => r.json()),
      authFetch('/api/print/stations').catch(() => []),
    ]);
    setProducts(p); setCategories(c); setStations(s);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function save(form, imageFile) {
    try {
      let saved;
      if (form.id) {
        saved = await authFetch(`/api/products/${form.id}`, { method: 'PUT', body: JSON.stringify(form) });
      } else {
        saved = await authFetch('/api/products', { method: 'POST', body: JSON.stringify(form) });
      }
      if (imageFile && saved?.id) {
        const fd = new FormData();
        fd.append('image', imageFile);
        await authFetch(`/api/products/${saved.id}/image`, { method: 'POST', body: fd });
      }
      setEditing(null); reload();
    } catch (e) { setError(e.message); }
  }
  async function clearImage(id) {
    if (!confirm('ลบรูปนี้?')) return;
    try { await authFetch(`/api/products/${id}/image`, { method: 'DELETE' }); reload(); }
    catch (e) { setError(e.message); }
  }
  async function del(id) {
    if (!confirm('ลบเมนูนี้ถาวร? ออเดอร์เก่ายังเก็บชื่อ+ราคาไว้ครบ')) return;
    setError(null);
    try {
      await authFetch(`/api/products/${id}`, { method: 'DELETE' });
      reload();
    } catch (e) { setError(e.message); }
  }
  async function toggleAvail(p) {
    try { await authFetch(`/api/products/${p.id}`, { method: 'PUT', body: JSON.stringify({ is_available: !p.is_available }) }); reload(); }
    catch (e) { setError(e.message); }
  }
  async function generateBarcode(p, force = false) {
    setBarcodeBusy(p.id);
    setError(null);
    try {
      const saved = await authFetch(`/api/products/${p.id}/barcode/generate${force ? '?force=1' : ''}`, {
        method: 'POST',
      });
      setProducts((list) => list.map((x) => (x.id === saved.id ? saved : x)));
    } catch (e) { setError(e.message); }
    finally { setBarcodeBusy(null); }
  }
  async function bulkGenerateSnackBarcodes() {
    setBarcodeBusy('bulk');
    setError(null);
    try {
      const snackCat = categories.find((c) => /(ขนม|ขบเคี้ยว|snack|ของกินเล่น)/i.test(c.name || ''));
      const result = await authFetch('/api/products/barcode/bulk-generate', {
        method: 'POST',
        body: JSON.stringify(snackCat ? { category_id: snackCat.id } : {}),
      });
      setError(`สร้าง barcode/ตั้งเป็นสต๊อกแล้ว ${result.updated_count || 0} รายการ`);
      reload();
    } catch (e) { setError(e.message); }
    finally { setBarcodeBusy(null); }
  }
  async function printBarcodeLabel(p) {
    setError(null);
    const w = window.open('', '_blank', 'width=420,height=320');
    if (!w) {
      setError('browser blocked popup');
      return;
    }
    w.document.open();
    w.document.write('<!doctype html><html><head><title>Barcode</title></head><body style="font-family:Arial,sans-serif;padding:16px">Loading barcode...</body></html>');
    w.document.close();
    try {
      const auth = getAuth();
      const res = await fetch(`${apiBase}/api/products/${p.id}/barcode/label.svg`, {
        cache: 'no-store',
        credentials: apiBase ? 'omit' : 'same-origin',
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const b = await res.json(); if (b.error) msg = b.error; } catch {}
        throw new Error(msg);
      }
      const svg = await res.text();
      w.document.open();
      w.document.write(`<!doctype html><html><head><title>Barcode ${p.barcode}</title>
        <style>
          @page { size: 50mm 30mm; margin: 2mm; }
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, sans-serif; }
          svg { width: 48mm; height: auto; }
          @media print { body { min-height: auto; } }
        </style></head><body>${svg}<script>setTimeout(function(){window.print()},250)</script></body></html>`);
      w.document.close();
    } catch (e) {
      w.close();
      setError(e.message);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>เมนูอาหาร ({products.length})</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={bulkGenerateSnackBarcodes}
                  disabled={barcodeBusy === 'bulk'}
                  style={btnSecondary}>
            {barcodeBusy === 'bulk' ? 'กำลังสร้าง...' : '📦 Generate barcode ขนม'}
          </button>
          <button onClick={() => setEditing('new')} style={btnPrimary}>+ เพิ่มเมนู</button>
        </div>
      </div>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
        {products.map((p) => {
          const cat = categories.find((c) => c.id === p.category_id);
          const price = Number(p.price || 0);
          const cost = Number(p.cost_price || 0);
          const profit = price - cost;
          const margin = price > 0 ? (profit / price) * 100 : 0;
          return (
            <div key={p.id} style={{ ...card, marginBottom: 0, opacity: p.is_available ? 1 : .5 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                {p.image_url && (
                  <img src={`${apiBase}${p.image_url}`} alt={p.name}
                       style={{ width: 60, height: 60, borderRadius: 8, objectFit: 'cover',
                                background: '#f5f5f7' }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>{cat?.name || '—'}</div>
                  <div style={{ color: '#e85d04', fontWeight: 700, marginTop: 4 }}>
                    ขาย ฿{price.toFixed(0)} · ต้นทุน ฿{cost.toFixed(0)}
                  </div>
                  <div style={{ fontSize: 11, color: profit >= 0 ? '#06a77d' : '#c0392b', marginTop: 2 }}>
                    กำไร/หน่วย ฿{profit.toFixed(0)} · margin {margin.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {(p.variants?.length || 0)} variants · {(p.options?.length || 0)} groups
                  </div>
                  <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
                    {p.product_type === 'stock' ? '📦 สต๊อก' : p.product_type === 'drink' ? '🥤 เครื่องดื่ม' : '🍳 อาหาร'}
                    {' · '}
                    {stations.find((s) => s.key === p.print_station_key)?.name || p.print_station_key || 'ครัว'}
                    {p.barcode ? ` · barcode ${p.barcode}` : ''}
                    {(p.track_stock || p.product_type === 'stock') ? ` · เหลือ ${Number(p.stock_qty || 0).toFixed(0)}` : ''}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <button onClick={() => toggleAvail(p)} style={{ ...btnSecondary, flex: 1, fontSize: 12 }}>
                  {p.is_available ? '🟢 พร้อมขาย' : '⛔ หมด'}
                </button>
                <button onClick={() => setEditing(p)} style={{ ...btnSecondary, fontSize: 12 }}>แก้</button>
                {p.barcode ? (
                  <button onClick={() => printBarcodeLabel(p)}
                          style={{ ...btnSecondary, fontSize: 12 }}>
                    พิมพ์ barcode
                  </button>
                ) : (
                  <button onClick={() => generateBarcode(p)}
                          disabled={barcodeBusy === p.id}
                          style={{ ...btnSecondary, fontSize: 12 }}>
                    {barcodeBusy === p.id ? 'กำลังสร้าง...' : 'สร้าง barcode'}
                  </button>
                )}
                {p.image_url && (
                  <button onClick={() => clearImage(p.id)}
                          style={{ ...btnSecondary, fontSize: 12 }} title="ลบรูป">🖼️✕</button>
                )}
                <button onClick={() => del(p.id)} style={{ ...btnDanger, fontSize: 12 }}>ลบ</button>
              </div>
            </div>
          );
        })}
      </div>
      {editing && <ProductModal initial={editing === 'new' ? null : editing} categories={categories}
                                stations={stations}
                                onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function ProductModal({ initial, categories, stations = [], onClose, onSave }) {
  const makeId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const normalizeVariant = (v, idx) => ({
    id: String(v?.id || makeId('variant')),
    name: String(v?.name || ''),
    price: v?.price ?? '',
    sort_order: v?.sort_order ?? idx,
    is_default: !!v?.is_default,
    is_available: v?.is_available !== false,
  });
  const normalizeGroup = (g, idx) => {
    const choices = Array.isArray(g?.choices) ? g.choices : [];
    const rawItems = Array.isArray(g?.items) ? g.items : choices.map((name) => ({ name }));
    const defaults = Array.isArray(g?.default_values) ? g.default_values.map(String) : [];
    const items = rawItems.map((it, itemIdx) => ({
      id: String(it?.id || makeId('option')),
      name: String(it?.name ?? it?.value ?? it ?? ''),
      price_delta: it?.price_delta ?? it?.extra_price ?? 0,
      is_default: !!it?.is_default || defaults.includes(String(it?.name ?? it?.value ?? it ?? '')),
      is_available: it?.is_available !== false,
      sort_order: it?.sort_order ?? itemIdx,
    }));
    const type = g?.type === 'multiple' || g?.selection_type === 'multiple' || g?.mutex === false ? 'multiple' : 'single';
    const required = g?.required ?? g?.is_required ?? true;
    return {
      id: String(g?.id || makeId('group')),
      name: String(g?.name || ''),
      type,
      required: !!required,
      min_select: g?.min_select ?? g?.min ?? (required ? 1 : 0),
      max_select: g?.max_select ?? g?.max ?? (type === 'single' ? 1 : Math.max(1, items.length)),
      is_available: g?.is_available !== false,
      visible_when: g?.visible_when || null,
      sort_order: g?.sort_order ?? idx,
      items,
    };
  };

  const [form, setForm] = useState({
    id: initial?.id, name: initial?.name || '', description: initial?.description || '',
    price: initial?.price ?? '', category_id: initial?.category_id ?? (categories[0]?.id ?? null),
    cost_price: initial?.cost_price ?? 0,
    sort_order: initial?.sort_order || 0,
    product_type: initial?.product_type || 'food',
    barcode: initial?.barcode || '',
    track_stock: initial?.track_stock ?? false,
    stock_qty: initial?.stock_qty ?? 0,
    stock_alert_qty: initial?.stock_alert_qty ?? 0,
    print_station_key: initial?.print_station_key || 'kitchen',
  });
  const [variants, setVariants] = useState(() => (Array.isArray(initial?.variants) ? initial.variants : [])
    .map(normalizeVariant));
  const [optionGroups, setOptionGroups] = useState(() => {
    const opts = initial?.options;
    if (!Array.isArray(opts)) return [];
    return opts.map(normalizeGroup).filter((g) => g.items.length > 0 || g.name);
  });
  const [drag, setDrag] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [preview, setPreview] = useState(initial?.image_url ? `${apiBase}${initial.image_url}` : null);
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function generateLocalBarcode() {
    const seed = form.id ? String(form.id).padStart(6, '0') : Date.now().toString().slice(-10);
    setForm((f) => ({
      ...f,
      barcode: `SNK${seed}`,
      product_type: 'stock',
      track_stock: true,
      print_station_key: 'snack',
    }));
  }

  function reorder(list, from, to) {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next.map((x, i) => ({ ...x, sort_order: i }));
  }
  function onDrop(kind, toIndex, groupIndex = null) {
    if (!drag || drag.kind !== kind) return;
    if (kind === 'variant') setVariants((list) => reorder(list, drag.index, toIndex));
    if (kind === 'group') setOptionGroups((list) => reorder(list, drag.index, toIndex));
    if (kind === 'item' && drag.groupIndex === groupIndex) {
      setOptionGroups((groups) => groups.map((g, gi) =>
        gi === groupIndex ? { ...g, items: reorder(g.items, drag.index, toIndex) } : g));
    }
    setDrag(null);
  }

  function addVariant() {
    setVariants((list) => [...list, normalizeVariant({ name: '', price: form.price || 0 }, list.length)]);
  }
  function setVariant(idx, patch) {
    setVariants((list) => list.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  }
  function removeVariant(idx) {
    setVariants((list) => list.filter((_, i) => i !== idx).map((v, i) => ({ ...v, sort_order: i })));
  }

  function addGroup() {
    setOptionGroups((g) => [...g, normalizeGroup({
      name: '',
      type: 'single',
      required: true,
      min_select: 1,
      max_select: 1,
      items: [],
    }, g.length)]);
  }
  function removeGroup(idx) {
    setOptionGroups((g) => g.filter((_, i) => i !== idx).map((x, i) => ({ ...x, sort_order: i })));
  }
  function setGroup(idx, patch) {
    setOptionGroups((g) => g.map((x, i) => {
      if (i !== idx) return x;
      const next = { ...x, ...patch };
      if (patch.type === 'single') {
        next.max_select = 1;
        next.min_select = next.required ? 1 : 0;
      }
      if (patch.required === false && next.min_select > 0) next.min_select = 0;
      return next;
    }));
  }
  function addChoice(idx) {
    setOptionGroups((g) => g.map((x, i) => (i === idx
      ? { ...x, items: [...x.items, {
          id: makeId('option'),
          name: '',
          price_delta: 0,
          is_default: false,
          is_available: true,
          sort_order: x.items.length,
        }] }
      : x)));
  }
  function setChoice(idx, ci, patch) {
    setOptionGroups((g) => g.map((x, i) =>
      (i === idx ? {
        ...x,
        items: x.items.map((item, k) => {
          if (k !== ci) return item;
          const next = { ...item, ...patch };
          if (patch.is_default && x.type === 'single') {
            return { ...next, is_default: true };
          }
          return next;
        }).map((item, k) => (patch.is_default && x.type === 'single' && k !== ci ? { ...item, is_default: false } : item)),
      } : x)));
  }
  function removeChoice(idx, ci) {
    setOptionGroups((g) => g.map((x, i) =>
      (i === idx ? { ...x, items: x.items.filter((_, k) => k !== ci).map((item, k) => ({ ...item, sort_order: k })) } : x)));
  }

  function validationErrors() {
    const errors = [];
    const basePrice = Number(form.price);
    const baseCost = Number(form.cost_price || 0);
    if (!form.name.trim()) errors.push('ต้องมีชื่อเมนู');
    if (form.price === '' || !Number.isFinite(basePrice) || basePrice < 0) errors.push('ราคาหลักไม่ถูกต้อง');
    if (!Number.isFinite(baseCost) || baseCost < 0) errors.push('ต้นทุนไม่ถูกต้อง');
    if (form.product_type === 'stock' && !String(form.barcode || '').trim()) errors.push('สินค้าสต๊อกควรมี barcode สำหรับสแกนหน้างาน');
    if ((form.track_stock || form.product_type === 'stock') && Number(form.stock_qty || 0) < 0) errors.push('จำนวนสต๊อกต้องไม่ติดลบ');
    const variantNames = new Set();
    variants.filter((v) => v.name.trim()).forEach((v) => {
      const key = v.name.trim().toLowerCase();
      if (variantNames.has(key)) errors.push(`variant ซ้ำ: ${v.name}`);
      variantNames.add(key);
      if (!Number.isFinite(Number(v.price)) || Number(v.price) < 0) errors.push(`ราคา variant "${v.name}" ไม่ถูกต้อง`);
    });
    const groupNames = new Set();
    optionGroups.filter((g) => g.name.trim()).forEach((g) => {
      const key = g.name.trim().toLowerCase();
      if (groupNames.has(key)) errors.push(`กลุ่มตัวเลือกซ้ำ: ${g.name}`);
      groupNames.add(key);
      const items = g.items.filter((it) => it.name.trim());
      if (items.length === 0) errors.push(`กลุ่ม "${g.name}" ต้องมีตัวเลือกอย่างน้อย 1 รายการ`);
      if (Number(g.min_select) < 0 || Number(g.max_select) < 1 || Number(g.max_select) < Number(g.min_select)) {
        errors.push(`min/max ของ "${g.name}" ไม่ถูกต้อง`);
      }
      if (g.type === 'single' && Number(g.max_select) !== 1) errors.push(`กลุ่ม single "${g.name}" ต้อง max = 1`);
      const itemNames = new Set();
      items.forEach((it) => {
        const itemKey = it.name.trim().toLowerCase();
        if (itemNames.has(itemKey)) errors.push(`ตัวเลือกซ้ำใน "${g.name}": ${it.name}`);
        itemNames.add(itemKey);
        if (!Number.isFinite(Number(it.price_delta))) errors.push(`ราคาเพิ่มของ "${it.name}" ไม่ถูกต้อง`);
      });
      if (g.visible_when?.group && g.visible_when.group === g.name) {
        errors.push(`เงื่อนไขของ "${g.name}" ห้ามอ้างตัวเอง`);
      }
    });
    return errors;
  }

  function buildPayload() {
    const cleanVariants = variants
      .map((v, idx) => ({
        id: v.id,
        name: v.name.trim(),
        price: Number(v.price),
        sort_order: idx,
        is_default: !!v.is_default,
        is_available: v.is_available !== false,
      }))
      .filter((v) => v.name && Number.isFinite(v.price) && v.price >= 0);
    const cleanGroups = optionGroups
      .map((g, idx) => {
        const items = g.items
          .map((it, itemIdx) => ({
            id: it.id,
            name: it.name.trim(),
            price_delta: Number(it.price_delta || 0),
            is_default: !!it.is_default,
            is_available: it.is_available !== false,
            sort_order: itemIdx,
          }))
          .filter((it) => it.name && Number.isFinite(it.price_delta));
        const type = g.type === 'multiple' ? 'multiple' : 'single';
        const max = type === 'single' ? 1 : Math.min(Math.max(Number(g.max_select) || 1, 1), Math.max(items.length, 1));
        const min = Math.min(Math.max(Number(g.min_select) || 0, 0), max);
        return {
          id: g.id,
          name: g.name.trim(),
          type,
          required: !!g.required,
          min_select: g.required ? Math.max(min, 1) : min,
          max_select: max,
          sort_order: idx,
          is_available: g.is_available !== false,
          choices: items.map((it) => it.name),
          default_values: items.filter((it) => it.is_default).map((it) => it.name),
          items,
          visible_when: g.visible_when?.group && (g.visible_when.values || []).length ? g.visible_when : null,
        };
      })
      .filter((g) => g.name && g.items.length > 0);
    return {
      ...form,
      price: Number(form.price),
      cost_price: Number(form.cost_price || 0),
      product_type: form.product_type || 'food',
      barcode: String(form.barcode || '').trim() || null,
      track_stock: !!form.track_stock || form.product_type === 'stock',
      stock_qty: Number(form.stock_qty || 0),
      stock_alert_qty: Number(form.stock_alert_qty || 0),
      print_station_key: form.print_station_key || null,
      variants: cleanVariants.length ? cleanVariants : null,
      options: cleanGroups.length ? cleanGroups : null,
    };
  }
  function onPick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { alert('ไฟล์ใหญ่เกิน 5MB'); return; }
    setImageFile(f);
    setPreview(URL.createObjectURL(f));
  }

  const errors = validationErrors();
  const canSave = errors.length === 0;
  const modalGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 };
  const sectionStyle = { borderTop: '1px solid #f0f0f5', marginTop: 12, paddingTop: 12 };
  const rowBox = { border: '1px solid #e5e5ea', borderRadius: 8, padding: 8, marginBottom: 8, background: '#fff' };
  const tinyBtn = { ...btnSecondary, fontSize: 12, padding: '6px 9px' };

  return (
    <Modal onClose={onClose} title={initial ? 'แก้ไขเมนู' : 'เพิ่มเมนู'}>
      <Field label="ชื่อเมนู">
        <input style={inputStyle} value={form.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="คำอธิบาย">
        <input style={inputStyle} value={form.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        <Field label="ราคา (บาท)">
          <input type="number" min="0" step="0.01" style={inputStyle} value={form.price}
                 onChange={(e) => set('price', e.target.value)} />
        </Field>
        <Field label="ต้นทุน/หน่วย (บาท)">
          <input type="number" min="0" step="0.01" style={inputStyle} value={form.cost_price}
                 onChange={(e) => set('cost_price', e.target.value)} />
        </Field>
        <Field label="หมวด">
          <select style={inputStyle} value={form.category_id || ''}
                  onChange={(e) => set('category_id', e.target.value ? Number(e.target.value) : null)}>
            <option value="">— เลือก —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ ...sectionStyle, borderTop: '1px solid #f0f0f5' }}>
        <strong style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>จุดผลิต / สต๊อก</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          <Field label="ประเภทสินค้า">
            <select style={inputStyle} value={form.product_type}
                    onChange={(e) => {
                      const type = e.target.value;
                      setForm((f) => ({
                        ...f,
                        product_type: type,
                        track_stock: type === 'stock' ? true : f.track_stock,
                        print_station_key: type === 'drink' ? 'drink' : type === 'stock' ? 'snack' : (f.print_station_key || 'kitchen'),
                      }));
                    }}>
              <option value="food">อาหาร</option>
              <option value="drink">เครื่องดื่ม</option>
              <option value="stock">สต๊อก / ขนมสแกนหน้างาน</option>
            </select>
          </Field>
          <Field label="จุดพิมพ์ใบครัว">
            <select style={inputStyle} value={form.print_station_key || ''}
                    onChange={(e) => set('print_station_key', e.target.value || null)}>
              <option value="kitchen">ครัว / อาหาร</option>
              <option value="drink">เครื่องดื่ม</option>
              <option value="snack">ขนม / สต๊อก</option>
              {stations
                .filter((s) => !['kitchen', 'drink', 'snack'].includes(s.key))
                .map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Barcode / SKU">
            <div style={{ display: 'flex', gap: 6 }}>
              <input style={{ ...inputStyle, flex: 1 }} value={form.barcode || ''}
                     placeholder="ยิงบาร์โค้ดหรือกด Generate"
                     onChange={(e) => set('barcode', e.target.value)} />
              <button type="button" onClick={generateLocalBarcode}
                      style={{ ...btnSecondary, padding: '8px 10px', whiteSpace: 'nowrap' }}>
                Generate
              </button>
            </div>
          </Field>
          <Field label="จำนวนคงเหลือ">
            <input type="number" min="0" step="1" style={inputStyle}
                   value={form.stock_qty}
                   onChange={(e) => set('stock_qty', e.target.value)} />
          </Field>
          <Field label="แจ้งเตือนเมื่อเหลือ">
            <input type="number" min="0" step="1" style={inputStyle}
                   value={form.stock_alert_qty}
                   onChange={(e) => set('stock_alert_qty', e.target.value)} />
          </Field>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 6 }}>
          <input type="checkbox" checked={!!form.track_stock || form.product_type === 'stock'}
                 disabled={form.product_type === 'stock'}
                 onChange={(e) => set('track_stock', e.target.checked)} />
          ตัดสต๊อกอัตโนมัติเมื่อบันทึกออเดอร์
        </label>
      </div>
      <Field label="รูปเมนู (jpg/png/webp ≤ 5MB)">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {preview && (
            <img src={preview} alt="preview"
                 style={{ width: 70, height: 70, borderRadius: 8, objectFit: 'cover',
                          background: '#f5f5f7' }} />
          )}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onPick} />
        </div>
        {imageFile && (
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            {imageFile.name} · {Math.round(imageFile.size / 1024)} KB — จะอัพโหลดตอนกดบันทึก
          </div>
        )}
      </Field>

      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 14 }}>ขนาด / Variant</strong>
          <button type="button" onClick={addVariant} style={tinyBtn}>+ เพิ่มขนาด</button>
        </div>
        {variants.map((v, i) => (
          <div key={v.id} draggable
               onDragStart={() => setDrag({ kind: 'variant', index: i })}
               onDragOver={(e) => e.preventDefault()}
               onDrop={() => onDrop('variant', i)}
               style={rowBox}>
            <div style={modalGrid}>
              <Field label="ชื่อขนาด">
                <input style={inputStyle} placeholder="เช่น พิเศษ / ใหญ่"
                       value={v.name} onChange={(e) => setVariant(i, { name: e.target.value })} />
              </Field>
              <Field label="ราคาเต็ม">
                <input type="number" min="0" step="0.01" style={inputStyle}
                       value={v.price} onChange={(e) => setVariant(i, { price: e.target.value })} />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
              <label style={{ fontSize: 12 }}>
                <input type="checkbox" checked={v.is_available}
                       onChange={(e) => setVariant(i, { is_available: e.target.checked })} /> พร้อมขาย
              </label>
              <button type="button" onClick={() => removeVariant(i)} style={{ ...btnDanger, fontSize: 12, padding: '6px 9px' }}>
                ลบ
              </button>
            </div>
          </div>
        ))}
      </div>

      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <strong style={{ fontSize: 14 }}>Option groups</strong>
          <button type="button" onClick={addGroup} style={tinyBtn}>+ เพิ่มกลุ่ม</button>
        </div>
        {optionGroups.map((g, i) => (
          <div key={g.id} draggable
               onDragStart={() => setDrag({ kind: 'group', index: i })}
               onDragOver={(e) => e.preventDefault()}
               onDrop={() => onDrop('group', i)}
               style={rowBox}>
            <div style={modalGrid}>
              <Field label="ชื่อกลุ่ม">
                <input style={inputStyle} placeholder="เช่น ความเผ็ด / Add-ons"
                       value={g.name} onChange={(e) => setGroup(i, { name: e.target.value })} />
              </Field>
              <Field label="ประเภท">
                <select style={inputStyle} value={g.type}
                        onChange={(e) => setGroup(i, {
                          type: e.target.value,
                          required: e.target.value === 'single' ? g.required : false,
                          min_select: e.target.value === 'single' ? (g.required ? 1 : 0) : 0,
                          max_select: e.target.value === 'single' ? 1 : Math.max(1, g.items.length),
                        })}>
                  <option value="single">เลือกได้ 1 (mutex)</option>
                  <option value="multiple">เลือกได้หลายรายการ</option>
                </select>
              </Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
              <label style={{ fontSize: 12 }}>
                <input type="checkbox" checked={g.required}
                       onChange={(e) => setGroup(i, {
                         required: e.target.checked,
                         min_select: e.target.checked ? Math.max(1, Number(g.min_select) || 1) : 0,
                       })} /> required
              </label>
              <Field label="Min">
                <input type="number" min="0" style={inputStyle} value={g.min_select}
                       onChange={(e) => setGroup(i, { min_select: Number(e.target.value) })} />
              </Field>
              <Field label="Max">
                <input type="number" min="1" disabled={g.type === 'single'} style={inputStyle} value={g.max_select}
                       onChange={(e) => setGroup(i, { max_select: Number(e.target.value) })} />
              </Field>
              <Field label="แสดงเมื่อ">
                <select style={inputStyle} value={g.visible_when?.group || ''}
                        onChange={(e) => setGroup(i, {
                          visible_when: e.target.value ? { group: e.target.value, values: [] } : null,
                        })}>
                  <option value="">เสมอ</option>
                  {optionGroups.filter((_, idx) => idx !== i && _.name.trim()).map((other) => (
                    <option key={other.id} value={other.name}>{other.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            {g.visible_when?.group && (
              <Field label="ค่าที่ทำให้แสดง (คั่นด้วย comma)">
                <input style={inputStyle}
                       value={(g.visible_when.values || []).join(', ')}
                       onChange={(e) => setGroup(i, {
                         visible_when: {
                           group: g.visible_when.group,
                           values: e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
                         },
                       })} />
              </Field>
            )}

            <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
              {g.items.map((c, ci) => (
                <div key={c.id} draggable
                     onDragStart={() => setDrag({ kind: 'item', groupIndex: i, index: ci })}
                     onDragOver={(e) => e.preventDefault()}
                     onDrop={() => onDrop('item', ci, i)}
                     style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) 110px 86px 42px', gap: 6, alignItems: 'center' }}>
                  <input style={inputStyle} placeholder="ชื่อตัวเลือก"
                         value={c.name} onChange={(e) => setChoice(i, ci, { name: e.target.value })} />
                  <input type="number" step="0.01" style={inputStyle} placeholder="+ราคา"
                         value={c.price_delta}
                         onChange={(e) => setChoice(i, ci, { price_delta: e.target.value })} />
                  <label style={{ fontSize: 12 }}>
                    <input type="checkbox" checked={!!c.is_default}
                           onChange={(e) => setChoice(i, ci, { is_default: e.target.checked })} /> default
                  </label>
                  <button type="button" onClick={() => removeChoice(i, ci)}
                          style={{ ...btnDanger, padding: '7px 0' }}>×</button>
                </div>
              ))}
              <button type="button" onClick={() => addChoice(i)} style={{ ...tinyBtn, justifySelf: 'start' }}>
                + ตัวเลือก
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <label style={{ fontSize: 12 }}>
                <input type="checkbox" checked={g.is_available}
                       onChange={(e) => setGroup(i, { is_available: e.target.checked })} /> เปิดใช้งาน
              </label>
              <button type="button" onClick={() => removeGroup(i)} style={{ ...btnDanger, fontSize: 12, padding: '6px 9px' }}>
                ลบกลุ่ม
              </button>
            </div>
          </div>
        ))}
      </div>

      {errors.length > 0 && (
        <div style={{ background: '#fff0f0', color: '#c0392b', borderRadius: 8, padding: 10, fontSize: 12, marginTop: 12 }}>
          {errors.map((e) => <div key={e}>• {e}</div>)}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button onClick={onClose} style={btnSecondary}>ยกเลิก</button>
        <button onClick={() => onSave(buildPayload(), imageFile)}
                disabled={!canSave} style={{ ...btnPrimary, opacity: canSave ? 1 : .5 }}>บันทึก</button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
function CategoriesTab() {
  const [cats, setCats] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(async () => {
    try {
      const list = await authFetch('/api/categories/all');
      setCats(list);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function save(form) {
    setError(null);
    try {
      if (form.id) await authFetch(`/api/categories/${form.id}`, { method: 'PUT', body: JSON.stringify(form) });
      else await authFetch('/api/categories', { method: 'POST', body: JSON.stringify(form) });
      setEditing(null); reload();
    } catch (e) { setError(e.message); }
  }
  async function del(id) {
    if (!confirm('ลบหมวดนี้ถาวร? เมนูในหมวดนี้จะยังอยู่แต่ category_id เป็น null')) return;
    setError(null);
    try {
      await authFetch(`/api/categories/${id}`, { method: 'DELETE' });
      reload();
    } catch (e) { setError(e.message); }
  }
  async function setActive(id, isActive) {
    setError(null);
    try {
      await authFetch(`/api/categories/${id}`, {
        method: 'PUT', body: JSON.stringify({ is_active: isActive }),
      });
      reload();
    } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>หมวดเมนู ({cats.length})</h2>
        <button onClick={() => setEditing('new')} style={btnPrimary}>+ เพิ่มหมวด</button>
      </div>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      <div style={{ ...card }}>
        {cats.map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', padding: '10px 0',
                                   borderBottom: '1px solid #f0f0f5', opacity: c.is_active ? 1 : .4 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{c.name}</div>
              <div style={{ fontSize: 11, color: '#888' }}>order: {c.sort_order} · {c.is_active ? 'เปิดใช้' : 'ปิด'}</div>
            </div>
            <button onClick={() => setEditing(c)} style={{ ...btnSecondary, marginRight: 6 }}>แก้</button>
            <button onClick={() => setActive(c.id, !c.is_active)}
                    style={{ ...btnSecondary, marginRight: 6 }}>
              {c.is_active ? 'ปิดใช้' : 'เปิดใช้'}
            </button>
            <button onClick={() => del(c.id)} style={btnDanger}>ลบ</button>
          </div>
        ))}
      </div>
      {editing && <CategoryModal initial={editing === 'new' ? null : editing}
                                  onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function CategoryModal({ initial, onClose, onSave }) {
  const [form, setForm] = useState({
    id: initial?.id, name: initial?.name || '', sort_order: initial?.sort_order || 0,
    is_active: initial?.is_active ?? true,
  });
  return (
    <Modal onClose={onClose} title={initial ? 'แก้ไขหมวด' : 'เพิ่มหมวด'}>
      <Field label="ชื่อหมวด">
        <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="ลำดับ">
        <input type="number" style={inputStyle} value={form.sort_order}
               onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} />
      </Field>
      {initial && (
        <Field label="">
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={form.is_active}
                   onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            {' '}เปิดใช้งาน
          </label>
        </Field>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button onClick={onClose} style={btnSecondary}>ยกเลิก</button>
        <button onClick={() => onSave(form)} disabled={!form.name} style={btnPrimary}>บันทึก</button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
function TablesTab() {
  const [tables, setTables] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [rotatingAll, setRotatingAll] = useState(false);

  const reload = useCallback(async () => {
    const list = await authFetch('/api/tables');
    setTables(list);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function save(form) {
    try {
      if (form.id) await authFetch(`/api/tables/${form.id}`, { method: 'PUT', body: JSON.stringify(form) });
      else await authFetch('/api/tables', { method: 'POST', body: JSON.stringify(form) });
      setEditing(null); reload();
    } catch (e) { setError(e.message); }
  }
  async function rotate(id) {
    if (!confirm('สร้าง QR token ใหม่? — token เก่าจะใช้ไม่ได้')) return;
    try { await authFetch(`/api/tables/${id}/rotate-qr`, { method: 'POST' }); reload(); }
    catch (e) { setError(e.message); }
  }
  async function rotateAll() {
    if (!confirm('ยกเลิก QR เก่าทุกใบและสร้าง token ใหม่ทุกโต๊ะ? ลูกค้าต้องสแกน QR ที่พิมพ์ใหม่เท่านั้น')) return;
    setRotatingAll(true);
    try {
      const result = await authFetch('/api/tables/rotate-qr-all', { method: 'POST' });
      setError(`ยกเลิก QR เก่าทั้งหมดแล้ว · สร้างใหม่ ${result.rotated_count || 0} จุด`);
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setRotatingAll(false);
    }
  }
  async function del(id) {
    if (!confirm('ลบโต๊ะนี้? ถ้ามีประวัติออเดอร์ ระบบจะปิดใช้งานแทนเพื่อเก็บประวัติขายไว้')) return;
    try {
      const result = await authFetch(`/api/tables/${id}`, { method: 'DELETE' });
      if (result?.deactivated) setError(`ปิดใช้งานโต๊ะ "${result.name}" แล้ว เพราะมีประวัติออเดอร์`);
      reload();
    }
    catch (e) { setError(e.message); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>โต๊ะ ({tables.length})</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={rotateAll} disabled={rotatingAll} style={btnDanger}>
            {rotatingAll ? 'กำลังยกเลิก...' : 'ยกเลิก QR เก่าทั้งหมด'}
          </button>
          <button onClick={() => setEditing('new')} style={btnPrimary}>+ เพิ่มโต๊ะ</button>
        </div>
      </div>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      <div style={{ ...card }}>
        {tables.map((t) => {
          const isTakeaway = t.is_takeaway || t.code === 'TAKEAWAY' || Number(t.seats) === 0;
          return (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', padding: '10px 0',
                                     borderBottom: '1px solid #f0f0f5', opacity: t.is_active ? 1 : .4 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{t.code} · {t.name}</div>
                <div style={{ fontSize: 11, color: '#888' }}>
                  {isTakeaway ? 'จุดสั่งกลับบ้าน' : `${t.seats} ที่นั่ง`} · QR: {t.qr_token.slice(0, 8)}…
                </div>
              </div>
              <button onClick={() => rotate(t.id)} style={{ ...btnSecondary, marginRight: 6 }} title="รี-สร้าง QR">🔄 QR</button>
              <button onClick={() => setEditing(t)} style={{ ...btnSecondary, marginRight: 6 }}>แก้</button>
              <button onClick={() => del(t.id)} style={btnDanger}>ลบ</button>
            </div>
          );
        })}
      </div>
      {editing && <TableModal initial={editing === 'new' ? null : editing}
                              onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function TableModal({ initial, onClose, onSave }) {
  const [form, setForm] = useState({
    id: initial?.id, code: initial?.code || '', name: initial?.name || '',
    seats: initial?.seats ?? 4, is_active: initial?.is_active ?? true,
  });
  return (
    <Modal onClose={onClose} title={initial ? 'แก้ไขโต๊ะ' : 'เพิ่มโต๊ะ'}>
      <Field label="รหัสโต๊ะ (เช่น A1)">
        <input style={inputStyle} value={form.code} disabled={!!initial}
               onChange={(e) => setForm({ ...form, code: e.target.value })} />
      </Field>
      <Field label="ชื่อ">
        <input style={inputStyle} value={form.name}
               onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="ที่นั่ง">
        <input type="number" min="0" style={inputStyle} value={form.seats}
               onChange={(e) => setForm({ ...form, seats: Number(e.target.value) })} />
      </Field>
      {initial && (
        <Field label="">
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={form.is_active}
                   onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            {' '}เปิดใช้งาน
          </label>
        </Field>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button onClick={onClose} style={btnSecondary}>ยกเลิก</button>
        <button onClick={() => onSave(form)} disabled={!form.code || !form.name} style={btnPrimary}>บันทึก</button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
function QRCodesTab() {
  const [tables, setTables] = useState([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [publicBase, setPublicBase] = useState(null); // from backend .env
  const [lanBase, setLanBase] = useState(null);
  const [wifiOnlyQr, setWifiOnlyQr] = useState(false);
  const [gpsGuardEnabled, setGpsGuardEnabled] = useState(false);

  // Resolution order for QR base URL:
  //   1. localStorage override (admin's last-typed value — most specific)
  //   2. LAN origin when ordering is WiFi/LAN-only
  //   3. backend's PUBLIC_BASE_URL (Caddy domain / ngrok tunnel)
  //   3. NEXT_PUBLIC_PUBLIC_BASE build-time env
  //   4. window.location.origin (LAN fallback — won't work for external QR scan)
  useEffect(() => {
    (async () => {
      let resolved = null;
      let settings = null;
      let discoveryLanRoot = null;
      try {
        const res = await fetch(`${apiBase}/api/discovery/info`);
        const j = await res.json();
        if (j.public_base_url) {
          resolved = trimOrderRoot(j.public_base_url);
          setPublicBase(j.public_base_url);
        }
        discoveryLanRoot = trimOrderRoot(lanWebRootFromDiscovery(j));
        if (discoveryLanRoot) setLanBase(discoveryLanRoot);
      } catch {}
      try {
        settings = await fetch(`${apiBase}/api/settings`, { cache: 'no-store' }).then((r) => r.json());
      } catch {}
      const wifiOnly = !!settings?.ordering_require_private_ip;
      setGpsGuardEnabled(!!settings?.ordering_require_gps);
      setWifiOnlyQr(wifiOnly);
      const stored = trimOrderRoot(storageGet('pos_v2_qr_base'));
      const envBase = trimOrderRoot(process.env.NEXT_PUBLIC_PUBLIC_BASE);
      const lanRoot = localQrRoot();
      const root = wifiOnly
        ? (stored && isLanLikeUrl(stored) ? stored : (discoveryLanRoot || lanRoot))
        : (stored || resolved || envBase || lanRoot);
      setBaseUrl(`${trimOrderRoot(root)}/order`);
      authFetch('/api/tables').then((list) => setTables(list.filter((t) => t.is_active)));
    })();
  }, []);

  function persistBase(v) {
    setBaseUrl(v);
    try {
      const root = v.replace(/\/order\/?$/, '');
      storageSet('pos_v2_qr_base', root);
    } catch {}
  }

  return (
    <div>
      <div style={{ ...card }}>
        <Field label="URL ฐานสำหรับ QR (ลูกค้าจะถูกพาไปที่ URL นี้พร้อม ?t=token)">
          <input style={inputStyle} value={baseUrl} onChange={(e) => persistBase(e.target.value)} />
        </Field>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {lanBase && (
            <button type="button" style={btnSecondary} onClick={() => persistBase(`${lanBase}/order`)}>
              ใช้ LAN / WiFi ร้าน
            </button>
          )}
          {publicBase && (
            <button type="button" style={btnSecondary} onClick={() => persistBase(`${trimOrderRoot(publicBase)}/order`)}>
              ใช้ Public / ทดสอบ GPS
            </button>
          )}
        </div>
        <p style={{ fontSize: 12, color: '#888', margin: '6px 0 0' }}>
          {wifiOnlyQr
            ? <>โหมดรับเฉพาะ WiFi ร้าน: QR จะใช้ URL ภายในร้านเป็นหลัก</>
            : gpsGuardEnabled
            ? <>GPS guard เปิดอยู่: ใช้ปุ่ม LAN เพื่อทดสอบ WiFi bypass หรือใช้ Public/ngrok เพื่อทดสอบ GPS จริง</>
            : publicBase
            ? <>ค่าจาก backend <code>PUBLIC_BASE_URL</code>: <code>{publicBase}</code> · ค่าที่กรอกที่นี่จะถูกจำใน browser</>
            : <>ตั้งใน <code>backend/.env</code> ค่า <code>PUBLIC_BASE_URL=https://...</code> (Caddy domain หรือ ngrok URL) แล้ว restart — หรือกรอกตรงนี้เพื่อใช้ในเครื่องนี้เครื่องเดียว</>}
        </p>
        {wifiOnlyQr && publicBase && (
          <p style={{ fontSize: 12, color: '#8a6500', margin: '6px 0 0' }}>
            มี <code>PUBLIC_BASE_URL</code> อยู่ แต่ไม่ได้ใช้เป็นค่าเริ่มต้นของ QR ลูกค้าในโหมดกันสั่งนอกร้าน
          </p>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {tables.map((t) => {
          const isTakeaway = t.is_takeaway || t.code === 'TAKEAWAY' || Number(t.seats) === 0;
          const url = `${baseUrl}?t=${t.qr_token}`;
          const qrSrc = `${apiBase}/api/qr?size=240&text=${encodeURIComponent(url)}`;
          return (
            <div key={t.id} style={{ ...card, marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{t.name}</div>
              <div style={{ fontSize: 11, color: '#888' }}>
                {t.code}{isTakeaway ? ' · จุดสั่งกลับบ้าน' : ''}
              </div>
              <img src={qrSrc} alt={`QR ${t.code}`}
                   style={{ width: '100%', maxWidth: 200, height: 'auto', margin: '10px auto', borderRadius: 8 }} />
              <button onClick={() => window.open(qrSrc, '_blank')} style={btnSecondary}>
                เปิดรูป
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
function PrinterTab() {
  const [config, setConfig] = useState(null);
  const [settings, setSettings] = useState(null);     // restaurant_settings
  const [paymentDraft, setPaymentDraft] = useState(null);
  const [orderingDraft, setOrderingDraft] = useState(null);
  const [stations, setStations] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingOrdering, setSavingOrdering] = useState(false);
  const [savingStationKey, setSavingStationKey] = useState(null);

  useEffect(() => {
    authFetch('/api/print/config').then(setConfig).catch((e) => setError(e.message));
    authFetch('/api/print/stations').then(setStations).catch(() => setStations([]));
    fetch(`${apiBase}/api/settings`).then((r) => r.json()).then((s) => {
      setSettings(s);
      setPaymentDraft(paymentDraftFromSettings(s));
      setOrderingDraft(orderingDraftFromSettings(s));
    }).catch(() => {});
  }, []);

  async function testPrint() {
    setResult(null); setError(null);
    try {
      const r = await authFetch('/api/print/test', { method: 'POST' });
      setResult(r);
    } catch (e) { setError(e.message); }
  }

  async function reloadStations() {
    const list = await authFetch('/api/print/stations');
    setStations(list);
  }

  function setStationField(key, field, value) {
    setStations((list) => list.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
  }

  function applyPaperPreset(key, preset) {
    const next = preset === '80mm'
      ? { paper_width_mm: 80, paper_height_mm: 0, paper_gap_mm: 0, width_chars: 48, width_px: 576, feed_lines: 6, bottom_feed_px: 180 }
      : { paper_width_mm: 58, paper_height_mm: 0, paper_gap_mm: 0, width_chars: 42, width_px: 384, feed_lines: 6, bottom_feed_px: 160 };
    setStations((list) => list.map((s) => (s.key === key ? { ...s, ...next } : s)));
  }

  async function saveStation(station) {
    setSavingStationKey(station.key);
    setError(null);
    try {
      const saved = await authFetch(`/api/print/stations/${station.key}`, {
        method: 'PUT',
        body: JSON.stringify(station),
      });
      setStations((list) => list.map((s) => (s.key === saved.key ? saved : s)));
      setResult({
        saved_station: saved.key,
        printer_host: saved.printer_host,
        printer_port: saved.printer_port,
        paper_width_mm: saved.paper_width_mm,
        width_px: saved.width_px,
        feed_lines: saved.feed_lines,
        bottom_feed_px: saved.bottom_feed_px,
        cut_mode: saved.cut_mode,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingStationKey(null);
    }
  }

  async function testStation(station) {
    setError(null);
    try {
      const r = await authFetch(`/api/print/stations/${station.key}/test`, { method: 'POST' });
      setResult(r);
    } catch (e) {
      setError(e.message);
    }
  }

  async function checkStation(station) {
    setError(null);
    try {
      const r = await authFetch(`/api/print/stations/${station.key}/health/check`, { method: 'POST' });
      setResult({ station_key: station.key, ...r });
      reloadStations();
    } catch (e) {
      setError(e.message);
    }
  }

  async function toggleAuto(field, value) {
    setError(null);
    try {
      const updated = await authFetch('/api/settings', {
        method: 'PUT', body: JSON.stringify({ [field]: value }),
      });
      setSettings(updated);
      setOrderingDraft(orderingDraftFromSettings(updated));
      setGpsGuardEnabled(!!updated.ordering_require_gps);
    } catch (e) { setError(e.message); }
  }

  function paymentDraftFromSettings(s) {
    return {
      payment_qr_enabled: !!s.payment_qr_enabled,
      payment_qr_type: s.payment_qr_type || 'promptpay',
      payment_qr_id: s.payment_qr_id || '',
      payment_qr_raw_payload: s.payment_qr_raw_payload || '',
      payment_qr_account_name: s.payment_qr_account_name || '',
      payment_qr_label: s.payment_qr_label || 'สแกนจ่ายเงิน',
      payment_qr_include_amount: s.payment_qr_include_amount !== false,
      payment_qr_ref1_prefix: s.payment_qr_ref1_prefix || 'ORDER',
      payment_qr_ref2: s.payment_qr_ref2 || '',
      payment_auto_close_enabled: s.payment_auto_close_enabled !== false,
    };
  }

  function orderingDraftFromSettings(s) {
    return {
      ordering_enabled: s.ordering_enabled !== false,
      ordering_open_time: String(s.ordering_open_time || '00:00').slice(0, 5),
      ordering_close_time: String(s.ordering_close_time || '23:59').slice(0, 5),
      ordering_timezone: s.ordering_timezone || 'Asia/Bangkok',
      ordering_require_session: s.ordering_require_session !== false,
      ordering_require_private_ip: false,
      ordering_require_gps: !!s.ordering_require_gps,
      ordering_shop_lat: s.ordering_shop_lat ?? '',
      ordering_shop_lng: s.ordering_shop_lng ?? '',
      ordering_max_distance_m: s.ordering_max_distance_m || 20,
    };
  }

  function setPaymentField(field, value) {
    setPaymentDraft((d) => ({ ...(d || paymentDraftFromSettings(settings || {})), [field]: value }));
  }

  function setOrderingField(field, value) {
    setOrderingDraft((d) => ({ ...(d || orderingDraftFromSettings(settings || {})), [field]: value }));
  }

  async function saveOrdering() {
    if (!orderingDraft) return;
    const payload = {
      ...orderingDraft,
      ordering_require_private_ip: false,
      ordering_shop_lat: orderingDraft.ordering_shop_lat === '' ? null : Number(orderingDraft.ordering_shop_lat),
      ordering_shop_lng: orderingDraft.ordering_shop_lng === '' ? null : Number(orderingDraft.ordering_shop_lng),
      ordering_max_distance_m: Number(orderingDraft.ordering_max_distance_m || 20),
    };
    if (payload.ordering_require_gps && (!Number.isFinite(payload.ordering_shop_lat) || !Number.isFinite(payload.ordering_shop_lng))) {
      setError('ต้องตั้งค่าพิกัดร้านก่อนเปิด GPS guard');
      return;
    }
    setSavingOrdering(true);
    setError(null);
    try {
      const updated = await authFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setSettings(updated);
      setOrderingDraft(orderingDraftFromSettings(updated));
      setGpsGuardEnabled(!!updated.ordering_require_gps);
      setResult({ saved: true, ordering_enabled: updated.ordering_enabled });
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingOrdering(false);
    }
  }

  async function captureShopLocation() {
    setError(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('เครื่องนี้ไม่รองรับ GPS ใน browser');
      return;
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setError('การดึง GPS บน browser ต้องใช้ HTTPS หรือ localhost');
      return;
    }
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 15000,
        });
      });
      setOrderingDraft((d) => ({
        ...(d || orderingDraftFromSettings(settings || {})),
        ordering_shop_lat: Number(pos.coords.latitude).toFixed(7),
        ordering_shop_lng: Number(pos.coords.longitude).toFixed(7),
      }));
    } catch {
      setError('อ่านตำแหน่งร้านไม่สำเร็จ กรุณาอนุญาต GPS หรือกรอกพิกัดเอง');
    }
  }

  async function savePaymentQr() {
    if (!paymentDraft) return;
    setSavingPayment(true);
    setError(null);
    try {
      const updated = await authFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(paymentDraft),
      });
      setSettings(updated);
      setPaymentDraft(paymentDraftFromSettings(updated));
      setOrderingDraft(orderingDraftFromSettings(updated));
      setGpsGuardEnabled(!!updated.ordering_require_gps);
      setResult({ saved: true, payment_qr_type: updated.payment_qr_type, payment_qr_enabled: updated.payment_qr_enabled });
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingPayment(false);
    }
  }

  if (!config) return <p>กำลังโหลด...</p>;
  const qrType = paymentDraft?.payment_qr_type || 'promptpay';
  return (
    <div>
      <div style={{ ...card }}>
        <h3 style={{ margin: 0, marginBottom: 10 }}>🤖 พิมพ์อัตโนมัติเมื่อมีออเดอร์</h3>
        <p style={{ fontSize: 12, color: '#888', margin: '0 0 10px' }}>
          เมื่อเปิด → backend จะคิวพิมพ์ใบครัว/ใบเสร็จทันทีที่ลูกค้า/พนักงานยืนยันออเดอร์
          ใบจะถูกส่งหา print server/raw TCP ที่ตั้งในแต่ละจุดพิมพ์ ส่วน BLE printer (มือถือ) เปิดใน app เอง
        </p>
        {settings ? (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
              <input type="checkbox" checked={!!settings.auto_print_kitchen}
                     onChange={(e) => toggleAuto('auto_print_kitchen', e.target.checked)} />
              <span>🍳 พิมพ์ใบครัวอัตโนมัติ</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
              <input type="checkbox" checked={!!settings.auto_print_receipt}
                     onChange={(e) => toggleAuto('auto_print_receipt', e.target.checked)} />
              <span>🧾 พิมพ์ใบเสร็จลูกค้าอัตโนมัติ</span>
            </label>
            <p style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              💡 ทั่วไปเปิดเฉพาะใบครัว ใบเสร็จลูกค้ามักพิมพ์ตอน "ชำระแล้ว" จากปุ่ม 🖨️
            </p>
          </>
        ) : <p style={{ fontSize: 12, color: '#888' }}>กำลังโหลดการตั้งค่า...</p>}
      </div>

      <div style={{ ...card }}>
        <h3 style={{ margin: 0, marginBottom: 10 }}>เวลารับออเดอร์และป้องกันสั่งนอกร้าน</h3>
        {settings?.ordering_status && (
          <div style={{
            background: settings.ordering_status.open_now ? '#ecfff8' : '#fff0f0',
            border: `1px solid ${settings.ordering_status.open_now ? '#10b98155' : '#ef444455'}`,
            color: settings.ordering_status.open_now ? '#05795c' : '#b4232e',
            borderRadius: 10,
            padding: '8px 10px',
            marginBottom: 8,
            fontSize: 12,
            fontWeight: 800,
          }}>
            {settings.ordering_status.open_now ? 'เปิดรับออเดอร์อยู่' : 'ยังไม่เปิดรับออเดอร์'}
            {' · '}เวลาเครื่อง {settings.ordering_status.local_time || '-'}
            {settings.ordering_status.reason ? ` · ${settings.ordering_status.reason}` : ''}
          </div>
        )}
        {orderingDraft ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', marginBottom: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={!!orderingDraft.ordering_enabled}
                       onChange={(e) => setOrderingField('ordering_enabled', e.target.checked)} />
                <span>สวิตช์หลักรับออเดอร์ QR</span>
              </label>
              {!orderingDraft.ordering_enabled && (
                <button type="button"
                        onClick={() => toggleAuto('ordering_enabled', true)}
                        style={{ ...btnSecondary, padding: '6px 10px', fontSize: 12 }}>
                  เปิดรับตอนนี้
                </button>
              )}
            </div>
            {!orderingDraft.ordering_enabled && (
              <div style={{
                background: '#fff7ed',
                border: '1px solid #f9731655',
                color: '#9a3412',
                borderRadius: 10,
                padding: '8px 10px',
                marginBottom: 8,
                fontSize: 12,
                fontWeight: 700,
              }}>
                สวิตช์หลักปิดอยู่ ระบบจะไม่รับออเดอร์แม้ยังอยู่ในเวลาเปิดร้าน
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              <Field label="เปิดรับตั้งแต่">
                <input type="time" style={inputStyle}
                       value={orderingDraft.ordering_open_time}
                       onChange={(e) => setOrderingField('ordering_open_time', e.target.value)} />
              </Field>
              <Field label="ปิดรับเวลา">
                <input type="time" style={inputStyle}
                       value={orderingDraft.ordering_close_time}
                       onChange={(e) => setOrderingField('ordering_close_time', e.target.value)} />
              </Field>
              <Field label="Timezone">
                <input style={inputStyle}
                       value={orderingDraft.ordering_timezone}
                       onChange={(e) => setOrderingField('ordering_timezone', e.target.value)} />
              </Field>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
              <input type="checkbox" checked={!!orderingDraft.ordering_require_session}
                     onChange={(e) => setOrderingField('ordering_require_session', e.target.checked)} />
              <span>ผูก session ลูกค้ากับเครื่องที่สแกน QR</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 4px' }}>
              <input type="checkbox" checked={!!orderingDraft.ordering_require_gps}
                     onChange={(e) => setOrderingField('ordering_require_gps', e.target.checked)} />
              <span>ป้องกันการสั่งนอกร้านด้วย GPS</span>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
              <Field label="ละติจูดร้าน">
                <input style={inputStyle}
                       value={orderingDraft.ordering_shop_lat}
                       placeholder="13.756331"
                       onChange={(e) => setOrderingField('ordering_shop_lat', e.target.value)} />
              </Field>
              <Field label="ลองจิจูดร้าน">
                <input style={inputStyle}
                       value={orderingDraft.ordering_shop_lng}
                       placeholder="100.501765"
                       onChange={(e) => setOrderingField('ordering_shop_lng', e.target.value)} />
              </Field>
              <Field label="รัศมีสูงสุด (เมตร)">
                <input type="number" min="1" max="10000" style={inputStyle}
                       value={orderingDraft.ordering_max_distance_m}
                       onChange={(e) => setOrderingField('ordering_max_distance_m', e.target.value)} />
              </Field>
            </div>
            <button type="button" onClick={captureShopLocation} style={{ ...btnSecondary, marginTop: 2 }}>
              📍 ใช้ตำแหน่งเครื่องนี้เป็นพิกัดร้าน
            </button>
            <p style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
              ระบบเดียว: อยู่บน WiFi ร้านผ่านทันที, นอก WiFi ต้องใช้ GPS และอยู่ในรัศมีนี้
            </p>
            <button onClick={saveOrdering}
                    disabled={savingOrdering}
                    style={{ ...btnPrimary, marginTop: 8 }}>
              {savingOrdering ? 'กำลังบันทึก...' : 'บันทึกเวลารับออเดอร์'}
            </button>
          </>
        ) : <p style={{ fontSize: 12, color: '#888' }}>กำลังโหลดการตั้งค่า...</p>}
      </div>

      <div style={{ ...card }}>
        <h3 style={{ margin: 0, marginBottom: 10 }}>QR ชำระเงินบนใบเสร็จ</h3>
        {paymentDraft ? (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', marginBottom: 8 }}>
              <input type="checkbox" checked={!!paymentDraft.payment_qr_enabled}
                     onChange={(e) => setPaymentField('payment_qr_enabled', e.target.checked)} />
              <span>แสดง QR จ่ายเงินในใบเสร็จลูกค้า</span>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <Field label="ประเภท QR">
                <select style={inputStyle} value={qrType}
                        onChange={(e) => setPaymentField('payment_qr_type', e.target.value)}>
                  <option value="promptpay">พร้อมเพย์</option>
                  <option value="merchant">รหัสร้าน Thai QR</option>
                  <option value="raw">Raw QR payload</option>
                </select>
              </Field>
              {qrType !== 'raw' && (
                <Field label={qrType === 'merchant' ? 'รหัสร้าน / Biller ID' : 'เลขพร้อมเพย์'}>
                  <input style={inputStyle}
                         value={paymentDraft.payment_qr_id}
                         placeholder={qrType === 'merchant' ? '014000009395435' : 'เบอร์มือถือ / เลขบัตร / e-Wallet ID'}
                         onChange={(e) => setPaymentField('payment_qr_id', e.target.value)} />
                </Field>
              )}
              <Field label="ชื่อบัญชี / ชื่อร้าน">
                <input style={inputStyle}
                       value={paymentDraft.payment_qr_account_name}
                       placeholder="ชื่อบัญชีที่แสดงใต้ QR"
                       onChange={(e) => setPaymentField('payment_qr_account_name', e.target.value)} />
              </Field>
              <Field label="หัวข้อบนใบเสร็จ">
                <input style={inputStyle}
                       value={paymentDraft.payment_qr_label}
                       onChange={(e) => setPaymentField('payment_qr_label', e.target.value)} />
              </Field>
            </div>
            {qrType === 'merchant' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                <Field label="Ref1 prefix">
                  <input style={inputStyle}
                         value={paymentDraft.payment_qr_ref1_prefix}
                         onChange={(e) => setPaymentField('payment_qr_ref1_prefix', e.target.value)} />
                </Field>
                <Field label="Ref2">
                  <input style={inputStyle}
                         value={paymentDraft.payment_qr_ref2}
                         onChange={(e) => setPaymentField('payment_qr_ref2', e.target.value)} />
                </Field>
              </div>
            )}
            {qrType === 'raw' && (
              <Field label="Raw QR payload">
                <textarea style={{ ...inputStyle, minHeight: 90, fontFamily: 'monospace' }}
                          value={paymentDraft.payment_qr_raw_payload}
                          onChange={(e) => setPaymentField('payment_qr_raw_payload', e.target.value)} />
              </Field>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
              <input type="checkbox" checked={!!paymentDraft.payment_qr_include_amount}
                     onChange={(e) => setPaymentField('payment_qr_include_amount', e.target.checked)}
                     disabled={qrType === 'raw'} />
              <span>ใส่ยอดรวมของออเดอร์ใน QR</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
              <input type="checkbox" checked={!!paymentDraft.payment_auto_close_enabled}
                     onChange={(e) => setPaymentField('payment_auto_close_enabled', e.target.checked)} />
              <span>ปิดงานอัตโนมัติเมื่อ payment webhook ยืนยันว่าเงินเข้าแล้ว</span>
            </label>
            <p style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
              ต้องต่อ payment gateway/bank webhook มาที่ <code>/api/payments/webhook/&lt;provider&gt;</code>
              พร้อม header <code>x-pos-payment-secret</code>; การสแกน QR อย่างเดียวไม่ถือว่าเงินเข้า
            </p>
            <button onClick={savePaymentQr}
                    disabled={savingPayment}
                    style={{ ...btnPrimary, marginTop: 8 }}>
              {savingPayment ? 'กำลังบันทึก...' : 'บันทึก QR ชำระเงิน'}
            </button>
          </>
        ) : <p style={{ fontSize: 12, color: '#888' }}>กำลังโหลดการตั้งค่า...</p>}
      </div>

      <div style={{ ...card }}>
        <h3 style={{ margin: 0, marginBottom: 10 }}>เครื่องพิมพ์หลัก / fallback จาก backend .env</h3>
        <Row label="สถานะ" value={config.enabled ? '🟢 เปิดใช้' : '⛔ ปิด'} />
        <Row label="Host" value={config.host || '(ไม่ได้ตั้งค่า — จะ skip การพิมพ์)'} />
        <Row label="Port" value={String(config.port)} />
        <Row label="Printer key" value={config.printer_key || '-'} />
        <Row label="Health" value={`${config.status?.status || 'unknown'}${config.status?.last_error_code ? ` · ${config.status.last_error_code}` : ''}`} />
        <Row label="Timeout" value={`${config.timeout_ms} ms`} />
        <Row label="Retry" value={`${config.max_attempts} ครั้ง · ${config.backoff_base_sec}s-${config.backoff_max_sec}s`} />
        <Row label="Thai Code Page" value={String(config.thai_cp)} />
        <Row label="Width (chars)" value={String(config.width)} />
        <Row label="Paper" value={`${config.paper_width_mm || 58}mm × ${config.paper_height_mm || 'continuous'} · ${config.width_px || 384}px`} />
        <Row label="Feed/Cut" value={`${config.feed_lines || 0} lines · bottom ${config.bottom_feed_px || 0}px · cut ${config.cut_mode || 'default'}`} />
        <p style={{ fontSize: 12, color: '#888', marginTop: 10 }}>
          ถ้าตั้งค่าในจุดพิมพ์ด้านล่าง ระบบจะใช้ค่าจุดนั้นแทน .env ทันที
        </p>
      </div>
      <div style={{ ...card }}>
        <h3 style={{ margin: 0, marginBottom: 10 }}>แยกเครื่องพิมพ์และตั้งค่ากระดาษตามจุดพิมพ์</h3>
        <p style={{ fontSize: 12, color: '#888', margin: '0 0 10px' }}>
          ใช้กับ print server USB/WiFi ได้: กรอก IP/Port ของ print server แล้วตั้งกระดาษ, feed, cut ต่อจุดพิมพ์
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          {stations.map((s) => (
            <div key={s.key} style={{ border: '1px solid #e5e5ea', borderRadius: 10, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <strong>{s.name}</strong>
                  <div style={{ fontSize: 11, color: '#888' }}>
                    {s.key} · {s.health_status || 'unknown'}
                    {s.last_error_code ? ` · ${s.last_error_code}` : ''}
                  </div>
                </div>
                <label style={{ fontSize: 12 }}>
                  <input type="checkbox" checked={s.is_active !== false}
                         onChange={(e) => setStationField(s.key, 'is_active', e.target.checked)} /> เปิดใช้
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => applyPaperPreset(s.key, '58mm')}
                        style={{ ...btnSecondary, fontSize: 11, padding: '5px 9px' }}>
                  58mm / 384px
                </button>
                <button type="button" onClick={() => applyPaperPreset(s.key, '80mm')}
                        style={{ ...btnSecondary, fontSize: 11, padding: '5px 9px' }}>
                  80mm / 576px
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
                <Field label="ชื่อจุดผลิต">
                  <input style={inputStyle} value={s.name || ''}
                         onChange={(e) => setStationField(s.key, 'name', e.target.value)} />
                </Field>
                <Field label="Host/IP เครื่องพิมพ์">
                  <input style={inputStyle} value={s.printer_host || ''}
                         placeholder={config.host || '192.168.1.xxx'}
                         onChange={(e) => setStationField(s.key, 'printer_host', e.target.value)} />
                </Field>
                <Field label="Port">
                  <input type="number" style={inputStyle} value={s.printer_port || ''}
                         placeholder={String(config.port || 9100)}
                         onChange={(e) => setStationField(s.key, 'printer_port', e.target.value)} />
                </Field>
                <Field label="Render">
                  <select style={inputStyle} value={s.render_mode || 'text'}
                          onChange={(e) => setStationField(s.key, 'render_mode', e.target.value)}>
                    <option value="text">text</option>
                    <option value="image">image</option>
                  </select>
                </Field>
                <Field label="กว้างกระดาษ (mm)">
                  <input type="number" min="30" max="120" style={inputStyle}
                         value={s.paper_width_mm ?? 58}
                         onChange={(e) => setStationField(s.key, 'paper_width_mm', e.target.value)} />
                </Field>
                <Field label="สูงกระดาษ (mm, 0=ต่อเนื่อง)">
                  <input type="number" min="0" max="1000" style={inputStyle}
                         value={s.paper_height_mm ?? 0}
                         onChange={(e) => setStationField(s.key, 'paper_height_mm', e.target.value)} />
                </Field>
                <Field label="Gap (mm)">
                  <input type="number" min="0" max="60" style={inputStyle}
                         value={s.paper_gap_mm ?? 0}
                         onChange={(e) => setStationField(s.key, 'paper_gap_mm', e.target.value)} />
                </Field>
                <Field label="Thai CP">
                  <input type="number" style={inputStyle} value={s.thai_cp || 21}
                         onChange={(e) => setStationField(s.key, 'thai_cp', e.target.value)} />
                </Field>
                <Field label="กว้าง chars">
                  <input type="number" style={inputStyle} value={s.width_chars || 42}
                         onChange={(e) => setStationField(s.key, 'width_chars', e.target.value)} />
                </Field>
                <Field label="กว้าง bitmap px">
                  <input type="number" min="128" max="832" style={inputStyle}
                         value={s.width_px ?? 384}
                         onChange={(e) => setStationField(s.key, 'width_px', e.target.value)} />
                </Field>
                <Field label="Feed ท้ายใบ (lines)">
                  <input type="number" min="0" max="24" style={inputStyle}
                         value={s.feed_lines ?? 6}
                         onChange={(e) => setStationField(s.key, 'feed_lines', e.target.value)} />
                </Field>
                <Field label="Bottom feed bitmap (px)">
                  <input type="number" min="0" max="1200" style={inputStyle}
                         value={s.bottom_feed_px ?? 160}
                         onChange={(e) => setStationField(s.key, 'bottom_feed_px', e.target.value)} />
                </Field>
                <Field label="Raster band height">
                  <input type="number" min="64" max="256" style={inputStyle}
                         value={s.raster_band_height ?? 128}
                         onChange={(e) => setStationField(s.key, 'raster_band_height', e.target.value)} />
                </Field>
                <Field label="Cut">
                  <select style={inputStyle} value={s.cut_mode || 'partial'}
                          onChange={(e) => setStationField(s.key, 'cut_mode', e.target.value)}>
                    <option value="none">none</option>
                    <option value="partial">partial</option>
                    <option value="full">full</option>
                  </select>
                </Field>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button onClick={() => saveStation(s)}
                        disabled={savingStationKey === s.key}
                        style={btnPrimary}>
                  {savingStationKey === s.key ? 'กำลังบันทึก...' : 'บันทึกจุดนี้'}
                </button>
                <button onClick={() => testStation(s)} style={btnSecondary}>ทดสอบพิมพ์</button>
                <button onClick={() => checkStation(s)} style={btnSecondary}>เช็คสถานะ</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <button onClick={testPrint} style={{ ...btnPrimary, padding: '12px 18px' }}>🖨️ ทดสอบพิมพ์</button>
      {result && (
        <pre style={{ background: '#f0f0f5', padding: 10, borderRadius: 8, marginTop: 10, fontSize: 12 }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
      {error && <p style={{ color: '#c00', marginTop: 10 }}>{error}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
const JOB_STATUS_LABEL = {
  pending: 'รอคิว', processing: 'กำลังพิมพ์', success: 'พิมพ์แล้ว',
  retrying: 'รอลองใหม่', failed: 'ล้มเหลว', cancelled: 'ยกเลิก',
  queued: 'รอคิว', printing: 'กำลังพิมพ์', printed: 'พิมพ์แล้ว',
};
const JOB_STATUS_COLOR = {
  pending: { bg: '#fff3cd', fg: '#b8860b' },
  processing: { bg: '#cfe2ff', fg: '#0d6efd' },
  success: { bg: '#d1f2eb', fg: '#06d6a0' },
  retrying: { bg: '#fcebd2', fg: '#d35400' },
  failed: { bg: '#f8d7da', fg: '#c0392b' },
  cancelled: { bg: '#e9ecef', fg: '#666' },
  queued: { bg: '#fff3cd', fg: '#b8860b' },
  printing: { bg: '#cfe2ff', fg: '#0d6efd' },
  printed: { bg: '#d1f2eb', fg: '#06d6a0' },
};

function PrintQueueTab({ isAdmin }) {
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState(''); // '', 'pending', 'failed' …
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    try {
      const qs = filter ? `?status=${filter}&limit=100` : '?limit=100';
      const list = await authFetch(`/api/print/jobs${qs}`);
      setJobs(list);
    } catch (e) { setError(e.message); }
  }, [filter]);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 3000); // poll every 3s — queue moves fast
    return () => clearInterval(t);
  }, [reload]);

  async function retry(id) {
    try { await authFetch(`/api/print/jobs/${id}/retry`, { method: 'POST' }); reload(); }
    catch (e) { setError(e.message); }
  }
  async function cancel(id) {
    try { await authFetch(`/api/print/jobs/${id}/cancel`, { method: 'POST' }); reload(); }
    catch (e) { setError(e.message); }
  }

  const counts = jobs.reduce((m, j) => { m[j.status] = (m[j.status] || 0) + 1; return m; }, {});

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>คิวพิมพ์ ({jobs.length})</h2>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['', 'pending', 'processing', 'retrying', 'success', 'failed', 'cancelled'].map((s) => (
            <button key={s || 'all'} onClick={() => setFilter(s)}
                    style={{ ...btnSecondary,
                             background: filter === s ? '#1a1a2e' : '#f0f0f5',
                             color: filter === s ? 'white' : '#1a1a2e',
                             fontSize: 12, padding: '6px 10px' }}>
              {s ? JOB_STATUS_LABEL[s] : 'ทั้งหมด'}
              {s && counts[s] != null && ` (${counts[s]})`}
            </button>
          ))}
        </div>
      </div>
      {error && <p style={{ color: '#c00' }}>{error}</p>}

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: '#f8f8fa', color: '#888' }}>
            <tr>
              <th style={th}>#</th><th style={th}>ประเภท</th><th style={th}>คำอธิบาย</th>
              <th style={th}>สถานะ</th><th style={th}>ลอง</th><th style={th}>เวลา</th>
              <th style={th}>การกระทำ</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const c = JOB_STATUS_COLOR[j.status] || { bg: '#eee', fg: '#333' };
              return (
                <tr key={j.id} style={{ borderTop: '1px solid #f0f0f5' }}>
                  <td style={td}>#{j.id}</td>
                  <td style={td}>{j.type}</td>
                  <td style={{ ...td, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {j.label || (j.order_id ? `order #${j.order_id}` : '—')}
                  </td>
                  <td style={td}>
                    <span style={{ background: c.bg, color: c.fg, padding: '3px 10px',
                                   borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
                      {JOB_STATUS_LABEL[j.status] || j.status}
                    </span>
                    {j.error && (
                      <div style={{ fontSize: 11, color: '#c00', marginTop: 2,
                                     maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                           title={j.error}>
                        {j.error}
                      </div>
                    )}
                  </td>
                  <td style={td}>{j.attempts}/{j.max_attempts}</td>
                  <td style={td}>
                    {j.printed_at
                      ? new Date(j.printed_at).toLocaleTimeString('th-TH')
                      : new Date(j.next_attempt_at).toLocaleTimeString('th-TH')}
                  </td>
                  <td style={td}>
                    {(j.status === 'failed' || j.status === 'cancelled' || j.status === 'retrying') && isAdmin && (
                      <button onClick={() => retry(j.id)}
                              style={{ ...btnSecondary, fontSize: 11, padding: '4px 8px' }}>
                        🔄 ลองใหม่
                      </button>
                    )}
                    {(['pending', 'retrying', 'processing', 'queued', 'printing'].includes(j.status)) && (
                      <button onClick={() => cancel(j.id)}
                              style={{ ...btnDanger, fontSize: 11, padding: '4px 8px', marginLeft: 4 }}>
                        ยกเลิก
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {jobs.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: '#aaa', padding: 30 }}>
                ไม่มีงานในคิว
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
        รีเฟรชอัตโนมัติทุก 3 วินาที · งาน retry ด้วย exponential backoff และ dedupe key เพื่อกันใบซ้ำ
      </p>
    </div>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div onClick={onClose}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  zIndex: 100, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
           style={{ background: 'white', borderRadius: 14, padding: 16,
                    width: '100%', maxWidth: 840, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button onClick={onClose} style={{ ...btnSecondary, padding: '4px 10px' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      {label && <div style={{ fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 4 }}>{label}</div>}
      {children}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', padding: '6px 0', borderBottom: '1px solid #f5f5f7' }}>
      <div style={{ flex: '0 0 140px', color: '#888', fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

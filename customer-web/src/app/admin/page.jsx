'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getAuth,
  authFetch,
  clearAuth,
  getActiveStoreId,
  setActiveStoreId as persistActiveStoreId,
  activeStoreHeaders,
} from '@/lib/auth';
import { apiBase } from '@/lib/api';
import { useRealtimeRecovery } from '@/lib/realtimeRecovery';
import { ensureSocketConnected } from '@/lib/socket';
import { storageGet, storageSet } from '@/lib/browser';
import { openQrPrintWindow } from '@/lib/printQr';

const TABS = [
  { id: 'dashboard', label: '📊 ภาพรวม' },
  { id: 'stores',   label: '🏬 ร้าน',     adminOnly: true },
  { id: 'users',    label: '👥 ผู้ใช้',    adminOnly: true },
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

export default function AdminPage() {
  const router = useRouter();
  const [auth, setAuthState] = useState(null);
  const [tab, setTab] = useState('dashboard');
  const [activeStoreId, setActiveStoreIdState] = useState(null);

  const changeActiveStore = useCallback((storeId) => {
    const id = Number(storeId);
    if (!Number.isInteger(id) || id <= 0) return;
    persistActiveStoreId(id);
    setActiveStoreIdState(id);
  }, []);

  useEffect(() => {
    const a = getAuth();
    if (!a) { router.replace('/login?next=/admin'); return; }
    if (a.user.role === 'kitchen') { router.replace('/kitchen'); return; }
    if (a.user.role === 'staff') { router.replace('/staff'); return; }
    if (!['admin', 'super_admin'].includes(a.user.role)) { clearAuth(); router.replace('/login?next=/admin'); return; }
    setActiveStoreIdState(getActiveStoreId(a.user?.store_id || 1));
    setAuthState(a);
  }, [router]);

  function logout() { clearAuth(); router.replace('/login'); }

  if (!auth) return null;
  const isAdmin = auth.user.role === 'admin' || auth.user.role === 'super_admin';
  const visibleTabs = TABS.filter((t) => isAdmin || !t.adminOnly);
  const activeTab = visibleTabs.find((t) => t.id === tab) ? tab : 'dashboard';
  const storeScopeKey = activeStoreId || auth.user.store_id || 1;
  function manageStore(store) {
    changeActiveStore(store.id);
    setTab('dashboard');
  }

  return (
    <main className="pos-app-shell admin-shell admin-page-shell">
      <header className="pos-topbar admin-header admin-topbar">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>
            {isAdmin ? '⚙️ Admin Panel' : '👤 หน้าพนักงาน'}
          </div>
          <div style={{ opacity: .55, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {auth.user.full_name} · {auth.user.role}
          </div>
        </div>
        <div className="admin-actions admin-header-actions">
          {isAdmin && (
            <StoreSwitcher
              currentUser={auth.user}
              activeStoreId={storeScopeKey}
              onChange={changeActiveStore}
            />
          )}
          <button onClick={logout} style={{ ...navLinkStyle, background: 'rgba(239,71,111,.15)', color: '#ef476f', borderColor: 'rgba(239,71,111,.25)', border: '1px solid', cursor: 'pointer' }}>🚪 ออก</button>
        </div>
      </header>

      <nav className="admin-tab-bar" style={{ background: 'white', padding: '8px 12px', display: 'flex', gap: 6,
                    overflowX: 'auto', WebkitOverflowScrolling: 'touch',
                    boxShadow: '0 1px 4px rgba(0,0,0,.08)',
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

      <div className="admin-content">
        {activeTab === 'dashboard'  && <DashboardTab key={`dashboard-${storeScopeKey}`} />}
        {activeTab === 'stores'     && isAdmin && (
          <StoresTab
            currentUser={auth.user}
            activeStoreId={storeScopeKey}
            onManageStore={manageStore}
          />
        )}
        {activeTab === 'users'      && isAdmin && <UsersTab key={`users-${storeScopeKey}`} currentUser={auth.user} />}
        {activeTab === 'orders'     && <OrdersTab key={`orders-${storeScopeKey}`} />}
        {activeTab === 'accounting' && isAdmin && <AccountingTab key={`accounting-${storeScopeKey}`} />}
        {activeTab === 'products'   && isAdmin && <ProductsTab key={`products-${storeScopeKey}`} />}
        {activeTab === 'categories' && isAdmin && <CategoriesTab key={`categories-${storeScopeKey}`} />}
        {activeTab === 'tables'     && isAdmin && <TablesTab key={`tables-${storeScopeKey}`} />}
        {activeTab === 'qrcodes'    && <QRCodesTab key={`qrcodes-${storeScopeKey}`} />}
        {activeTab === 'printer'    && isAdmin && <PrinterTab key={`printer-${storeScopeKey}`} />}
        {activeTab === 'printqueue' && <PrintQueueTab key={`printqueue-${storeScopeKey}`} isAdmin={isAdmin} />}
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
function StoreSwitcher({ currentUser, activeStoreId, onChange }) {
  const [stores, setStores] = useState([]);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    try {
      const list = await authFetch('/api/stores');
      setStores(Array.isArray(list) ? list : []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!stores.length) return;
    const current = Number(activeStoreId);
    if (stores.some((s) => Number(s.id) === current)) return;
    const fallback = stores.find((s) => Number(s.id) === Number(currentUser?.store_id)) || stores[0];
    if (fallback) onChange(fallback.id);
  }, [stores, activeStoreId, currentUser?.store_id, onChange]);

  if (error) {
    return <span style={{ color: '#ffd166', fontSize: 12 }}>ร้าน: {error}</span>;
  }
  if (!stores.length) return null;

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700 }}>
      <span style={{ opacity: .75 }}>ร้านที่จัดการ</span>
      <select
        value={String(activeStoreId || stores[0]?.id || '')}
        onChange={(e) => onChange(e.target.value)}
        style={{
          minWidth: 150,
          maxWidth: 220,
          background: 'rgba(255,255,255,.12)',
          color: 'white',
          border: '1px solid rgba(255,255,255,.25)',
          borderRadius: 8,
          padding: '7px 9px',
          fontSize: 12,
          fontWeight: 700,
          outline: 'none',
        }}
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id} style={{ color: '#1a1a2e' }}>
            #{s.id} {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

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
function StoresTab({ currentUser, activeStoreId, onManageStore }) {
  const [stores, setStores] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const canCreate = currentUser?.role === 'super_admin' || currentUser?.role === 'admin';

  const reload = useCallback(async () => {
    try {
      const list = await authFetch('/api/stores');
      setStores(list);
      setError(null);
      return list;
    } catch (e) { setError(e.message); }
    return [];
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function save(form) {
    try {
      let saved;
      if (form.id) {
        saved = await authFetch(`/api/stores/${form.id}`, {
          method: 'PUT',
          headers: { 'X-POS-Store-ID': String(form.id) },
          body: JSON.stringify(form),
        });
      } else {
        saved = await authFetch('/api/stores', { method: 'POST', body: JSON.stringify(form) });
      }
      setEditing(null);
      if (saved?.id && !form.id) onManageStore?.(saved);
      setNotice(form.id ? 'บันทึกร้านแล้ว' : 'เพิ่มร้านและเตรียมโต๊ะ/QR เริ่มต้นแล้ว');
      reload();
    } catch (e) { setError(e.message); }
  }

  async function deleteStore(store) {
    if (Number(store.id) === 1 || store.code === 'default') {
      setError('ไม่สามารถลบร้านหลักได้');
      return;
    }
    const ok = confirm(`ลบร้าน "${store.name}"?\n\nระบบจะลบเฉพาะร้านที่ยังไม่มีประวัติขาย/สต๊อก/บัญชีเท่านั้น และจะลบโต๊ะ QR หมวด และเมนูของร้านนี้ด้วย`);
    if (!ok) return;
    setError(null);
    setNotice(null);
    try {
      await authFetch(`/api/stores/${store.id}`, {
        method: 'DELETE',
        headers: { 'X-POS-Store-ID': String(store.id) },
      });
      const list = await reload();
      if (Number(activeStoreId) === Number(store.id)) {
        const next = list.find((s) => s.is_active) || list[0];
        if (next) onManageStore?.(next);
      }
      setNotice(`ลบร้าน "${store.name}" แล้ว`);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>ร้านในระบบ ({stores.length})</h2>
        {canCreate && <button onClick={() => setEditing({ is_active: true, currency: '฿', timezone: 'Asia/Bangkok' })} style={btnPrimary}>+ เพิ่มร้าน</button>}
      </div>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      {notice && <p style={{ color: '#05795c', fontWeight: 700 }}>{notice}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        {stores.map((s) => {
          const isCurrent = Number(s.id) === Number(activeStoreId);
          const isDefault = Number(s.id) === 1 || s.code === 'default';
          return (
          <div key={s.id} style={{
            ...card,
            border: isCurrent ? '2px solid #1a1a2e' : '2px solid transparent',
            boxShadow: isCurrent ? '0 4px 16px rgba(26,26,46,.14)' : card.boxShadow,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div>
                <div style={{ fontSize: 12, color: '#999', fontWeight: 700 }}>{s.code} · #{s.id}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#1a1a2e', marginTop: 3 }}>{s.logo || '🍽️'} {s.name}</div>
                <div style={{ fontSize: 12, color: '#777', marginTop: 4 }}>{s.public_base_url || 'LAN/local only'}</div>
              </div>
              <span style={{
                height: 26, padding: '5px 10px', borderRadius: 999, fontSize: 12, fontWeight: 800,
                background: s.is_active ? '#ecfff8' : '#fff0f0',
                color: s.is_active ? '#05795c' : '#b4232e',
              }}>{s.is_active ? 'active' : 'disabled'}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                onClick={() => onManageStore?.(s)}
                style={isCurrent ? btnPrimary : btnSecondary}
              >
                {isCurrent ? 'กำลังจัดการร้านนี้' : 'จัดการร้านนี้'}
              </button>
              <button onClick={() => setEditing(s)} style={btnSecondary}>แก้ไข</button>
              <button
                onClick={() => deleteStore(s)}
                disabled={isDefault}
                style={{ ...btnDanger, opacity: isDefault ? .45 : 1 }}
                title={isDefault ? 'ร้านหลักลบไม่ได้' : 'ลบร้านนี้'}
              >
                ลบ
              </button>
            </div>
          </div>
          );
        })}
      </div>
      {editing && (
        <StoreModal
          initial={editing}
          canEditCode={canCreate}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function StoreModal({ initial, canEditCode, onClose, onSave }) {
  const [form, setForm] = useState({
    id: initial.id,
    name: initial.name || '',
    code: initial.code || '',
    slug: initial.slug || '',
    logo: initial.logo || '',
    currency: initial.currency || '฿',
    public_base_url: initial.public_base_url || '',
    timezone: initial.timezone || 'Asia/Bangkok',
    is_active: initial.is_active !== false,
  });
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  return (
    <Modal title={form.id ? 'แก้ไขร้าน' : 'เพิ่มร้าน'} onClose={onClose}>
      <Field label="ชื่อร้าน"><input style={inputStyle} value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="รหัสร้าน"><input style={inputStyle} disabled={!canEditCode || !!form.id} value={form.code} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field label="Slug"><input style={inputStyle} disabled={!canEditCode || !!form.id} value={form.slug} onChange={(e) => set('slug', e.target.value)} /></Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 10 }}>
        <Field label="โลโก้"><input style={inputStyle} value={form.logo} onChange={(e) => set('logo', e.target.value)} /></Field>
        <Field label="Public URL"><input style={inputStyle} value={form.public_base_url} onChange={(e) => set('public_base_url', e.target.value)} placeholder="https://shop.example.com" /></Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 10 }}>
        <Field label="สกุลเงิน"><input style={inputStyle} value={form.currency} onChange={(e) => set('currency', e.target.value)} /></Field>
        <Field label="Timezone"><input style={inputStyle} value={form.timezone} onChange={(e) => set('timezone', e.target.value)} /></Field>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13 }}>
        <input type="checkbox" checked={!!form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
        เปิดใช้งานร้านนี้
      </label>
      <button onClick={() => onSave(form)} style={{ ...btnPrimary, width: '100%' }}>บันทึก</button>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
const ROLE_LABELS = {
  super_admin: 'Server admin',
  admin: 'Store admin',
  staff: 'Staff',
  kitchen: 'Kitchen',
};

function UsersTab({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [stores, setStores] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const isSuperAdmin = currentUser?.role === 'super_admin';

  const reload = useCallback(async () => {
    try {
      const [userList, storeList] = await Promise.all([
        authFetch('/api/users'),
        authFetch('/api/stores'),
      ]);
      setUsers(Array.isArray(userList) ? userList : []);
      setStores(Array.isArray(storeList) ? storeList : []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  function storeLabel(id) {
    const store = stores.find((s) => Number(s.id) === Number(id));
    return store ? `${store.logo || 'ร้าน'} ${store.name}` : `ร้าน #${id}`;
  }

  function storeListLabel(ids = []) {
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) return '-';
    return list.map(storeLabel).join(' · ');
  }

  function newUser() {
    const firstStore = stores.find((s) => s.is_active) || stores[0];
    setEditing({
      role: 'staff',
      is_active: true,
      store_id: firstStore?.id || 1,
      allowed_store_ids: firstStore?.id ? [firstStore.id] : [1],
      permissions: [],
    });
  }

  async function save(form) {
    setError(null);
    setNotice(null);
    try {
      const body = { ...form };
      if (form.id && !body.password) delete body.password;
      const saved = await authFetch(form.id ? `/api/users/${form.id}` : '/api/users', {
        method: form.id ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      setEditing(null);
      setNotice(form.id ? `บันทึกผู้ใช้ ${saved.username} แล้ว` : `สร้างผู้ใช้ ${saved.username} แล้ว`);
      await reload();
    } catch (e) {
      setError(e.message);
    }
  }

  async function toggleActive(user) {
    const action = user.is_active ? 'ปิดใช้งาน' : 'เปิดใช้งาน';
    if (!confirm(`${action}บัญชี "${user.username}"?`)) return;
    await save({ ...user, password: '', is_active: !user.is_active });
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>ผู้ใช้และสิทธิ์ ({users.length})</h2>
          <div style={{ color: '#777', fontSize: 12, marginTop: 3 }}>
            {isSuperAdmin ? 'จัดการได้ทุก role และทุกร้าน' : 'จัดการ staff/kitchen เฉพาะร้านที่บัญชีนี้ได้รับสิทธิ์'}
          </div>
        </div>
        <button onClick={newUser} style={btnPrimary}>+ เพิ่มผู้ใช้</button>
      </div>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      {notice && <p style={{ color: '#05795c', fontWeight: 700 }}>{notice}</p>}
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: '#f8f8fa', color: '#666' }}>
            <tr>
              <th style={thStyle}>ผู้ใช้</th>
              <th style={thStyle}>Role</th>
              <th style={thStyle}>ร้านหลัก</th>
              <th style={thStyle}>ร้านที่เข้าได้</th>
              <th style={thStyle}>สิทธิ์เพิ่ม</th>
              <th style={thStyle}>สถานะ</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={tdStyle}>
                  <div style={{ fontWeight: 800, color: '#1a1a2e' }}>{u.username}</div>
                  <div style={{ color: '#888', fontSize: 12 }}>{u.full_name || '-'}</div>
                </td>
                <td style={tdStyle}>{ROLE_LABELS[u.role] || u.role}</td>
                <td style={tdStyle}>{storeLabel(u.store_id)}</td>
                <td style={tdStyle}>{storeListLabel(u.allowed_store_ids)}</td>
                <td style={tdStyle}>{(u.permissions || []).join(', ') || '-'}</td>
                <td style={tdStyle}>
                  <span style={{
                    padding: '4px 9px', borderRadius: 999, fontWeight: 800, fontSize: 12,
                    background: u.is_active ? '#ecfff8' : '#fff0f0',
                    color: u.is_active ? '#05795c' : '#b4232e',
                  }}>
                    {u.is_active ? 'active' : 'disabled'}
                  </span>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => setEditing(u)} style={{ ...btnSecondary, marginRight: 6 }}>แก้ไข</button>
                  <button onClick={() => toggleActive(u)} style={u.is_active ? btnDanger : btnSecondary}>
                    {u.is_active ? 'ปิด' : 'เปิด'}
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 18, textAlign: 'center', color: '#888' }}>
                  ยังไม่มีผู้ใช้ที่จัดการได้
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <UserModal
          initial={editing}
          stores={stores}
          currentUser={currentUser}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function UserModal({ initial, stores, currentUser, onClose, onSave }) {
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const firstStore = stores.find((s) => s.is_active) || stores[0] || { id: 1, name: 'ร้านหลัก' };
  const [form, setForm] = useState({
    id: initial.id,
    username: initial.username || '',
    password: '',
    full_name: initial.full_name || '',
    role: initial.role || 'staff',
    store_id: initial.store_id || firstStore.id,
    allowed_store_ids: (initial.allowed_store_ids?.length ? initial.allowed_store_ids : [initial.store_id || firstStore.id]).map(Number),
    permissions: initial.permissions || [],
    is_active: initial.is_active !== false,
  });
  const [showPassword, setShowPassword] = useState(false);
  const [storesDropdownOpen, setStoresDropdownOpen] = useState(false);
  const roleOptions = isSuperAdmin ? ['super_admin', 'admin', 'staff', 'kitchen'] : ['staff', 'kitchen'];
  const allowedStoreIds = (form.allowed_store_ids || []).map(Number);
  const allowedStores = stores.filter((s) => allowedStoreIds.includes(Number(s.id)));
  const allowedStoreLabel = allowedStores.length
    ? allowedStores.map((s) => `${s.logo || 'ร้าน'} ${s.name}`).join(' · ')
    : 'เลือกร้านที่เข้าได้';

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function toggleStore(id) {
    const storeId = Number(id);
    setForm((f) => {
      const current = new Set((f.allowed_store_ids || []).map(Number));
      if (current.has(storeId)) current.delete(storeId);
      else current.add(storeId);
      const allowed = Array.from(current).sort((a, b) => a - b);
      return {
        ...f,
        allowed_store_ids: allowed,
        store_id: allowed.includes(Number(f.store_id)) ? f.store_id : (allowed[0] || ''),
      };
    });
  }
  function togglePermission(permission) {
    setForm((f) => {
      const current = new Set(f.permissions || []);
      if (current.has(permission)) current.delete(permission);
      else current.add(permission);
      return { ...f, permissions: Array.from(current) };
    });
  }
  function save() {
    const allowed = (form.allowed_store_ids || []).map(Number).filter(Boolean);
    if (!form.username.trim()) return alert('กรุณากรอก username');
    if (!form.id && !form.password) return alert('กรุณากรอกรหัสผ่านสำหรับผู้ใช้ใหม่');
    if (form.password && form.password.length < 8) return alert('รหัสผ่านต้องอย่างน้อย 8 ตัวอักษร');
    if (allowed.length === 0) return alert('กรุณาเลือกร้านที่เข้าได้');
    if (!allowed.includes(Number(form.store_id))) return alert('ร้านหลักต้องอยู่ในร้านที่เข้าได้');
    onSave({
      ...form,
      username: form.username.trim(),
      full_name: form.full_name.trim(),
      store_id: Number(form.store_id),
      allowed_store_ids: allowed,
      permissions: form.role === 'admin' ? form.permissions : [],
    });
  }

  return (
    <Modal title={form.id ? `แก้ไขผู้ใช้ ${initial.username}` : 'เพิ่มผู้ใช้'} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Username">
          <input style={inputStyle} value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="เช่น staff_branch2" />
        </Field>
        <Field label={form.id ? 'รหัสผ่านใหม่ (ว่างไว้ถ้าไม่เปลี่ยน)' : 'รหัสผ่าน'}>
          <div style={{ position: 'relative' }}>
            <input
              style={{ ...inputStyle, paddingRight: 56 }}
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              placeholder="อย่างน้อย 8 ตัวอักษร"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              title={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
              style={{
                position: 'absolute', right: 6, top: 6, bottom: 6,
                minWidth: 40, border: 'none', borderRadius: 6,
                background: '#f0f0f5', cursor: 'pointer', fontSize: 15,
              }}
            >
              {showPassword ? '🙈' : '👁'}
            </button>
          </div>
        </Field>
      </div>
      <Field label="ชื่อที่แสดง">
        <input style={inputStyle} value={form.full_name} onChange={(e) => set('full_name', e.target.value)} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Role">
          <select style={inputStyle} value={form.role} onChange={(e) => set('role', e.target.value)}>
            {roleOptions.map((role) => <option key={role} value={role}>{ROLE_LABELS[role] || role}</option>)}
          </select>
        </Field>
        <Field label="ร้านหลัก">
          <select style={inputStyle} value={form.store_id} onChange={(e) => set('store_id', Number(e.target.value))}>
            {allowedStores.map((s) => (
              <option key={s.id} value={s.id}>{s.logo || 'ร้าน'} {s.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="ร้านที่เข้าได้">
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setStoresDropdownOpen((v) => !v)}
            style={{
              ...inputStyle,
              textAlign: 'left',
              background: 'white',
              minHeight: 40,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              cursor: 'pointer',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {allowedStoreLabel}
            </span>
            <span style={{ color: '#777' }}>▾</span>
          </button>
          {storesDropdownOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                right: 0,
                zIndex: 120,
                background: 'white',
                border: '1.5px solid #e5e5ea',
                borderRadius: 8,
                boxShadow: '0 12px 28px rgba(0,0,0,.16)',
                overflow: 'hidden',
                maxHeight: 240,
                overflowY: 'auto',
              }}
            >
              {stores.map((s) => {
                const checked = allowedStoreIds.includes(Number(s.id));
                return (
                  <label
                    key={s.id}
                    style={{
                      display: 'flex',
                      gap: 9,
                      alignItems: 'center',
                      padding: '10px 12px',
                      borderBottom: '1px solid #f1f1f4',
                      cursor: 'pointer',
                      background: checked ? '#f7f7fb' : 'white',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleStore(s.id)}
                    />
                    <span style={{ flex: 1 }}>{s.logo || 'ร้าน'} {s.name}</span>
                    <span style={{ color: '#888', fontSize: 12 }}>#{s.id}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </Field>
      {isSuperAdmin && form.role === 'admin' && (
        <Field label="สิทธิ์ admin เพิ่มเติม">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {['store_admin', 'mobile_admin'].map((permission) => (
              <label key={permission} style={{ display: 'flex', gap: 8, alignItems: 'center', border: '1px solid #eee', borderRadius: 8, padding: '8px 10px' }}>
                <input
                  type="checkbox"
                  checked={(form.permissions || []).includes(permission)}
                  onChange={() => togglePermission(permission)}
                />
                <span>{permission}</span>
              </label>
            ))}
          </div>
        </Field>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13 }}>
        <input type="checkbox" checked={!!form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
        เปิดใช้งานบัญชีนี้
      </label>
      <button onClick={save} style={{ ...btnPrimary, width: '100%' }}>บันทึกผู้ใช้</button>
    </Modal>
  );
}

const thStyle = { textAlign: 'left', padding: 10, whiteSpace: 'nowrap', fontSize: 12 };
const tdStyle = { padding: 10, verticalAlign: 'top' };

// ─────────────────────────────────────────────────────────────────────
function OrdersTab() {
  const [orders, setOrders] = useState([]);
  const [filter, setFilter] = useState('active');
  const [previewOrderId, setPreviewOrderId] = useState(null);
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
      <div className="admin-table-wrap">
        <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white' }}>
          <thead style={{ background: '#f8f8fa', fontSize: 12, color: '#888' }}>
            <tr>
              <th style={th}>#</th><th style={th}>โต๊ะ</th><th style={th}>สถานะ</th>
              <th style={th}>ยอด</th><th style={th}>เวลา</th><th style={th}>ที่มา</th>
              <th style={th}>พิมพ์</th>
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
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{new Date(o.created_at).toLocaleString('th-TH')}</td>
                <td style={td}>{o.source}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  <button onClick={() => setPreviewOrderId(o.id)}
                          style={{ ...btnSecondary, fontSize: 11, padding: '4px 8px' }}>
                    👁 ดูตัวอย่าง
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: '#aaa', padding: 30 }}>ไม่มีข้อมูล</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {previewOrderId && (
        <PrintPreviewModal
          orderId={previewOrderId}
          onClose={() => setPreviewOrderId(null)}
        />
      )}
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
        headers: { Authorization: `Bearer ${auth.token}`, ...activeStoreHeaders(auth) },
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
      authFetch('/api/categories/all'),
      authFetch('/api/print/stations').catch(() => []),
    ]);
    setProducts(p); setCategories(c); setStations(s);
  }, []);

  // Live-sync product availability via proven useRealtimeRecovery pattern
  // (auto re-attach on socket rebuild + polling fallback every 15 s).
  useRealtimeRecovery(reload, {
    events: ['product:availability'],
    intervalMs: 5000,
    reloadOnMount: false,
  });
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
  const [availBusyId, setAvailBusyId] = useState(null);
  async function toggleAvail(p) {
    if (availBusyId === p.id) return; // double-click guard
    setAvailBusyId(p.id);
    setError(null);
    try {
      const next = !p.is_available;
      const saved = await authFetch(`/api/products/${p.id}/availability`, {
        method: 'PATCH',
        body: JSON.stringify({ is_available: next }),
      });
      setProducts((list) => list.map((x) =>
        x.id === saved.id ? { ...x, is_available: saved.is_available } : x));
    } catch (e) { setError(e.message); }
    finally { setAvailBusyId(null); }
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
  const [printingBarcode, setPrintingBarcode] = useState(null); // product object
  async function printBarcodeBrowser(p) {
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
        headers: { Authorization: `Bearer ${auth.token}`, ...activeStoreHeaders(auth) },
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
                <button onClick={() => toggleAvail(p)} disabled={availBusyId === p.id}
                        style={{ ...btnSecondary, flex: 1, fontSize: 12,
                                 opacity: availBusyId === p.id ? .6 : 1,
                                 background: p.is_available ? '#e8f5e9' : '#fef0ef',
                                 color: p.is_available ? '#1f6f43' : '#c0392b',
                                 fontWeight: 700 }}>
                  {availBusyId === p.id
                    ? '...'
                    : (p.is_available ? '🟢 พร้อมขาย · กดเพื่อปิด' : '🛑 ปิดขาย · กดเพื่อเปิด')}
                </button>
                <button onClick={() => setEditing(p)} style={{ ...btnSecondary, fontSize: 12 }}>แก้</button>
                {p.barcode ? (
                  <button onClick={() => setPrintingBarcode(p)}
                          style={{ ...btnSecondary, fontSize: 12 }}>
                    🖨 พิมพ์ barcode
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
      {printingBarcode && (
        <BarcodePrintModal
          product={printingBarcode}
          stations={stations}
          onClose={() => setPrintingBarcode(null)}
          onBrowserPrint={() => { printBarcodeBrowser(printingBarcode); setPrintingBarcode(null); }}
        />
      )}
    </div>
  );
}

function BarcodePrintModal({ product, stations, onClose, onBrowserPrint }) {
  // Stations whose station_type can drive a label printer. We allow any
  // active station — the user knows their setup better than we do.
  const printable = (stations || []).filter((s) => s.is_active !== false);
  const [stationKey, setStationKey] = useState(printable[0]?.key || '');
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  async function sendToPrinter() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await authFetch(`/api/print/barcode/${product.id}`, {
        method: 'POST',
        body: JSON.stringify({ station_key: stationKey || undefined, copies }),
      });
      setNotice(`ส่งคิวพิมพ์ "${product.name}" × ${copies} ใบแล้ว`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`🖨 พิมพ์ barcode · ${product.name}`} onClose={onClose} maxWidth={480}>
      <div style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
        Barcode: <code style={{ background: '#f0f0f5', padding: '2px 6px', borderRadius: 4 }}>{product.barcode}</code>
      </div>
      <Field label="เครื่องพิมพ์">
        <select style={inputStyle} value={stationKey} onChange={(e) => setStationKey(e.target.value)} disabled={busy}>
          <option value="">(ค่าเริ่มต้นในระบบ)</option>
          {printable.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name} ({s.printer_key || s.printer_host || s.key})
            </option>
          ))}
        </select>
      </Field>
      <Field label="จำนวน (1-8)">
        <select style={inputStyle} value={copies} onChange={(e) => setCopies(Number(e.target.value) || 1)} disabled={busy}>
          {[1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      {notice && <p style={{ color: '#05795c', fontWeight: 700 }}>{notice}</p>}
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 8 }}>
        <button onClick={onClose} style={btnSecondary}>ปิด</button>
        <button onClick={onBrowserPrint} style={btnSecondary}>🌐 พิมพ์ผ่านเบราว์เซอร์ (A4)</button>
        <button onClick={sendToPrinter} disabled={busy} style={btnPrimary}>
          {busy ? 'กำลังส่ง...' : '🧾 ส่งคิวพิมพ์'}
        </button>
      </div>
    </Modal>
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
  const [storeName, setStoreName] = useState('');
  const [storeLogo, setStoreLogo] = useState('');
  const [printCopies, setPrintCopies] = useState(1);

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
        settings = await authFetch('/api/settings');
      } catch {}
      const wifiOnly = !!settings?.ordering_require_private_ip;
      setGpsGuardEnabled(!!settings?.ordering_require_gps);
      setWifiOnlyQr(wifiOnly);
      setStoreName(settings?.name || '');
      setStoreLogo(settings?.logo || '');
      const stored = trimOrderRoot(storageGet('pos_v2_qr_base'));
      const envBase = trimOrderRoot(process.env.NEXT_PUBLIC_PUBLIC_BASE);
      const lanRoot = localQrRoot();
      const currentLanRoot = discoveryLanRoot || lanRoot;
      const currentPublicRoot = resolved || envBase || currentLanRoot;
      const usableStored = isStaleQrBase(stored, currentLanRoot, currentPublicRoot) ? '' : stored;
      const root = wifiOnly
        ? (usableStored && isLanLikeUrl(usableStored) ? usableStored : currentLanRoot)
        : (usableStored || currentPublicRoot);
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

      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>🖨 พิมพ์ QR สำหรับลูกค้า</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#555' }}>
          จำนวนสำเนาต่อโต๊ะ
          <select value={printCopies} onChange={(e) => setPrintCopies(Number(e.target.value) || 1)}
                  style={{ ...inputStyle, width: 80, padding: '6px 8px', fontSize: 13 }}>
            {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button
          type="button"
          onClick={async () => {
            const list = tables.filter((t) => t.is_active);
            if (!list.length) return;
            try {
              for (const t of list) {
                await authFetch('/api/print/qr', {
                  method: 'POST',
                  body: JSON.stringify({
                    url: `${baseUrl}?t=${t.qr_token}`,
                    table_name: t.name,
                    table_code: t.code,
                    store_name: storeName,
                    store_logo: storeLogo,
                    copies: printCopies,
                  }),
                });
              }
              alert(`ส่งคิวพิมพ์ QR ${list.length} โต๊ะ × ${printCopies} ใบ`);
            } catch (e) { alert(`พิมพ์ไม่สำเร็จ: ${e.message}`); }
          }}
          style={btnPrimary}
        >
          🧾 พิมพ์ทุกโต๊ะ (เครื่องใบเสร็จ)
        </button>
        <button
          type="button"
          onClick={() => {
            const list = tables.filter((t) => t.is_active);
            if (!list.length) return;
            const qrUrls = list.map((t) => ({
              url: `${baseUrl}?t=${t.qr_token}`,
              tableName: t.name,
              tableCode: t.code,
            }));
            openMultiQrPrintWindow({
              storeName, storeLogo, tables: qrUrls,
              copies: printCopies, note: 'สแกน QR เพื่อสั่งอาหาร',
            });
          }}
          style={btnSecondary}
        >
          🌐 ทุกโต๊ะ (เบราว์เซอร์ A4)
        </button>
        <span style={{ fontSize: 11, color: '#888', flexBasis: '100%' }}>
          ปุ่ม "เครื่องใบเสร็จ" ส่งคิวพิมพ์ผ่าน thermal printer (ESC/POS) · ปุ่ม "เบราว์เซอร์" สำหรับเครื่องพิมพ์ A4 ทั่วไป
        </span>
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
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button onClick={() => window.open(qrSrc, '_blank')} style={{ ...btnSecondary, fontSize: 12, padding: '6px 10px' }}>
                  เปิดรูป
                </button>
                <button onClick={async () => {
                  try {
                    await authFetch('/api/print/qr', {
                      method: 'POST',
                      body: JSON.stringify({
                        url, table_name: t.name, table_code: t.code,
                        store_name: storeName, store_logo: storeLogo,
                        copies: printCopies,
                      }),
                    });
                    alert(`ส่งคิวพิมพ์ QR "${t.name}" × ${printCopies} ใบแล้ว`);
                  } catch (e) { alert(`พิมพ์ไม่สำเร็จ: ${e.message}`); }
                }} style={{ ...btnPrimary, fontSize: 12, padding: '6px 10px' }}>
                  🧾 พิมพ์
                </button>
                <button onClick={() => openQrPrintWindow({
                  url, tableName: t.name, tableCode: t.code,
                  storeName, storeLogo, copies: printCopies,
                  note: 'สแกน QR เพื่อสั่งอาหาร',
                })} style={{ ...btnSecondary, fontSize: 12, padding: '6px 10px' }}
                title="พิมพ์ผ่านเบราว์เซอร์ (สำหรับเครื่องพิมพ์ A4)">
                  🌐
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Bulk print: writes one window containing every table's QR on the
// same sheet, so the user can hand out paper QR codes in one go.
function openMultiQrPrintWindow({ storeName, storeLogo, tables, copies = 1, note }) {
  if (typeof window === 'undefined' || !tables?.length) return;
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { alert('Browser block popup'); return; }
  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const copyCount = Math.max(1, Math.min(8, Number(copies) || 1));
  const items = [];
  for (const t of tables) {
    for (let i = 0; i < copyCount; i += 1) {
      const qrSrc = `${apiBase}/api/qr?size=320&text=${encodeURIComponent(t.url)}`;
      items.push(`
        <section class="qr-card">
          ${storeName ? `<div class="store">${storeLogo ? esc(storeLogo) + ' ' : ''}${esc(storeName)}</div>` : ''}
          <div class="note">${esc(note || 'สแกน QR เพื่อสั่งอาหาร')}</div>
          <div class="table-name">${esc(t.tableName)}</div>
          ${t.tableCode ? `<div class="table-code">${esc(t.tableCode)}</div>` : ''}
          <img class="qr" src="${qrSrc}" alt="QR ${esc(t.tableCode)}" />
          <div class="url">${esc(t.url)}</div>
        </section>
      `);
    }
  }
  w.document.open();
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"/>
  <title>พิมพ์ QR ทุกโต๊ะ</title>
  <style>
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#f4f4f6;font-family:system-ui,-apple-system,"Segoe UI","Sarabun",sans-serif;color:#111}
    body{padding:24px 16px}
    .toolbar{position:sticky;top:0;background:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.08);display:flex;gap:8px;justify-content:center;margin-bottom:16px}
    .toolbar button{border:none;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer}
    .btn-primary{background:#1a1a2e;color:#fff}
    .btn-secondary{background:#f0f0f5;color:#1a1a2e}
    .sheet{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;max-width:1100px;margin:0 auto}
    .qr-card{background:#fff;border:2px dashed #999;border-radius:14px;padding:14px 12px;text-align:center;page-break-inside:avoid;break-inside:avoid}
    .store{font-size:12px;font-weight:700;color:#555;margin-bottom:4px}
    .note{font-size:11px;color:#777;margin-bottom:6px}
    .table-name{font-size:22px;font-weight:800;color:#1a1a2e;line-height:1.1}
    .table-code{font-size:11px;color:#888;margin-top:2px}
    .qr{width:100%;max-width:200px;height:auto;display:block;margin:10px auto}
    .url{font-size:10px;color:#666;word-break:break-all;padding:0 4px}
    @media print{
      body{background:#fff;padding:0}
      .toolbar{display:none}
      .sheet{max-width:none;margin:0;gap:0;grid-template-columns:repeat(2,1fr)}
      .qr-card{border-color:#ccc;box-shadow:none;margin:4mm;padding:6mm 4mm}
      @page{size:auto;margin:6mm}
    }
  </style></head>
  <body>
    <div class="toolbar">
      <button class="btn-primary" onclick="window.print()">🖨 พิมพ์</button>
      <button class="btn-secondary" onclick="window.close()">ปิด</button>
    </div>
    <main class="sheet">${items.join('')}</main>
    <script>
      window.addEventListener('load',()=>{const i=Array.from(document.images);let p=i.length;if(!p){setTimeout(()=>window.print(),400);return}i.forEach(x=>{if(x.complete){if(!--p)setTimeout(()=>window.print(),400)}else{x.addEventListener('load',()=>{if(!--p)setTimeout(()=>window.print(),400)});x.addEventListener('error',()=>{if(!--p)setTimeout(()=>window.print(),400)})}})});
    </script>
  </body></html>`);
  w.document.close();
}

// ─────────────────────────────────────────────────────────────────────
function PrinterTab() {
  const [config, setConfig] = useState(null);
  const [settings, setSettings] = useState(null);     // restaurant_settings
  const [paymentDraft, setPaymentDraft] = useState(null);
  const [orderingDraft, setOrderingDraft] = useState(null);
  const [stations, setStations] = useState([]);
  const [windowsPrinters, setWindowsPrinters] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingOrdering, setSavingOrdering] = useState(false);
  const [savingStationKey, setSavingStationKey] = useState(null);

  useEffect(() => {
    authFetch('/api/print/config').then(setConfig).catch((e) => setError(e.message));
    authFetch('/api/print/stations').then(setStations).catch(() => setStations([]));
    authFetch('/api/print/windows-printers').then(setWindowsPrinters).catch(() => setWindowsPrinters([]));
    authFetch('/api/settings').then((s) => {
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
        printer_key: saved.printer_key,
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
          เมื่อเปิด → backend จะคิวพิมพ์ใบงานครัวทันทีที่ลูกค้า/พนักงานยืนยันออเดอร์
          ใบเสร็จลูกค้าจะพิมพ์จากปุ่มของ staff/admin เท่านั้น
        </p>
        {settings ? (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
              <input type="checkbox" checked={!!settings.auto_print_kitchen}
                     onChange={(e) => toggleAuto('auto_print_kitchen', e.target.checked)} />
              <span>🍳 พิมพ์ใบครัวอัตโนมัติ</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', opacity: 0.7 }}>
              <input type="checkbox" checked={false} disabled readOnly />
              <span>🧾 ใบเสร็จลูกค้า: staff/admin พิมพ์เองเท่านั้น</span>
            </label>
            <p style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              💡 ปิด/เปิดจุดพิมพ์แต่ละโซนได้จากตารางด้านล่าง ระบบจะไม่ส่งงานไปโซนที่ปิดไว้
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
        <Row label="Transport" value={config.transport || 'tcp'} />
        <Row label="Host" value={config.host || '(ไม่ได้ตั้งค่า — จะ skip การพิมพ์)'} />
        <Row label="Port" value={String(config.port)} />
        <Row label="Windows printer" value={config.windows_printer_name || '-'} />
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
          ใช้ TCP ได้โดยกรอก IP/Port หรือใช้ Windows printer ได้โดยกรอก Printer key เป็น winspool:ชื่อเครื่องพิมพ์
        </p>
        {windowsPrinters.length > 0 && (
          <p style={{ fontSize: 11, color: '#666', margin: '0 0 10px' }}>
            Windows printers: {windowsPrinters.map((p) => p.name).join(' · ')}
          </p>
        )}
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
                <Field label="Printer key / Windows">
                  <input
                    style={inputStyle}
                    value={s.printer_key || ''}
                    list={`win-printers-${s.key}`}
                    placeholder="winspool:POS Thermal"
                    onChange={(e) => setStationField(s.key, 'printer_key', e.target.value)}
                  />
                  <datalist id={`win-printers-${s.key}`}>
                    {windowsPrinters.map((p) => (
                      <option key={p.name} value={`winspool:${p.name}`} />
                    ))}
                  </datalist>
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
function Modal({ title, onClose, children, maxWidth = 840 }) {
  return (
    <div onClick={onClose}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
                  zIndex: 100, padding: 'clamp(8px, 3vw, 16px)',
                  overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <div onClick={(e) => e.stopPropagation()}
             style={{ background: 'white', borderRadius: 14, padding: 'clamp(12px, 3vw, 16px)',
                      width: '100%', maxWidth, maxHeight: 'calc(var(--app-height, 100vh) - 24px)',
                      overflowY: 'auto', marginTop: 'clamp(8px, 4vh, 24px)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      marginBottom: 12, gap: 10, position: 'sticky', top: 0, background: 'white',
                      paddingBottom: 8, borderBottom: '1px solid #f0f0f5' }}>
          <h2 style={{ margin: 0, fontSize: 18, overflow: 'hidden',
                       textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h2>
          <button onClick={onClose} style={{ ...btnSecondary, padding: '4px 10px', flex: 'none' }}>✕</button>
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

// ─── Print Preview ──────────────────────────────────────────────────
// Editable HTML preview that mirrors the thermal receipt layout. Users
// can tweak header/footer/notes before printing via the browser or
// queueing the actual ESC/POS job.
function PrintPreviewModal({ orderId, onClose }) {
  const [order, setOrder] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [type, setType] = useState('receipt'); // 'receipt' | 'kitchen'
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const [header, setHeader] = useState('');
  const [stationLabel, setStationLabel] = useState('KITCHEN');
  const [footer, setFooter] = useState('ขอบคุณที่ใช้บริการ\nThank you');
  const [orderNote, setOrderNote] = useState('');
  const [items, setItems] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [ord, st] = await Promise.all([
          authFetch(`/api/orders/${orderId}`),
          authFetch('/api/settings').catch(() => null),
        ]);
        if (cancelled) return;
        setOrder(ord);
        setSettings(st || null);
        setHeader(st?.name || 'POS V2');
        setOrderNote(ord.note || '');
        setItems((ord.items || []).map((it) => ({
          key: it.id,
          product_name: it.product_name || '',
          variant_name: it.variant_name || '',
          quantity: Number(it.quantity) || 0,
          unit_price: Number(it.unit_price) || 0,
          note: it.note || '',
          options_text: Array.isArray(it.options_selected)
            ? it.options_selected.map((o) => o.value).join(' · ')
            : '',
        })));
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [orderId]);

  function setItem(idx, patch) {
    setItems((prev) => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
  }

  const total = items.reduce((s, it) => s + Number(it.unit_price || 0) * Number(it.quantity || 0), 0);

  async function sendToPrinter() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await authFetch(`/api/print/order/${orderId}?type=${type}`, { method: 'POST' });
      setNotice(`ส่งงานพิมพ์ (${type === 'receipt' ? 'ใบเสร็จ' : 'ใบสั่ง'}) เข้าคิวแล้ว`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function printBrowser() {
    if (typeof window !== 'undefined') window.print();
  }

  if (error && !order) {
    return (
      <Modal title="ตัวอย่างการพิมพ์" onClose={onClose} maxWidth={520}>
        <p style={{ color: '#c00' }}>{error}</p>
      </Modal>
    );
  }
  if (!order) {
    return (
      <Modal title="ตัวอย่างการพิมพ์" onClose={onClose} maxWidth={520}>
        <p>กำลังโหลด...</p>
      </Modal>
    );
  }

  const createdAt = new Date(order.created_at).toLocaleString('th-TH');
  const queueLabel = order.daily_seq ? `คิวที่ ${order.daily_seq}` : `Order #${order.id}`;
  const tableLabel = order.table_name || order.table_code || '-';

  return (
    <Modal title={`ตัวอย่างการพิมพ์ · Order #${order.id}`} onClose={onClose} maxWidth={780}>
      <div className="print-preview-no-print">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button onClick={() => setType('receipt')}
                  style={{ ...btnSecondary,
                           background: type === 'receipt' ? '#1a1a2e' : '#f0f0f5',
                           color: type === 'receipt' ? 'white' : '#1a1a2e' }}>
            🧾 ใบเสร็จลูกค้า
          </button>
          <button onClick={() => setType('kitchen')}
                  style={{ ...btnSecondary,
                           background: type === 'kitchen' ? '#1a1a2e' : '#f0f0f5',
                           color: type === 'kitchen' ? 'white' : '#1a1a2e' }}>
            🍳 ใบสั่งครัว
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginBottom: 12 }}>
          {type === 'receipt' && (
            <Field label="ชื่อร้าน (เฉพาะใบเสร็จนี้)">
              <input style={inputStyle} value={header} onChange={(e) => setHeader(e.target.value)} />
            </Field>
          )}
          {type === 'kitchen' && (
            <Field label="ป้ายหัวใบสั่ง">
              <input style={inputStyle} value={stationLabel} onChange={(e) => setStationLabel(e.target.value)} />
            </Field>
          )}
          <Field label="หมายเหตุออเดอร์">
            <input style={inputStyle} value={orderNote} onChange={(e) => setOrderNote(e.target.value)} />
          </Field>
          {type === 'receipt' && (
            <Field label="ข้อความท้ายใบเสร็จ">
              <textarea style={{ ...inputStyle, minHeight: 48, resize: 'vertical' }}
                        value={footer} onChange={(e) => setFooter(e.target.value)} />
            </Field>
          )}
        </div>

        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>รายการ ({items.length})</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {items.map((it, idx) => (
              <div key={it.key || idx}
                   style={{ display: 'grid',
                            gridTemplateColumns: 'minmax(0, 1.6fr) 70px 90px',
                            gap: 6, alignItems: 'center' }}>
                <input style={{ ...inputStyle, fontSize: 12 }}
                       value={it.product_name}
                       onChange={(e) => setItem(idx, { product_name: e.target.value })}
                       placeholder="ชื่อสินค้า" />
                <input type="number" min={0} style={{ ...inputStyle, fontSize: 12, textAlign: 'right' }}
                       value={it.quantity}
                       onChange={(e) => setItem(idx, { quantity: Number(e.target.value) || 0 })} />
                <input type="number" min={0} step="0.01"
                       style={{ ...inputStyle, fontSize: 12, textAlign: 'right' }}
                       value={it.unit_price}
                       onChange={(e) => setItem(idx, { unit_price: Number(e.target.value) || 0 })} />
              </div>
            ))}
            {items.length === 0 && (
              <div style={{ color: '#999', fontSize: 12 }}>ไม่มีรายการ</div>
            )}
          </div>
          <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
            * แก้ตัวอย่างนี้ใช้สำหรับพิมพ์เบราว์เซอร์เท่านั้น ไม่กระทบฐานข้อมูลออเดอร์
          </p>
        </div>
      </div>

      <div className="print-preview-shell">
        <div className="print-preview-paper">
          {type === 'receipt' ? (
            <>
              <div className="pp-center pp-big">{header || 'POS V2'}</div>
              <div className="pp-center">--- ใบเสร็จ / RECEIPT ---</div>
              <div className="pp-row">
                <span>{queueLabel}</span>
                <span>{tableLabel}</span>
              </div>
              <div>Order #{order.id}</div>
              <div>{createdAt}</div>
              <div className="pp-rule" />
              {items.map((it, idx) => {
                const lineTotal = (Number(it.unit_price) * Number(it.quantity)).toFixed(2);
                const variantSuffix = it.variant_name ? ` (${it.variant_name})` : '';
                return (
                  <div key={idx} style={{ marginBottom: 4 }}>
                    <div>{it.quantity} x {it.product_name}{variantSuffix}</div>
                    <div className="pp-row indent">
                      <span>@{Number(it.unit_price).toFixed(2)}</span>
                      <span>{lineTotal}</span>
                    </div>
                    {it.options_text && <div className="pp-row indent">&gt; {it.options_text}</div>}
                    {it.note && <div className="pp-row indent">*{it.note}</div>}
                  </div>
                );
              })}
              <div className="pp-rule" />
              <div className="pp-row pp-total">
                <span>TOTAL</span>
                <span>{total.toFixed(2)}</span>
              </div>
              {orderNote && (
                <>
                  <div className="pp-rule" />
                  <div className="pp-bold">หมายเหตุ:</div>
                  <div>{orderNote}</div>
                </>
              )}
              <div className="pp-rule" />
              {footer && (
                <div className="pp-center" style={{ whiteSpace: 'pre-line' }}>{footer}</div>
              )}
            </>
          ) : (
            <>
              <div className="pp-center pp-big">** {stationLabel || 'KITCHEN'} **</div>
              <div className="pp-center pp-bold" style={{ fontSize: 18 }}>{queueLabel}</div>
              <div className="pp-center pp-bold" style={{ fontSize: 16 }}>{tableLabel}</div>
              <div>Order #{order.id} · {createdAt}</div>
              <div className="pp-rule" />
              {items.map((it, idx) => {
                const variantSuffix = it.variant_name ? ` (${it.variant_name})` : '';
                return (
                  <div key={idx} style={{ marginBottom: 6 }}>
                    <div className="pp-bold" style={{ fontSize: 14 }}>
                      {it.quantity} x {it.product_name}{variantSuffix}
                    </div>
                    {it.options_text && <div className="pp-row indent">&gt; {it.options_text}</div>}
                    {it.note && <div className="pp-row indent">*{it.note}</div>}
                  </div>
                );
              })}
              <div className="pp-rule" />
              {orderNote && (
                <>
                  <div className="pp-bold">NOTE: {orderNote}</div>
                  <div className="pp-rule" />
                </>
              )}
            </>
          )}
        </div>
      </div>

      {error && <p style={{ color: '#c00', marginTop: 10 }}>{error}</p>}
      {notice && <p style={{ color: '#05795c', fontWeight: 700, marginTop: 10 }}>{notice}</p>}

      <div className="print-preview-no-print"
           style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={btnSecondary}>ปิด</button>
        <button onClick={printBrowser} style={btnSecondary}>🖨 พิมพ์ผ่านเบราว์เซอร์</button>
        <button onClick={sendToPrinter} style={btnPrimary} disabled={busy}>
          {busy ? 'กำลังส่ง...' : '📤 ส่งคิวพิมพ์จริง'}
        </button>
      </div>
    </Modal>
  );
}

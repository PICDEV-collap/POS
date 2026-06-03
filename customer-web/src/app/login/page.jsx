'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { login, loginStores, getAuth } from '@/lib/auth';

export default function LoginPageWrapper() {
  return (
    <Suspense fallback={
      <div className="login-shell">
        <div style={{ color: '#fff', fontSize: 14, opacity: .8 }}>กำลังโหลด...</div>
      </div>
    }>
      <LoginPage />
    </Suspense>
  );
}

const ROLE_HOME = {
  super_admin: '/admin',
  admin: '/admin',
  staff: '/staff',
  kitchen: '/kitchen',
};

const ROLE_ALLOWED_NEXT = {
  super_admin: ['/admin'],
  admin: ['/admin'],
  staff: ['/staff'],
  kitchen: ['/kitchen'],
};

function isAllowedNext(next, prefixes) {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return false;
  return prefixes.some((prefix) => (
    next === prefix || next.startsWith(`${prefix}/`) || next.startsWith(`${prefix}?`)
  ));
}

function destinationForRole(role, next) {
  const allowedNext = ROLE_ALLOWED_NEXT[role] || [];
  if (isAllowedNext(next, allowedNext)) return next;
  return ROLE_HOME[role] || '/';
}

function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [stores, setStores] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [loadingStores, setLoadingStores] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const auth = getAuth();
    if (auth) router.replace(destinationForRole(auth.user.role, next));
  }, [router, next]);

  useEffect(() => {
    let cancelled = false;
    async function loadStores() {
      setLoadingStores(true);
      try {
        const list = await loginStores();
        if (cancelled) return;
        const active = list.filter((store) => store.is_active !== false);
        setStores(active);
        setSelectedStoreId((current) => (
          active.some((store) => String(store.id) === String(current))
            ? current
            : (active[0]?.id ? String(active[0].id) : '')
        ));
        setLoadingStores(false);
      } catch (e) {
        if (cancelled) return;
        setStores([]);
        setSelectedStoreId('');
        setLoadingStores(false);
        setError(e.message);
      }
    }
    loadStores();
    return () => { cancelled = true; };
  }, []);

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (!selectedStoreId) throw new Error('กรุณาเลือกร้านก่อนเข้าสู่ระบบ');
      const data = await login(username, password, selectedStoreId);
      router.replace(destinationForRole(data.user.role, next));
    } catch (e) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <form onSubmit={submit} className="login-card">
        <div className="login-head">
          <div className="login-logo">🍽️</div>
          <h1>POS V2</h1>
          <p>เข้าสู่ระบบสำหรับ แอดมิน / พนักงาน / ครัว</p>
        </div>

        <div className="login-field">
          <label className="login-label" htmlFor="login-store">เลือกร้านที่จะจัดการ</label>
          <select
            id="login-store"
            value={selectedStoreId}
            onChange={(e) => setSelectedStoreId(e.target.value)}
            disabled={loadingStores || submitting}
            className="login-input"
          >
            {loadingStores && <option value="">กำลังโหลดรายชื่อร้าน...</option>}
            {!loadingStores && stores.length === 0 && <option value="">ยังโหลดรายชื่อร้านไม่ได้</option>}
            {!loadingStores && stores.map((store) => (
              <option key={store.id} value={store.id}>
                {(store.logo || 'ร้าน')} {store.name} (#{store.id})
              </option>
            ))}
          </select>
        </div>

        <div className="login-field">
          <label className="login-label" htmlFor="login-user">ชื่อผู้ใช้</label>
          <input
            id="login-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="login-input"
            placeholder="admin / staff / kitchen"
            autoComplete="username"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        <div className="login-field">
          <label className="login-label" htmlFor="login-pass">รหัสผ่าน</label>
          <input
            id="login-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="login-input"
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </div>

        {error && <p className="login-error">{error}</p>}

        <button
          type="submit"
          disabled={submitting || loadingStores || !selectedStoreId}
          className="login-submit"
        >
          {submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
        </button>

        <div className="login-hint">
          <b>บัญชีทดสอบ</b><br />
          admin / admin123 · kitchen / kitchen123
        </div>
      </form>
    </main>
  );
}

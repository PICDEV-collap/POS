'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { login, getAuth } from '@/lib/auth';

export default function LoginPageWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">กำลังโหลด...</div>}>
      <LoginPage />
    </Suspense>
  );
}

const ROLE_HOME = {
  admin: '/admin',
  kitchen: '/kitchen',
};

function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');
  const isStaffLogin = next?.startsWith('/staff');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isStaffLogin) {
      router.replace('/staff');
      return;
    }
    const auth = getAuth();
    if (auth) router.replace(next || ROLE_HOME[auth.user.role] || '/');
  }, [router, next, isStaffLogin]);

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const data = await login(username, password);
      router.replace(next || ROLE_HOME[data.user.role] || '/');
    } catch (e) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4"
          style={{ background: 'linear-gradient(135deg,#1a1a2e,#16213e)' }}>
      <form onSubmit={submit}
            className="w-full max-w-sm bg-white rounded-2xl p-6 shadow-2xl">
        <div className="text-center mb-6">
          <div className="text-3xl mb-2">🍽️</div>
          <h1 className="text-xl font-extrabold" style={{ color: '#1a1a2e' }}>
            POS V2
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            เข้าสู่ระบบสำหรับครัว / แอดมิน
          </p>
        </div>

        <label className="block text-xs font-bold text-gray-600 mb-1">ชื่อผู้ใช้</label>
        <input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 mb-3 outline-none focus:border-gray-800"
          placeholder="admin / kitchen"
        />

        <label className="block text-xs font-bold text-gray-600 mb-1">รหัสผ่าน</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 mb-4 outline-none focus:border-gray-800"
          placeholder="••••••••"
        />

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        <button
          disabled={submitting}
          className="w-full text-white font-bold py-3 rounded-xl disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg,#1a1a2e,#203a43)' }}
        >
          {submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
        </button>

        <div className="mt-5 pt-4 border-t border-gray-100 text-xs text-gray-500 leading-relaxed">
          <div className="font-bold mb-1">บัญชีทดสอบ:</div>
          <div>admin / admin123</div>
          <div>kitchen / kitchen123</div>
        </div>
      </form>
    </main>
  );
}

# POS_V2 — Security Hardening Checklist

**สถานะปัจจุบัน:** dev-ready + multi-store boundary, **ก่อน production ต้องทำ Phase A ให้ครบทุกข้อ**

## ระบบความปลอดภัยที่มีอยู่แล้ว (สรุป)

### การยืนยันตัวตนและสิทธิ์

| ชั้น | รายละเอียด |
|------|------------|
| **JWT** | Bearer token, อายุตาม `JWT_EXPIRES_IN`, ตรวจ `users.is_active` ทุก request |
| **Role** | `super_admin`, `admin`, `staff`, `kitchen` — `requireRole()` บน route |
| **Multi-store** | `X-POS-Store-ID` + `allowed_store_ids` — staff ข้ามร้านไม่ได้ |
| **Login** | bcrypt cost 12, rate limit 10 ครั้ง / 10 นาที / IP |

### ขอบเขตการควบคุม (Access boundary)

เมื่อ `ADMIN_CONTROL_LAN_ONLY=true` (ค่าเริ่มต้น):

- การ **แก้ไขร้าน / ผู้ใช้ / เมนู / หมวด / สินค้า (admin)** / ตั้งค่าเครื่องพิมพ์ / retry คิวพิมพ์ ต้องมาจาก **LAN หรือ loopback** (IP ส่วนตัว / 127.x)
- **Staff / kitchen** ยังใช้งานผ่าน tunnel (ngrok) ได้สำหรับรับออเดอร์และครัว
- **Mobile store admin** (`permissions`: `mobile_admin` หรือ `store_admin`) แก้เมนู/ร้านที่ได้รับอนุญาตจากภายนอกได้ตาม path ที่จำกัดใน `accessBoundary.js`

โค้ดหลัก: `backend/src/lib/accessBoundary.js`, `backend/src/middleware/auth.js`

### ลูกค้า (ไม่ login)

| การป้องกัน | ไฟล์ |
|------------|------|
| QR token สุ่ม 16 bytes | `tables.qr_token` |
| Session สั่งอาหาร + TTL | `publicOrderGuard.js` |
| ช่วงเวลาเปิดร้าน / วันในสัปดาห์ | per-store ใน `stores` |
| GPS / private IP (ตั้งได้) | `ordering_require_*` |
| Rate limit สั่งอาหาร | `publicOrderLimiter` ใน `server.js` |

### เครือข่ายและ HTTP

- `helmet` (HSTS, X-Frame-Options, …)
- `trust proxy: 1` สำหรับ Caddy / nginx / Docker proxy
- Production bind `127.0.0.1` (หรือ `0.0.0.0` เฉพาะภายใน Docker network)
- CORS allowlist จาก `CORS_ORIGINS`
- Body limit 1 MB, อัปโหลดรูปจำกัด MIME/ขนาด

### ngrok (tunnel แทน public IP)

เมื่อใช้ `restart-services.bat` + ngrok → browser เห็น **origin เดียว** (`https://xxx.ngrok-free.app`)

| หัวข้อ | แนวทาง |
|--------|--------|
| API | `NEXT_PUBLIC_API_BASE=` ว่าง — Next.js proxy `/api/*` ไป backend |
| QR ลูกค้า | `PUBLIC_BASE_URL=https://<static-ngrok-domain>` |
| Admin แก้เมนูผ่าน ngrok | ตั้ง `ADMIN_CONTROL_TUNNEL_HOSTS=<static-ngrok-domain>` หรือเข้าแอดมินผ่าน LAN IP |
| Staff / ครัว | ใช้ URL ngrok ได้ตามปกติ (ไม่โดน LAN guard บน path ปฏิบัติการ) |
| CORS | ไม่ต้องเพิ่ม ngrok ใน `CORS_ORIGINS` เมื่อ same-origin |

รายละเอียด: [`ngrok.md`](ngrok.md)

### Docker (ถ้าใช้ `docker compose` — ไม่จำเป็นถ้าใช้ ngrok อยู่แล้ว)

- Postgres และ backend **ไม่** map พอร์ตออก host ใน compose มาตรฐาน
- เข้าระบบผ่าน **Caddy** (พอร์ต 80/443) — ส่ง `X-Forwarded-For` ให้ LAN guard ทำงาน; ตั้ง `CADDY_DOMAIN` สำหรับ TLS อัตโนมัติ
- รัน container ด้วย user ไม่ใช่ root (`pos` / `posweb`)
- ดู [`docker/README.md`](docker/README.md)

```bash
# ตรวจ header หลัง proxy
curl -I http://localhost:8080/api/health
```

## Phase A — ต้องทำก่อน production (Critical)

### A1. Rotate ทุก secret ที่อาจ leak ตอน dev

ทุกค่า default ใน `.env.example` และทุกค่าที่อยู่ใน chat history / repo → **ถือว่าถูก leak ทั้งหมด**

```bash
cd backend
npm run rotate-secrets > .env.new      # generate ค่าใหม่
# 1. เปิด .env.new ดู — copy ค่า JWT_SECRET, VAPID_*, PGPASSWORD ไปใส่ใน .env
# 2. Apply password ใหม่ของ Postgres ตามคำสั่งใน .env.new
# 3. ลบ .env.new ทิ้งหลัง copy เสร็จ
```

**ค่าที่ต้อง rotate:**
- ✅ `JWT_SECRET` — token signing key
- ✅ `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` — Web Push
- ✅ `PGPASSWORD` — Postgres `postgres` user
- ✅ `JWT_EXPIRES_IN=2h` (ลดจาก 12h)

### A2. ห้าม seed dev users ใน production

`db:seed` มี guard อยู่แล้ว: เมื่อ `NODE_ENV=production` จะ **refuse** insert default users
สร้าง admin ของจริงด้วย:
```bash
NODE_ENV=production node scripts/create-admin.js admin "<strong-password-≥10>" "Administrator"
```

### A3. Backend bind 127.0.0.1 + Caddy เป็นหน้า

`server.js` ตั้งค่า default ตาม `NODE_ENV`:
- `NODE_ENV=production` → bind `127.0.0.1:4000` (loopback only)
- ไม่ตั้ง → bind `0.0.0.0:4000` (LAN reachable, สำหรับ dev)

ใช้ Caddy (configs ใน `deploy/Caddyfile`) เป็น reverse proxy ทำ HTTPS + เปิด `:443` ให้โลกเห็น

### A4. HTTPS ทุก client

- Web (`localhost:3000`) → ผ่าน Caddy `https://your-domain`
- Mobile APK → build ด้วย `--dart-define=POS_API_BASE=https://your-domain`
- ตอน production ลบ `usesCleartextTraffic="true"` ใน `mobile/android/app/src/main/AndroidManifest.xml`

### A5. Firewall

รัน `deploy/firewall-allow.ps1` แบบ admin → เปิด 80, 443, 5353/UDP เท่านั้น
**ปิด 4000 และ 3000 ไม่ให้ external เห็น** (Caddy ที่ 443 จะ proxy ให้)

## Phase B — สัปดาห์แรกหลัง launch (Important)

### B1. Account lockout ✅
- ตาราง `login_attempts` — ล็อก username หลัง fail 5 ครั้ง / 15 นาที (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES`)

### B2. Refresh token ✅
- ตาราง `refresh_tokens` + `POST /api/auth/refresh` + `POST /api/auth/logout`
- Web/mobile เก็บ `refresh_token` และ refresh อัตโนมัติเมื่อ JWT หมดอายุ

### B3. Audit log ✅ (admin control)
- ตาราง `audit_log` — บันทึก create/update/delete ร้านและผู้ใช้
- ขยาย hook ใน routes อื่นได้ตามต้องการ

```bash
cd backend && npm run harden:production   # env + ลบ staff1/kitchen
cd backend && node scripts/migrate.js
cd backend && npm run security:verify
```

### B4. ลบ default `admin/admin123` ที่ค้างใน DB จาก dev
```bash
node -e "require('dotenv').config(); const db=require('./src/db'); db.query(\"DELETE FROM users WHERE username IN ('admin','staff1','kitchen') AND password_hash LIKE '\\$2b\\$10\\$%'\").then(r => console.log('removed', r.rowCount))"
```
หรือผ่าน psql:
```sql
DELETE FROM users WHERE username IN ('admin','staff1','kitchen');
```

## Phase C — Nice to have

- 2FA สำหรับ admin (TOTP — `speakeasy` package)
- Encrypted DB backup ด้วย `pg_dump` + `gpg`
- Monitoring + alert (UptimeRobot / Sentry)
- `helmet.contentSecurityPolicy` strict (ตอนนี้ปิดเพราะ web frontend อยู่คนละ origin)
- IP allowlist ของ /api/admin/* เฉพาะ LAN (เผื่อ accidentally expose)

## ที่ทำแล้วใน Phase A (โค้ด)

| ✓ | What |
|---|------|
| ✅ `helmet` middleware — HSTS, X-Frame-Options, X-Content-Type-Options, COOP ฯลฯ |
| ✅ `express-rate-limit`: 10 attempts/10 min บน `/api/auth/login` |
| ✅ Public order rate limit: 20/นาที/IP |
| ✅ API generic limit: 600/นาที/IP |
| ✅ `trust proxy: 1` — รับ X-Forwarded-For จาก Caddy |
| ✅ `bcrypt` cost 10 → **12** (~250ms hash time, ทน brute force ดีขึ้น 4 เท่า) |
| ✅ Production seed guard — refuse default users เมื่อ `NODE_ENV=production` |
| ✅ `LISTEN_HOST` env — production = 127.0.0.1 default |
| ✅ `npm run rotate-secrets` — generate JWT/VAPID/DB password |
| ✅ `npm run create-admin` — สร้าง admin ปลอดภัยพร้อม bcrypt cost 12 |
| ✅ Path-traversal guard บน /uploads delete |
| ✅ Parameterized SQL queries ทุกที่ — กัน SQL injection |
| ✅ JWT verify บน wrapped routes ทุก protected endpoint |
| ✅ Customer QR token = 16 random bytes hex (กัน enumeration) |
| ✅ CORS allowlist เฉพาะ origins ใน env |
| ✅ JSON body limit 1 MB |
| ✅ Multer 5 MB image limit + MIME whitelist |

## Quick verify ว่า hardening ทำงาน

```bash
# 1. headers
curl -I http://localhost:4000/api/health
# ต้องเห็น: Strict-Transport-Security, X-Frame-Options, X-Content-Type-Options, COOP

# 2. login rate limit (ครั้งที่ 11+ ต้อง 429)
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "$i: %{http_code}\n" -X POST -H "Content-Type: application/json" \
    -d '{"username":"x","password":"x"}' http://localhost:4000/api/auth/login
done

# 3. seed refuses dev users in prod
NODE_ENV=production npm run db:seed
# ต้องเห็น: "refusing to insert dev users with default passwords"
```

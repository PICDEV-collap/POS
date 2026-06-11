<<<<<<< HEAD
# POS
KrutomNoodle
=======
# POS_V2

ระบบ POS ตามสถาปัตยกรรมใน `pi.txt` — Windows 11 server เป็นศูนย์กลาง,
client หลายตัว (Admin/Staff/Kitchen + Customer QR), real-time ผ่าน WebSockets,
รองรับเครื่องพิมพ์ Thermal A70Pro

## โครงสร้างโปรเจกต์

```
POS_V2/
├── backend/        Node.js (Express) + PostgreSQL + Socket.io + ESC/POS printer
├── customer-web/   Next.js — Customer / Staff / Kitchen / Admin (web)
├── database/       SQL schema + seed
├── mobile/         (Phase 2.2 — Flutter, ยังไม่ได้ทำ)
├── app.js          (เอกสารอ้างอิง: ระบบเดิม single-file)
└── pi.txt          เอกสารออกแบบ
```

## ภาพรวมการไหลของข้อมูล

```
   ลูกค้า (มือถือ)              พนักงาน/ครัว/แอดมิน (Web)
        │                              │
        │ HTTP /api/public/*           │ HTTP /api/* + Socket.io + JWT
        ▼                              ▼
   ┌────────────────────────────────────────┐
   │  Backend (Windows 11)                  │
   │  Express  +  Socket.io  +  printer.js  │
   └────────────────────────────────────────┘
              │                       │
              ▼                       ▼
       PostgreSQL  (pos_v2)    Thermal Printer (A70Pro, TCP/IP, ESC/POS)
```

## หน้า Web ทั้งหมด

| Path | Role | คำอธิบาย |
|------|------|---------|
| `/` | — | landing |
| `/order?t=<qr_token>` | ลูกค้า | สแกน QR → menu + cart + place order |
| `/order/status?t=...&id=...` | ลูกค้า | poll สถานะออเดอร์ |
| `/login` | shared | login form (admin/staff/kitchen) |
| `/staff` | staff/admin | sidebar โต๊ะ + grid เมนู + ปุ่มชำระ + 🖨️ พิมพ์ใบเสร็จ |
| `/kitchen` | kitchen/staff/admin | dark theme display, status transitions, realtime, 🖨️ พิมพ์ใบสั่งครัว |
| `/admin` | admin/staff | tabs: ภาพรวม/ออเดอร์/เมนู/หมวด/โต๊ะ/QR/เครื่องพิมพ์ (staff เห็นแค่ ภาพรวม + ออเดอร์ + QR) |

## API endpoints

### Public (ลูกค้าใช้, identify ด้วย qr_token)
- `GET  /api/public/table/:token`
- `GET  /api/public/menu`
- `POST /api/public/orders`
- `GET  /api/public/orders/:id?token=`

### Auth + JWT
- `POST /api/auth/login`     `{ token, user }`
- `GET  /api/auth/me`

### Orders
- `GET   /api/orders[?status=]`           — staff/admin/kitchen
- `GET   /api/orders/:id`                 — staff/admin/kitchen
- `POST  /api/orders`                     — staff/admin (สั่งแทน)
- `PATCH /api/orders/:id/status`          — staff/admin/kitchen
- `PATCH /api/orders/items/:itemId/status`— staff/admin/kitchen

### Catalog (admin)
- `GET    /api/categories`         (public — เปิดใช้เท่านั้น)
- `GET    /api/categories/all`     (admin — รวมที่ปิดใช้)
- `POST   /api/categories`
- `PUT    /api/categories/:id`
- `DELETE /api/categories/:id`     (soft delete: is_active=false)
- `GET    /api/products[?category_id=&available_only=1]`
- `POST   /api/products`
- `PUT    /api/products/:id`
- `DELETE /api/products/:id`

### Tables (admin)
- `GET    /api/tables`
- `POST   /api/tables`
- `PUT    /api/tables/:id`
- `POST   /api/tables/:id/rotate-qr`
- `DELETE /api/tables/:id`

### QR / Printer
- `GET  /api/qr?text=<>&size=<>`         — public, returns PNG (cached 24h)
- `GET  /api/print/config`               — auth
- `POST /api/print/test`                 — admin/staff (enqueues, returns 202)
- `POST /api/print/order/:id?type=kitchen|receipt` — admin/staff/kitchen (enqueues)
- `GET  /api/print/jobs[?status=&limit=]`— auth (queue listing)
- `POST /api/print/jobs/:id/retry`       — admin (re-queue failed/cancelled)
- `POST /api/print/jobs/:id/cancel`      — admin/staff

### Realtime (Socket.io, mounted บน HTTP server เดียวกัน)
- `order:new`    — ออเดอร์ใหม่
- `order:update` — สถานะ/รายการเปลี่ยน

## Thermal Printer (A70Pro / ESC-POS)

- ส่ง raw bytes ผ่าน TCP/IP ไป `PRINTER_HOST:PRINTER_PORT` (default 9100)
- ภาษาไทยเข้ารหัสเป็น **TIS-620** + เลือก code page ผ่าน `ESC t 0x15` (Thai cp 21)
- 2 layout: **kitchen receipt** (รายการอาหาร, ตัด partial) และ **customer receipt** (มี total + ขอบคุณ, ตัด full)
- ทดสอบโดยไม่ต้องมีเครื่องจริง: `node backend/scripts/mock-printer.js` (TCP listener ที่ port 9100, dump bytes + decode TIS-620)

### Persistent Print Queue (DB-backed)
- เก็บใน table `print_jobs` (BYTEA payload + status + attempts + next_attempt_at)
- Worker loop เดียวต่อ process: `claim FOR UPDATE SKIP LOCKED` หยิบงานทีละชิ้น
- **Retry แบบ linear backoff** — fail แล้ว requeue ที่ `now + attempts * 5s` (default 5 ครั้ง)
- **Boot recovery** — รีสตาร์ทแล้ว job ที่ `printing` ค้าง → reset เป็น `queued` อัตโนมัติ
- **Admin UI**: `/admin` → tab "📑 คิวพิมพ์" — รีเฟรชอัตโนมัติทุก 3 วิ, retry/cancel ได้

## Quick start

ต้องมี **Node.js 18+** และ **PostgreSQL 14+** บน Windows 11

```bash
# 1. ฐานข้อมูล
createdb -U postgres pos_v2  # (หรือ: psql -U postgres -c "CREATE DATABASE pos_v2 ENCODING 'UTF8';")

# 2. backend
cd backend
cp .env.example .env             # แก้ DB credentials + JWT_SECRET + PRINTER_HOST
npm install
npm run db:reset                 # apply schema + seed + dev users (จะ print QR tokens ออกมา)
npm run dev                      # http://localhost:4000

# 3. customer web (เปิดอีก terminal)
cd ../customer-web
cp .env.example .env.local
npm install
npm run dev                      # http://localhost:3000
```

ทดลอง:
- ลูกค้า: `http://localhost:3000/order?t=<qr_token>` (ใช้ token จาก step 2)
- พนักงาน: `http://localhost:3000/login` → admin/admin123 → ไป `/staff` หรือ `/admin`
- ครัว: login เป็น `kitchen/kitchen123` → ไป `/kitchen`

## Default users (dev)

| username | password   | role    |
|----------|-----------|---------|
| admin    | admin123  | admin   |
| staff1   | staff123  | staff   |
| kitchen  | kitchen123| kitchen |

## Phase ต่อไป (ยังไม่ได้ทำ)

### 2.2 Flutter mobile app (แยก session)
ต้องติดตั้ง Flutter SDK + Android Studio ก่อน — เป็น project แยก
ใช้ packages: `dio` (HTTP), `socket_io_client`, `flutter_secure_storage` (JWT), `provider`/`riverpod`
Single codebase, 3 view ตาม role (admin/staff/kitchen)
รองรับ offline mode ด้วย Drift หรือ sqflite

### Production deployment

📘 **คู่มือฉบับเต็ม:** [`deploy/INSTALL.md`](./deploy/INSTALL.md) — step-by-step ตั้งแต่เปล่าจนใช้งานได้
🔒 **Security checklist:** [`deploy/SECURITY.md`](./deploy/SECURITY.md) — hardening Phase A/B/C
📋 **Runbook สั้น:** [`deploy/README.md`](./deploy/README.md) — สำหรับคนที่คุ้นแล้ว

พร้อมไฟล์ตั้งค่า:
- `deploy/Caddyfile` — Reverse proxy + auto Let's Encrypt HTTPS (หรือ `tls internal` สำหรับ LAN)
- `deploy/ecosystem.config.js` — PM2 process config
- `deploy/install-windows-service.bat` — ติดตั้งเป็น Windows service ผ่าน nssm
- `deploy/firewall-allow.ps1` — เปิด ports ใน Windows Firewall

### Web Push notifications (ครัว)

- VAPID keys ใน `.env` (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`) — generate:
  `node -e "console.log(require('web-push').generateVAPIDKeys())"`
- เปิดในเบราว์เซอร์ → `/kitchen` → กดปุ่ม 🔕 ที่ header → grant permission → subscribe
- เมื่อมีออเดอร์ใหม่ (จาก customer หรือ staff) backend จะส่ง push ไปทุก subscription ที่ `scope='kitchen'`
- Service worker อยู่ที่ `customer-web/public/sw.js`
- ⚠️ Push **ต้องการ HTTPS** ในโปรดักชัน (yes localhost ใช้ได้ตอน dev)

### Bitmap-rendered Thai print

สำหรับเครื่องพิมพ์ที่ font Thai เพี้ยน (สระลอย/มาตราเพี้ยน) — ใช้ canvas render เป็นภาพแล้วส่งเป็น ESC/POS raster
- ตั้ง `PRINTER_RENDER_MODE=image` ใน `.env`
- ตั้ง `PRINTER_FONT_PATH=` (ถ้าไม่ตั้งจะใช้ Tahoma จาก `C:/Windows/Fonts`)
- ตั้ง `PRINTER_WIDTH_PX=384` (58mm) หรือ `576` (80mm)
- ใช้ font ที่รองรับ Thai shaping (Tahoma / Sarabun / Leelawadee UI / Noto Sans Thai)

### Offline mode (mobile)

- Drift schema: `cached_orders` + `pending_actions` (ดู `mobile/lib/db/database.dart`)
- `OfflineRepository` ทำ cache-first read + queue offline mutations + flush เมื่อกลับ online
- KitchenScreen banner: `🟢 live` / `🟡 polling` / `🔴 offline · ⏳ N pending`
- Linear backoff retry (5s, 10s, 15s) สำหรับ pending actions

### mDNS Server discovery

- Backend advertise `_pos_v2._tcp.local` ด้วย `bonjour-service`
- Mobile (Flutter): Settings screen → ปุ่ม "สแกน LAN" ใช้ bonsoir + แสดงรายการที่พบ
- Web fallback: `GET /api/discovery/info` คืน hostname/IP/version
- Android permissions เพิ่มไว้แล้วใน `mobile/android/app/src/main/AndroidManifest.xml`

### Image upload (เมนู)

- `POST /api/products/:id/image` (multipart, multer, ≤5MB jpeg/png/webp/gif) — admin only
- เก็บไฟล์ที่ `backend/uploads/products/<random>.<ext>`
- Static serve `/uploads/*` (cache 7 วัน)
- Admin ProductModal มี file picker + preview
- รูปแสดงใน customer + staff menus

### ที่เหลือ (nice-to-have)

- **Print Queue persistence** ✅ DONE
- **Offline mode** ✅ DONE
- **Local server discovery (mDNS)** ✅ DONE
- **Image upload** ✅ DONE
- **Bitmap Thai print** ✅ DONE
- **Push notifications** ✅ DONE
- **HTTPS + production deployment** ✅ DONE (configs + runbook)
- **Bonsoir Android scanning** ✅ DONE
- **Local server discovery** — mDNS/Bonjour
- **Image upload** สำหรับเมนู — เก็บไฟล์บน server, serve static
- **HTTPS + Static IP** ของ server กับเครื่องพิมพ์
- **Image-rendered Thai print** — สำหรับเครื่องพิมพ์ที่ไม่รองรับ TIS-620 (render เป็น bitmap แล้ว ESC * — แทน ESC t)
>>>>>>> 254fe99 (Initial POS V2 project import)

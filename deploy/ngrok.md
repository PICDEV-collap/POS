# POS_V2 — ngrok setup (แทน Caddy)

ใช้ตอนต้องการให้ลูกค้าสแกน QR จากร้านที่ไม่มี public IP / domain
หรือ demo POS_V2 ให้ลูกค้าดูได้ผ่าน internet

## ทำไมต้องใช้ Next.js rewrites + ngrok 1 port

ngrok free tunnel ได้ 1 port — เราต้อง consolidate web (3000) + backend (4000) เป็น
endpoint เดียว ทำได้ด้วย Next.js rewrites ที่ proxy `/api/*`, `/uploads/*`, `/socket.io/*`
ไปที่ backend ภายใน

```
   Internet
        │
        ▼   https://abc123.ngrok-free.app
   ┌────────────────────────────┐
   │   ngrok cloud (Free)       │
   └─────────────┬──────────────┘
                 │ tunnel
                 ▼
        localhost:3000 (Next.js)
                 │
                 ├── /api/* /uploads/* /socket.io/*  → localhost:4000 (Express)
                 └── /, /order, /staff, /kitchen, /admin (Next.js pages)
```

## ขั้นตอน

### 1. สมัคร ngrok และติดตั้ง

ดาวน์โหลด: https://ngrok.com/download
สมัครฟรีรับ authtoken: https://dashboard.ngrok.com/get-started/your-authtoken

```bash
ngrok config add-authtoken <your-token>
```

### 2. ตั้ง env ให้ Next.js ใช้ same-origin

```bash
# customer-web/.env.local
NEXT_PUBLIC_API_BASE=                # ← เว้นว่าง = same-origin
BACKEND_INTERNAL_URL=http://localhost:4000
```

ถ้าค่า `NEXT_PUBLIC_API_BASE` เป็น `""` (empty) — browser จะเรียก URL relative เช่น `/api/health`
แล้ว Next.js rewrites (config ใน `next.config.js`) proxy ไปที่ backend ภายใน

### 3. Build + start customer-web (production mode)

```bash
cd customer-web
npm run build
npm start                            # http://localhost:3000
```

(หรือใน dev mode `npm run dev` ก็ใช้ rewrites ได้ — แต่ HMR + WS อาจ flaky บ้าง)

### 4. รัน backend ปกติ

```bash
cd backend
npm start                            # http://localhost:4000
```

### 5. เปิด ngrok tunnel

```bash
ngrok http 3000
```

จะได้ output ประมาณนี้:
```
Forwarding   https://7a3b-203-0-113-42.ngrok-free.app -> http://localhost:3000
```

ทดสอบ:
- `https://7a3b-...ngrok-free.app/`           → home page
- `https://7a3b-...ngrok-free.app/api/health` → `{"ok":true,...}` (proxy)
- `https://7a3b-...ngrok-free.app/order?t=<token>` → ลูกค้าสั่ง

### 6. CORS ในกรณี ngrok

`CORS_ORIGINS` ของ backend ไม่จำเป็นต้องเพิ่ม URL ngrok เพราะ browser มอง same-origin
(เห็น URL `https://abc.ngrok-free.app` ทั้งระบบ — request ไปที่ origin เดียวกัน)

### 7. ตั้ง PUBLIC_BASE_URL ให้ QR ใช้ ngrok URL

ใน `backend/.env`:
```bash
PUBLIC_BASE_URL=https://my-shop.ngrok-free.app
```

แล้ว restart backend — admin → tab "QR" จะ default ไปใช้ URL นี้ทันที QR ที่พิมพ์
จะ point หา ngrok tunnel ลูกค้าสแกนแล้วเปิดในมือถือบน 4G/5G ได้เลย ไม่ต้องอยู่ Wi-Fi
เดียวกับร้าน

## ⚠️ ข้อจำกัดสำคัญ

| ปัญหา | คำอธิบาย | ทางแก้ |
|------|--------|------|
| **WebSockets ใน dev mode** | Next.js dev server ไม่ proxy WS (ผ่าน `rewrites`) | ใช้ `npm run build && npm start` (production), หรือใช้ Caddy แทน |
| **Free tier URL เปลี่ยนทุกครั้ง** | เริ่ม ngrok ใหม่ → URL ใหม่ → QR code โต๊ะที่พิมพ์ไว้ใช้ไม่ได้ | Static domain $8/mo, หรือ rotate qr_token พร้อมพิมพ์ใหม่ |
| **Free tier มี warning page** | ครั้งแรกที่เข้า ngrok แสดงหน้าเตือน | จ่าย ngrok หรือใช้ custom domain |
| **Push notifications ต้อง HTTPS** | ngrok ให้ HTTPS อยู่แล้ว ✅ | — |
| **mDNS** ใช้ไม่ได้ผ่าน ngrok | mDNS ต้อง LAN เดียวกัน | ลูกค้าใช้ URL ngrok แทน scan |
| **Static domain ฟรี** | ngrok มี **1 static domain ฟรีต่อ account** | `ngrok http --domain=your-name.ngrok-free.app 3000` |

## Static domain ฟรี (แนะนำมาก)

ngrok account ฟรีให้ static URL 1 อันต่อ account ที่ไม่เปลี่ยน

1. Dashboard → Domains → New Domain → ตั้งชื่อ เช่น `my-shop.ngrok-free.app`
2. รัน:
   ```bash
   ngrok http --domain=my-shop.ngrok-free.app 3000
   ```
3. QR code ของโต๊ะ point ไปที่ URL นี้ได้ตลอด

## ngrok config file (ถ้าต้องการรันเป็น service)

`%USERPROFILE%\.ngrok2\ngrok.yml` (Windows) หรือ `~/.ngrok2/ngrok.yml`:

```yaml
version: "3"
authtoken: <your-token>
tunnels:
  pos-v2:
    proto: http
    addr: 3000
    domain: my-shop.ngrok-free.app    # static domain ฟรี (1 อันต่อ account)
    inspect: false                     # ปิด ngrok inspect web เพื่อ performance
```

แล้วรัน:
```bash
ngrok start pos-v2
```

ทำเป็น Windows service ผ่าน nssm:
```cmd
nssm install ngrok-pos "C:\ngrok\ngrok.exe" "start pos-v2"
nssm start ngrok-pos
```

## เปรียบเทียบ ngrok vs Caddy สำหรับ POS_V2

| Use case | ngrok | Caddy |
|----------|:-----:|:-----:|
| Demo ให้ลูกค้าดู ไม่มี domain | ✅ ดีกว่า | — |
| ร้านอยู่หลัง NAT ไม่มี public IP | ✅ ดีกว่า | — |
| ใช้ในร้านบน LAN เดียวกันอยู่แล้ว | over-engineered | ✅ ดีกว่า (TLS internal) |
| Production มี domain/IP | over-engineered | ✅ ดีกว่า (no monthly fee) |
| Push notifications HTTPS dev | ✅ ดีกว่า | LAN: ใช้ `tls internal` ได้ |
| WebSocket ตรง | บางครั้ง flaky | ✅ มั่นคง |

**แนะนำสำหรับร้านที่ใช้ ngrok อยู่แล้ว (เช่น WinSW + `restart-services.bat`):**

- **ไม่ต้อง** ใช้ Docker/Caddy เว้นแต่จะย้าย infra
- ใช้ **static domain ฟรี** 1 อันของ ngrok → QR ไม่หลุดทุกครั้ง restart
- ตั้ง `PUBLIC_BASE_URL` + `ADMIN_CONTROL_TUNNEL_HOSTS` ให้ตรงโดเมน (ดูด้านล่าง)

## ตั้งค่า POS V2 + ngrok (production checklist)

### A. customer-web (same-origin — สำคัญ)

สร้าง/แก้ `customer-web/.env.local`:

```env
NEXT_PUBLIC_API_BASE=
BACKEND_INTERNAL_URL=http://localhost:4000
```

แล้ว `npm run build` + restart `pos-v2-web`

### B. backend `.env`

```env
PUBLIC_BASE_URL=https://<your-static-domain>.ngrok-free.app
ADMIN_CONTROL_TUNNEL_HOSTS=<your-static-domain>.ngrok-free.app
ADMIN_CONTROL_LAN_ONLY=true
```

- `PUBLIC_BASE_URL` — QR ลูกค้า / discovery
- `ADMIN_CONTROL_TUNNEL_HOSTS` — ให้แอดมินแก้เมนู/ร้านผ่าน ngrok ได้ (ไม่ถูก LAN guard บล็อก) โดยยังต้อง login + JWT

ทางเลือก: แอดมินใช้ `http://192.168.x.x:3000` ใน Wi‑Fi ร้านเท่านั้น — ไม่ต้องตั้ง `ADMIN_CONTROL_TUNNEL_HOSTS`

### C. ngrok config (`deploy/ngrok.yml`)

คัดลอกจาก `deploy/ngrok.example.yml` ใส่ authtoken + static domain แล้ว restart:

```bat
D:\POS_V2\deploy\services\restart-services.bat
```

สคริปต์จะ start ngrok แบบ hidden และพิมพ์ public URL ใน log

### D. Multi-store

Login เลือกร้าน → QR แต่ละร้านใช้ `PUBLIC_BASE_URL` หรือ `stores.public_base_url` ในแอดมิน

## เปรียบเทียบ ngrok vs Caddy vs Docker

| สถานการณ์ | แนะนำ |
|-----------|--------|
| ร้านใช้ ngrok + WinSW อยู่แล้ว | **คง ngrok** — ดู checklist ด้านบน |
| มี domain + public IP | Caddy (`deploy/Caddyfile`) |
| lab / VPS | Docker (`deploy/docker/README.md`) |

**ผมแนะนำ:** ร้านที่ใช้ ngrok อยู่แล้ว → **ไม่ต้องเปลี่ยนเป็น Docker/Caddy** จนกว่าจะมี domain จริง

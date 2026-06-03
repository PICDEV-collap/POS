# POS_V2 — Production Deployment Guide

ใช้ runbook นี้เมื่อจะ deploy บน Windows 11 server จริง

สำหรับ Raspberry Pi / ร้านสาขาใหม่แบบติดตั้งครั้งเดียว ดู `deploy/raspberry-pi/README.md`

## สิ่งที่ต้องเตรียม

| Item | Why |
|------|-----|
| Static IP (LAN) | ให้ client + เครื่องพิมพ์ Thermal หาเซิร์ฟเวอร์เจอตลอด |
| Domain (optional) | ใช้ HTTPS ผ่าน Let's Encrypt |
| Caddy | Reverse proxy + auto-TLS |
| nssm หรือ pm2-windows-service | รัน Node.js เป็น Windows service |
| Windows Firewall ports 80/443/4000/3000/5353 udp | ดู `firewall-allow.ps1` |

## ขั้นตอน

### 1. ตั้ง Static IP บน Windows Server
```
Network Settings → Change adapter options → IPv4 → Use the following IP address
ตัวอย่าง: 192.168.1.10 / 255.255.255.0 / Gateway 192.168.1.1
```

### 2. แก้ `.env` สำหรับ production

```bash
cd backend
cp .env.example .env
```

แก้ค่าสำคัญ:
- `JWT_SECRET=` เปลี่ยนเป็น random string ยาว ≥32 (ใช้ `openssl rand -hex 32`)
- `PGPASSWORD=` ตั้งรหัสที่แข็งแรง (ไม่ใช่ default)
- `CORS_ORIGINS=https://your-domain.com`  (เฉพาะ origin จริง)
- `PRINTER_HOST=192.168.1.50` (ตั้ง static IP ให้เครื่องพิมพ์ด้วย)
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` รัน
  `node -e "console.log(require('web-push').generateVAPIDKeys())"`
  แล้วใส่ค่าใหม่ (อย่าใช้ค่า dev ที่อยู่ในรีโป)

### 3. Build customer-web

```bash
cd customer-web
npm ci
npm run build           # สร้าง .next/
```

### 4. เปิด firewall ports

```powershell
cd deploy
.\firewall-allow.ps1    # เปิด 80, 443, 4000, 3000, 5353/udp
```

### 5. ติดตั้ง services

วิธี A — **nssm** (แนะนำสำหรับ Windows server เดี่ยว):
```cmd
deploy\install-windows-service.bat
```

วิธี B — **pm2** (ถ้าทีมคุ้น Node.js):
```bash
npm install -g pm2 pm2-windows-service
pm2 start deploy/ecosystem.config.js --env production
pm2 save
pm2-service-install -n PM2          # เปิด auto-start ที่ boot
```

### 6. Reverse proxy + HTTPS ผ่าน Caddy

ดาวน์โหลด Caddy: https://caddyserver.com/download

```cmd
copy deploy\Caddyfile C:\caddy\
cd C:\caddy
caddy run --config Caddyfile
```

ถ้าไม่มี domain ให้ใช้ `tls internal` (Caddy สร้าง CA self-signed + ใส่ใน Windows trust store)
ดู comment block ในไฟล์ `Caddyfile`

ติดตั้ง Caddy เป็น service:
```cmd
nssm install Caddy "C:\caddy\caddy.exe" "run --config C:\caddy\Caddyfile"
```

### 7. ตั้ง static IP ของเครื่องพิมพ์ Thermal

A70Pro (ส่วนใหญ่) ตั้งจากเมนูบนตัวเครื่องหรือผ่าน utility เช่น POS-tool
แนะนำใช้ **DHCP reservation** บน router แทน — IP คงที่ + ไม่ต้องตั้งบนตัวเครื่อง

### 8. ทดสอบครบ

```bash
curl https://your-domain.com/api/health        # 200 ok
curl https://your-domain.com/api/discovery/info
```

เปิดใน browser:
- Customer:  `https://your-domain.com/order?t=<qr_token>`
- Staff:     `https://your-domain.com/staff`
- Kitchen:   `https://your-domain.com/kitchen` → กด 🔕 เพื่อ subscribe push
- Admin:     `https://your-domain.com/admin`

## Backup & migration

Database backup รายวัน:
```cmd
"C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U postgres -h 127.0.0.1 -F c pos_v2 > C:\backup\pos_v2_%date:~-4%%date:~3,2%%date:~0,2%.dump
```

Restore:
```cmd
pg_restore -U postgres -d pos_v2 -c pos_v2_20260101.dump
```

Backup ส่วนรูปเมนู:
```cmd
robocopy backend\uploads C:\backup\uploads /MIR /R:3
```

## Health checks

- `GET /api/health` → `{ok:true, ts}` (no DB)
- `GET /api/discovery/info` → version + IP addresses
- `GET /api/print/config` (auth) → printer state
- `GET /api/print/jobs?status=failed` (auth) → failed prints to retry

## Logs (default paths after install-windows-service.bat)

```
backend/logs/out.log
backend/logs/err.log
customer-web/logs/out.log
customer-web/logs/err.log
C:\caddy\logs\access.log
```

## Common issues

| Symptom | Fix |
|---------|-----|
| Browsers won't accept push notifications | Web Push **requires HTTPS** (or `localhost`). Set up Caddy first. |
| Mobile Android can't see server | ตรวจ same SSID + open UDP 5353 + LAN routing บน router |
| สั่งพิมพ์แล้ว `failed` `connect ECONNREFUSED` | เครื่องพิมพ์ไม่อยู่หรือ IP เปลี่ยน — ใช้ DHCP reservation |
| Caddy ไม่ออก cert | ตรวจ DNS ชี้มาที่ server, port 80/443 เปิด, รัน `caddy run` ดู log |
| Service crash loop | ตรวจ `backend/logs/err.log` — มักเป็น DB password / VAPID key หาย |

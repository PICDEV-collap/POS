# POS_V2 — คู่มือติดตั้งระบบครบวงจร (ตั้งแต่ต้นจนใช้งานได้)

อ่านครั้งเดียวจบ ไล่ตามขั้นตอนได้เลย ใช้สำหรับ deploy บน Windows 11 / Server 2022 ในร้านอาหารจริง

> **สำหรับ dev/staging แบบเร็ว** — อ่านแค่ Part 1 + Part 2 ก็พอ
> **สำหรับ production** — ทำครบทุก Part ตามลำดับ

---

## 📋 สารบัญ

1. [เตรียมเครื่อง + เครือข่าย](#1-เตรียมเครื่อง--เครือข่าย)
2. [ติดตั้งซอฟต์แวร์พื้นฐาน](#2-ติดตั้งซอฟต์แวร์พื้นฐาน)
3. [ตั้งค่า PostgreSQL](#3-ตั้งค่า-postgresql)
4. [ติดตั้ง POS_V2 (โค้ด)](#4-ติดตั้ง-pos_v2-โค้ด)
5. [Hardening — rotate secrets + create admin](#5-hardening--rotate-secrets--create-admin)
6. [Build customer-web (production)](#6-build-customer-web-production)
7. [ติดตั้ง Caddy + เปิด HTTPS](#7-ติดตั้ง-caddy--เปิด-https)
8. [ติดตั้งเป็น Windows Services (auto-start)](#8-ติดตั้งเป็น-windows-services)
9. [ตั้งค่าเครื่องพิมพ์ Thermal A70Pro](#9-ตั้งค่าเครื่องพิมพ์-thermal-a70pro)
10. [Build & install Mobile APK](#10-build--install-mobile-apk)
11. [ทดสอบ end-to-end](#11-ทดสอบ-end-to-end)
12. [Backup + Maintenance](#12-backup--maintenance)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. เตรียมเครื่อง + เครือข่าย

### Spec ขั้นต่ำ
- Windows 10/11 64-bit หรือ Windows Server 2019/2022
- 8 GB RAM (16 GB แนะนำ ถ้ารัน Android emulator ด้วย)
- 30 GB disk ว่าง (ส่วน Android emulator ต้องเพิ่ม ~10-15 GB)
- Network LAN พร้อม WiFi access point

### ตั้ง Static IP บน Windows server
1. **Settings → Network → ตัว adapter ที่ใช้ → Edit IP assignment → Manual**
2. ตั้ง:
   - IPv4: `192.168.1.10` (เลือกตามวง LAN)
   - Subnet: `255.255.255.0`
   - Gateway: `192.168.1.1`
   - DNS: `1.1.1.1` หรือของ ISP
3. ตรวจ: เปิด cmd แล้ว `ipconfig` ต้องเห็น IP ที่ตั้งไว้

### ตั้ง DHCP reservation บน router
- Router → DHCP → Address Reservation
- เพิ่ม MAC address ของ Server + IP ที่ตั้งไว้
- ทำเหมือนกันให้ **เครื่องพิมพ์ Thermal** ด้วย — ใช้ IP คงที่

---

## 2. ติดตั้งซอฟต์แวร์พื้นฐาน

### 2.1 Node.js LTS (จำเป็น)
- โหลด **Node.js 22 LTS** จาก https://nodejs.org/
- ติดตั้งแบบ default (จะมี npm ติดมาด้วย)
- ตรวจ: เปิด cmd ใหม่ → `node -v` (ควรเห็น `v22.x`)

### 2.2 PostgreSQL 14+ (จำเป็น)
- โหลด **PostgreSQL 18** Windows installer จาก https://www.postgresql.org/download/windows/
- ขั้นตอน install:
  - Components: ติ๊ก **PostgreSQL Server**, **pgAdmin 4**, **Command Line Tools**
  - **ตั้งรหัสผ่าน superuser** (`postgres`) — **จดไว้!** (จะต้อง rotate ทีหลัง)
  - Port: **5432** (default)
  - Locale: `Thai, Thailand` หรือ `Default`
- ตรวจ: `services.msc` ดูว่ามี service `postgresql-x64-18` Running

### 2.3 Git (แนะนำ)
- โหลดจาก https://git-scm.com/download/win
- ใช้ default options ทุกอย่าง (รวม Git Bash + add to PATH)
- จำเป็นถ้าจะ clone source / pull update / build Flutter

### 2.4 PowerShell 7+ (แนะนำ)
- Windows 11 มี PowerShell 5.1 ติดมาแล้ว ใช้ได้
- หรือโหลด PowerShell 7 จาก Microsoft Store

---

## 3. ตั้งค่า PostgreSQL

### 3.1 สร้าง database

เปิด **SQL Shell (psql)** จาก Start Menu (จะถาม password ที่ตั้งใน 2.2)

```sql
CREATE DATABASE pos_v2 ENCODING 'UTF8' TEMPLATE template0;
\l                                  -- ตรวจว่ามี pos_v2 แล้ว
\q
```

### 3.2 (ถ้าใช้ command line) ใช้คำสั่งนี้แทน

```cmd
"C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres -E UTF8 -T template0 pos_v2
```

### 3.3 (สำหรับ production) จำกัดให้ฟัง localhost เท่านั้น

แก้ `C:\Program Files\PostgreSQL\18\data\postgresql.conf`:
```
listen_addresses = '127.0.0.1'        # เปลี่ยนจาก '*'
```

แล้ว restart service:
```powershell
Restart-Service postgresql-x64-18
```

---

## 4. ติดตั้ง POS_V2 (โค้ด)

### 4.1 หา/clone โค้ด

ถ้ามี source อยู่ใน `D:\POS_V2\` — ข้ามไป 4.2

ถ้า clone:
```cmd
cd D:\
git clone <repo-url> POS_V2
```

> ⚠️ **ระวังวงเล็บใน path** — Gradle ของ Android ไม่รองรับ path ที่มี `()` ให้ใช้ root มาตรฐาน `D:\POS_V2` เท่านั้น และไม่ต้องใช้ mapped drive

### 4.2 ติดตั้ง dependencies

```cmd
cd D:\POS_V2\backend
npm install

cd ..\customer-web
npm install
```

### 4.3 สร้าง `.env` ของ backend

```cmd
cd ..\backend
copy .env.example .env
notepad .env
```

ค่าต่ำสุดที่ต้องตั้ง:
```ini
PORT=4000
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
PGPASSWORD=<รหัสที่ตั้งตอนติดตั้ง PostgreSQL>
PGDATABASE=pos_v2

# CORS — ปล่อยเป็น dev ก่อน, จะแก้ตอน Caddy
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001

# Printer (ตั้งภายหลังใน Part 9)
PRINTER_HOST=
PRINTER_ENABLED=true
```

### 4.4 สร้าง schema + seed (dev mode)

```cmd
npm run db:reset
```

จะเห็น output:
```
Schema applied.
Creating dev users (bcrypt cost 12)...
  - admin / admin123  (role=admin)
  - staff1 / staff123  (role=staff)
  - kitchen / kitchen123  (role=kitchen)

QR tokens for tables:
  A1: <random-hex-32>
  A2: <random-hex-32>
  ...
```

**จด QR tokens ไว้** — ต้องใช้ทำ QR สำหรับโต๊ะ

### 4.5 ทดสอบรัน dev mode

```cmd
npm run dev
```

ควรเห็น:
```
POS_V2 backend listening on 0.0.0.0:4000
[printer] worker started
[mDNS] advertising _pos_v2._tcp on port 4000 as "POS V2 — <hostname>"
```

เปิดอีก cmd:
```cmd
curl http://localhost:4000/api/health
```
ต้องได้ `{"ok":true,...}`

หยุด backend (Ctrl+C) ก่อนไป Part 5

---

## 5. Hardening — rotate secrets + create admin

> ⚠️ **ห้ามข้าม** ถ้าจะใช้งานจริง — secrets ใน `.env.example` และ user `admin/admin123` ถูกถือว่า leak ทั้งหมด

### 5.1 Generate secrets ใหม่

```cmd
cd D:\POS_V2\backend
npm run rotate-secrets > .env.new
```

เปิด `.env.new` ดูค่าที่ generate ออกมา **copy ไปแทนใน `.env`**:
- `JWT_SECRET=...` (64-byte hex)
- `JWT_EXPIRES_IN=2h`
- `VAPID_SUBJECT=mailto:admin@your-domain.com`
- `VAPID_PUBLIC_KEY=...`
- `VAPID_PRIVATE_KEY=...`
- `PGPASSWORD=<ค่าใหม่ที่ suggest>` — เอาไป apply กับ Postgres ก่อน

### 5.2 Apply Postgres password ใหม่

```cmd
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h 127.0.0.1
ALTER USER postgres WITH PASSWORD '<ค่าใหม่จาก rotate-secrets>';
\q
```

แล้ว update `PGPASSWORD=` ใน `.env`

### 5.3 ลบ dev users + สร้าง admin จริง

```cmd
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h 127.0.0.1 -d pos_v2 ^
  -c "DELETE FROM users WHERE username IN ('admin','staff1','kitchen');"

set NODE_ENV=production
npm run create-admin -- admin "MySuperSecret#2026" "Administrator"
```

### 5.4 ลบ `.env.new`

```cmd
del .env.new
```

⚠️ ห้าม commit `.env` หรือ `.env.new` เข้า git!

---

## 6. Build customer-web (production)

```cmd
cd D:\POS_V2\customer-web
copy .env.example .env.local
notepad .env.local
```

ตั้ง:
```ini
NEXT_PUBLIC_API_BASE=        # ปล่อยว่าง — ใช้ same-origin ผ่าน Caddy
BACKEND_INTERNAL_URL=http://127.0.0.1:4000
```

Build:
```cmd
npm run build
```

ใช้เวลา ~30-60 วินาที — ผลลัพธ์อยู่ที่ `.next/` folder

---

## 7. ติดตั้ง Caddy + เปิด HTTPS

### 7.1 โหลด Caddy

- ไปที่ https://caddyserver.com/download
- เลือก platform = `windows/amd64`
- ติ๊ก plugins ที่ต้องการ (default ก็พอ)
- ดาวน์โหลด `caddy.exe`

วางไว้ที่ `C:\caddy\caddy.exe`

### 7.2 Copy Caddyfile

```cmd
mkdir C:\caddy\logs
copy D:\POS_V2\deploy\Caddyfile C:\caddy\Caddyfile
notepad C:\caddy\Caddyfile
```

แก้ `your-domain.com` เป็นโดเมนจริงของคุณ — เช่น `pos.myrestaurant.com`
ต้อง point DNS A record มาที่ public IP ของ server แล้ว

ถ้า **ไม่มี domain** ใช้ block `tls internal` (เปิด comment ในไฟล์) — Caddy จะออก self-signed cert ให้ใช้ใน LAN ได้

### 7.3 ทดสอบ Caddy

เปิด admin cmd:
```cmd
cd C:\caddy
caddy run --config Caddyfile
```

ครั้งแรก Caddy จะ:
1. ขอ Let's Encrypt cert (ถ้ามี domain) — ใช้ ~30 วินาที
2. แสดง log "Server running"

ทดสอบจาก browser: `https://your-domain.com/api/health` → `{"ok":true,...}`

หยุด Caddy (Ctrl+C) ก่อนไป Part 8

### 7.4 ตั้งให้ Caddy รันเป็น service (ดู Part 8)

---

## 8. ติดตั้งเป็น Windows Services

ใช้ **WinSW** (อยู่ใน `D:\dev-tools\winsw\WinSW.exe` แล้ว) หรือ **NSSM**

### 8.1 ติดตั้ง backend + web เป็น service

ผมเตรียม config ไว้แล้วใน `D:\POS_V2\deploy\services\`:

```
services/
├── pos-v2-backend.exe       (WinSW renamed)
├── pos-v2-backend.xml       (config — ต้องแก้ workingdirectory ถ้า project อยู่ path อื่น)
├── pos-v2-web.exe
├── pos-v2-web.xml
├── install-services-quiet.bat   (auto)
└── install-services.bat         (interactive — มี pause)
```

**Run as Administrator:**
1. คลิกขวา `install-services-quiet.bat` → **Run as administrator** → กด Yes
2. รอ ~5 วินาที → เปิด `install.log` ดู — ต้องเห็น `STATE : 4 RUNNING` ทั้งสอง service
3. ตรวจ:
   ```cmd
   sc query pos-v2-backend
   sc query pos-v2-web
   ```
   ต้องเห็น `STATE : 4 RUNNING`

### 8.2 ติดตั้ง Caddy เป็น service

```cmd
D:\POS_V2\deploy\services\pos-v2-backend.exe install
```

หรือใช้ caddy-built-in (Caddy 2.7+):
```cmd
sc create caddy binPath= "\"C:\caddy\caddy.exe\" run --config C:\caddy\Caddyfile" start= auto
sc start caddy
```

### 8.3 เปิด firewall

```powershell
cd D:\POS_V2\deploy
powershell -ExecutionPolicy Bypass -File .\firewall-allow.ps1
```

(ต้องเปิด PowerShell แบบ Run as Administrator)

### 8.4 (Production) ปิด port 4000 + 3000 จากภายนอก

หลังจากตั้ง Caddy แล้ว — backend (4000) และ web (3000) ไม่ควรเข้าถึงจากเครือข่ายภายนอก ใช้ Caddy proxy ผ่าน 443 เท่านั้น

แก้ใน `backend/.env`:
```ini
NODE_ENV=production
LISTEN_HOST=127.0.0.1       # bind localhost only
```

แก้ใน `customer-web/.env.local`:
```ini
NEXT_PUBLIC_API_BASE=       # same-origin
BACKEND_INTERNAL_URL=http://127.0.0.1:4000
```

แล้ว restart 2 services:
```cmd
sc stop pos-v2-backend && sc start pos-v2-backend
sc stop pos-v2-web && sc start pos-v2-web
```

---

## 9. ตั้งค่าเครื่องพิมพ์ Thermal A70Pro

### 9.1 ตั้ง static IP ให้เครื่องพิมพ์

ทาง LAN — ใช้ DHCP reservation บน router (แนะนำ) หรือเข้าหน้า config ของ printer ผ่าน utility

ตั้ง IP เช่น `192.168.1.50` พอร์ต `9100` (ESC/POS standard)

### 9.2 ตั้งค่าใน backend

แก้ `backend/.env`:
```ini
PRINTER_ENABLED=true
PRINTER_HOST=192.168.1.50
PRINTER_PORT=9100
PRINTER_TIMEOUT_MS=3000
PRINTER_THAI_CP=21              # TIS-620 / Thai code page
PRINTER_WIDTH_CHARS=42          # 58mm = 32, 80mm = 42-48

# ถ้าภาษาไทยพิมพ์เพี้ยน (สระลอย) ใช้ image mode:
# PRINTER_RENDER_MODE=image
# PRINTER_WIDTH_PX=384           # 384=58mm, 576=80mm
# PRINTER_FONT_PATH=             # default ใช้ C:/Windows/Fonts/tahoma.ttf
```

Restart backend service:
```cmd
sc stop pos-v2-backend && sc start pos-v2-backend
```

### 9.3 ทดสอบพิมพ์

```cmd
:: get admin token
curl -s -X POST -H "Content-Type: application/json" ^
  -d "{\"username\":\"admin\",\"password\":\"<your-password>\"}" ^
  https://your-domain.com/api/auth/login

:: ใช้ token จาก response → ส่ง test print
curl -X POST -H "Authorization: Bearer <token>" ^
  https://your-domain.com/api/print/test
```

ดูที่เครื่องพิมพ์ — ถ้ามี slip ออกมา = OK

หรือใช้ admin web: `https://your-domain.com/admin` → tab **🖨️ เครื่องพิมพ์** → กด "ทดสอบพิมพ์"

---

## 10. Build & install Mobile APK

> รายละเอียดเพิ่มเติม: `mobile/ANDROID.md`

### 10.1 ติดตั้ง Flutter SDK (ครั้งแรก)

```cmd
cd D:\
git clone --depth 1 -b stable https://github.com/flutter/flutter.git flutter
setx PATH "%PATH%;D:\flutter\bin"
```

เปิด cmd ใหม่ — `flutter doctor`
ขั้นต่ำต้องมี:
- ✅ Flutter
- ✅ Android toolchain (Android Studio installed + licenses accepted: `flutter doctor --android-licenses`)
- ✅ Connected device (emulator หรือมือถือจริง)

### 10.2 ใช้ path มาตรฐานสำหรับ Android build

โปรเจค production ต้องอยู่ที่ `D:\POS_V2` และ build mobile จาก `D:\POS_V2\mobile` โดยตรง ห้ามใช้ mapped drive และห้าม build จาก path ที่มีวงเล็บ

### 10.3 Build release APK

```cmd
cd D:\POS_V2\mobile
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
flutter build apk --release --dart-define=POS_API_BASE=https://your-domain.com
```

ใช้เวลา 2-5 นาที APK จะอยู่ที่:
```
D:\POS_V2\mobile\build\app\outputs\flutter-apk\app-release.apk
```

หลัง build ให้คัดลอกไปชื่อ install-safe สำหรับส่งให้มือถือ:
```cmd
copy /Y D:\POS_V2\mobile\build\app\outputs\flutter-apk\app-release.apk D:\POS_V2\deploy\mobile\POS_V2_Mobile_Latest.apk
```

### 10.4 Install บนมือถือ

**ทาง USB:**
```cmd
adb install -r D:\POS_V2\deploy\mobile\POS_V2_Mobile_Latest.apk
```

**ทาง file copy:**
- Copy `POS_V2_Mobile_Latest.apk` ผ่าน USB / Drive / LINE
- มือถือ Settings → Privacy → Install unknown apps → allow ตัว file manager
- แตะไฟล์ → Install

---

## 11. ทดสอบ end-to-end

### 11.1 Customer flow
1. หา QR token ของโต๊ะจาก admin web → tab **🪑 โต๊ะ** หรือจาก output ของ `db:reset`
2. ใช้มือถือ scan QR (หรือเปิด `https://your-domain.com/order?t=<token>`)
3. ดูเมนู → เพิ่มลงตะกร้า → ยืนยันออเดอร์
4. ควรเห็นหน้า "ออเดอร์ #N · status: รอยืนยัน"

### 11.2 Kitchen flow
1. เข้า `https://your-domain.com/login` ด้วย kitchen / <password>
2. หน้า **/kitchen** ควรเห็น order ที่ลูกค้าเพิ่งสั่ง
3. กดปุ่มเปลี่ยนสถานะ: รอยืนยัน → กำลังทำ → เสิร์ฟแล้ว
4. ปุ่ม 🖨️ ส่งใบสั่งครัวไปเครื่องพิมพ์ (ถ้าตั้งใน Part 9)

### 11.3 Staff flow
1. Login ด้วย staff1 / <password>
2. หน้า **/staff** — เลือกโต๊ะจาก sidebar → สั่งของแทนลูกค้า → กดชำระ + พิมพ์ใบเสร็จ

### 11.4 Mobile app
1. เปิดแอป POS V2 → Login เป็น kitchen
2. ดูออเดอร์ (offline cache + realtime ผ่าน Socket.io)
3. ปิด WiFi มือถือ → status เปลี่ยนเป็น `🔴 offline` → กดเปลี่ยนสถานะยังได้ (queue)
4. เปิด WiFi → sync อัตโนมัติ

---

## 12. Backup + Maintenance

### 12.1 Daily DB backup (Task Scheduler)

สร้างไฟล์ `D:\backup\backup-pos-v2.bat`:
```bat
@echo off
set PGPASSWORD=<your-pg-password>
set BACKUP_DIR=D:\backup\pos_v2
mkdir %BACKUP_DIR% 2>nul
set STAMP=%DATE:~-4%%DATE:~3,2%%DATE:~0,2%-%TIME:~0,2%%TIME:~3,2%
set STAMP=%STAMP: =0%
"C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U postgres -h 127.0.0.1 -F c pos_v2 ^
  > "%BACKUP_DIR%\pos_v2-%STAMP%.dump"

REM keep last 30 days
forfiles /p "%BACKUP_DIR%" /m *.dump /d -30 /c "cmd /c del @path" 2>nul

REM backup uploaded images
robocopy "D:\POS_V2\backend\uploads" "%BACKUP_DIR%\uploads" /MIR /R:3 /NP /LOG+:%BACKUP_DIR%\rsync.log
```

ตั้ง Task Scheduler:
```cmd
schtasks /create /tn "POS V2 daily backup" /tr "D:\backup\backup-pos-v2.bat" /sc daily /st 03:00
```

### 12.2 Restore จาก backup

```cmd
"C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -U postgres -h 127.0.0.1 -d pos_v2 -c D:\backup\pos_v2\pos_v2-20260101.dump
```

### 12.3 Update โค้ด

```cmd
cd D:\POS_V2
git pull
cd backend && npm install
cd ..\customer-web && npm install && npm run build
sc stop pos-v2-backend && sc start pos-v2-backend
sc stop pos-v2-web && sc start pos-v2-web
```

### 12.4 Log location

```
D:\POS_V2\backend\logs\         (WinSW logs of backend)
D:\POS_V2\customer-web\logs\    (WinSW logs of web)
C:\caddy\logs\access.log                 (Caddy HTTP logs)
```

---

## 13. Troubleshooting

| อาการ | วิธีแก้ |
|------|--------|
| Browser → "ERR_CONNECTION_REFUSED" | ตรวจ service running: `sc query pos-v2-backend`; ตรวจ firewall เปิด 443 |
| Login → "too many login attempts" | rate limit ทำงาน — รอ 10 นาทีหรือ login จาก IP อื่น |
| Login → "invalid credentials" | password เปลี่ยนตอน rotate-secrets — ใช้ค่าจาก `create-admin` ไม่ใช่ `admin123` |
| Admin web ไม่เห็น QR token ใหม่ | go to **Tables tab → กดปุ่ม 🔄 QR** เพื่อ rotate token |
| Print job → "ECONNREFUSED" | เครื่องพิมพ์ไม่ตอบ — ตรวจ IP, network, ลอง ping จาก server |
| ภาษาไทยพิมพ์เพี้ยน (สระลอย) | เปลี่ยน `PRINTER_RENDER_MODE=image` ใน .env แล้ว restart backend |
| Mobile (emulator) → connection refused | ใช้ `10.0.2.2:4000` ไม่ใช่ `localhost:4000` |
| Mobile (real device) → timeout | ตรวจมือถือ + server อยู่ subnet เดียวกัน + firewall เปิด port |
| Mobile → "isn't responding" บน debug | debug build ช้าบน emulator — ใช้ release APK แทน |
| Caddy → "no certificate" | ตรวจ DNS A record ชี้มาที่ server, port 80/443 เปิด, ไม่มี service อื่นใช้พอร์ต |
| `sc start pos-v2-backend` → "service did not respond in timely fashion" | ดู log ที่ `backend\logs\` มักเป็น `.env` ผิดหรือ DB password เปลี่ยน |
| Push notification ไม่ทำงานบน mobile | Web Push **ไม่ได้** ใช้ใน APK — ใช้ได้แค่ web. APK ต้องใช้ FCM (ยังไม่ implement) |
| `npm install` → permission denied บน Windows | เปิด cmd แบบ admin หรือ `npm config set fund false; npm install --no-audit` |
| schema เก่า | `npm run db:reset` (⚠️ จะลบข้อมูล) หรือ apply migration ทีละ table |

### Diagnostic checklist เมื่อระบบล่ม

```cmd
:: 1. service status
sc query pos-v2-backend
sc query pos-v2-web
sc query caddy

:: 2. ports listening
netstat -an | findstr ":4000 :3000 :443 :80"

:: 3. backend health
curl https://your-domain.com/api/health

:: 4. recent backend log
powershell -Command "Get-Content -Tail 50 'D:\POS_V2\backend\logs\out.log'"

:: 5. recent error log
powershell -Command "Get-Content -Tail 50 'D:\POS_V2\backend\logs\err.log'"

:: 6. DB connection test
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h 127.0.0.1 -d pos_v2 -c "SELECT 1"
```

---

## 📚 อ่านต่อ

- [`SECURITY.md`](./SECURITY.md) — checklist hardening + Phase B/C
- [`README.md`](./README.md) — runbook สั้น (Caddy + nssm)
- [`../mobile/ANDROID.md`](../mobile/ANDROID.md) — รายละเอียด build mobile
- [`../README.md`](../README.md) — ภาพรวมโปรเจกต์ + endpoints

## 📞 Support

- API health: `GET /api/health`
- Service info: `GET /api/discovery/info`
- Print queue status: ใน admin web → tab **📑 คิวพิมพ์**
- Server status: `sc query pos-v2-backend / pos-v2-web / caddy`


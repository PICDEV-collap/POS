# POS V2 DEV Runbook

เอกสารนี้ใช้สำหรับ DEV / support engineer เมื่อระบบ POS V2 มีปัญหาหน้างาน โดยเน้น production-safe recovery, ไม่ rewrite ระบบ, ไม่เปลี่ยน business logic โดยไม่จำเป็น และต้องกัน duplicate print เป็นหลัก

## 1. System Overview

### Components

- Web admin / customer / staff: Next.js ที่ `http://localhost:3000`
- Backend API: Node.js ที่ `http://localhost:4000`
- Realtime: Socket.IO บน backend เดียวกัน
- Database: PostgreSQL database `pos_v2`
- Mobile app: Flutter Android APK
- Printer:
  - Mobile BLE printer: มือถือส่ง payload ไปเครื่องพิมพ์โดยตรง
  - Server TCP printer: backend ส่ง raw TCP ไป `PRINTER_HOST:PRINTER_PORT`

### Single Owner Rule For Printing

ระบบต้องมีเจ้าของ auto print เพียงทางเดียวต่อร้าน

- ถ้าใช้มือถือ BLE เป็นเครื่องพิมพ์หลัก:
  - `backend/.env` ต้องมี `SERVER_AUTO_PRINT_ENABLED=false`
  - `restaurant_settings.auto_print_kitchen=false`
  - `restaurant_settings.auto_print_receipt=false`
  - เปิด auto print ในหน้า BLE settings ของ mobile เท่านั้น
- ถ้าใช้เครื่องพิมพ์ TCP/LAN ที่ server:
  - ตั้ง `PRINTER_HOST` เป็น IP เครื่องพิมพ์จริง ห้ามใช้ `127.0.0.1` ถ้าไม่มี print daemon
  - ตั้ง `SERVER_AUTO_PRINT_ENABLED=true`
  - เปิด `restaurant_settings.auto_print_*` ตามต้องการ
  - ปิด auto print ใน mobile BLE เพื่อกันพิมพ์ซ้ำ

## 2. Standard Paths

```powershell
D:\POS_V2
D:\POS_V2\backend
D:\POS_V2\customer-web
D:\POS_V2\mobile
D:\POS_V2\deploy\mobile
D:\POS_V2\backend\logs
```

หมายเหตุ: Flutter build ต้องรันจาก `D:\POS_V2\mobile` โดยตรง ห้ามใช้ mapped drive หรือ path ที่มีวงเล็บ เพื่อกัน Gradle/Android toolchain error

## 3. Service Health Check

### Check running processes

```powershell
Get-Process node | Select-Object Id,ProcessName,StartTime,Path
```

### Check backend discovery

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/api/discovery/info"
```

### Check web

```powershell
Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing
```

### Check printer config through API

```powershell
$s = Invoke-RestMethod -Method Post -Uri "http://localhost:4000/api/auth/staff-session"
$h = @{ Authorization = "Bearer $($s.token)" }
Invoke-RestMethod -Headers $h -Uri "http://localhost:4000/api/print/config"
```

## 4. Restart Procedures

### Restart backend

```powershell
Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }

Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
  -ArgumentList @("src\server.js") `
  -WorkingDirectory "D:\POS_V2\backend" `
  -WindowStyle Hidden `
  -PassThru
```

### Restart web

```powershell
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }

Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
  -ArgumentList @("node_modules\next\dist\bin\next","start","-p","3000") `
  -WorkingDirectory "D:\POS_V2\customer-web" `
  -WindowStyle Hidden `
  -PassThru
```

## 5. Mobile Build And Deploy

### Analyze

```powershell
flutter analyze
```

Known existing warnings may exist in older screens. Build must not fail.

### Build production APK

```powershell
flutter build apk --release --dart-define=POS_API_BASE=http://192.168.1.163:4000
```

### Copy to deploy folder

```powershell
Copy-Item -LiteralPath "D:\POS_V2\mobile\build\app\outputs\flutter-apk\app-release.apk" `
  -Destination "D:\POS_V2\deploy\mobile\pos_v2_mobile_YYYYMMDD.apk" `
  -Force

Get-FileHash -Algorithm SHA256 "D:\POS_V2\deploy\mobile\pos_v2_mobile_YYYYMMDD.apk"
```

## 6. Database Operations

Use Node from backend folder when `psql` is not installed.

### Query printer settings and queue

```powershell
node -e "require('dotenv').config(); const db=require('./src/db'); (async()=>{ const s=await db.query('select id,name,auto_print_kitchen,auto_print_receipt from restaurant_settings where id=1'); const j=await db.query('select status,count(*)::int from print_jobs group by status order by status'); console.log(JSON.stringify({settings:s.rows,jobs:j.rows},null,2)); process.exit(0); })().catch(e=>{ console.error(e); process.exit(1); });"
```

### Disable server-side auto print for BLE-owned stores

```powershell
node -e "require('dotenv').config(); const db=require('./src/db'); (async()=>{ const r=await db.query('update restaurant_settings set auto_print_kitchen=false, auto_print_receipt=false, updated_at=now() where id=1 returning auto_print_kitchen,auto_print_receipt'); console.log(JSON.stringify(r.rows[0],null,2)); process.exit(0); })().catch(e=>{ console.error(e); process.exit(1); });"
```

### Check recent failed jobs

```powershell
node -e "require('dotenv').config(); const db=require('./src/db'); (async()=>{ const r=await db.query('select id,type,order_id,status,attempts,last_error_code,error,printer_host,printer_port,created_at from print_jobs order by id desc limit 20'); console.log(JSON.stringify(r.rows,null,2)); process.exit(0); })().catch(e=>{ console.error(e); process.exit(1); });"
```

## 7. Printing Incident Guide

### Symptom: prints duplicate kitchen and receipt tickets

Likely causes:

- Both mobile BLE auto print and server-side auto print are enabled
- Multiple mobile devices have auto print enabled
- Socket direct event and `realtime:event` both reached mobile handler
- Old APK is installed

Checks:

```powershell
node -e "require('dotenv').config(); const db=require('./src/db'); (async()=>{ const s=await db.query('select auto_print_kitchen,auto_print_receipt from restaurant_settings where id=1'); const j=await db.query('select id,type,order_id,status,last_error_code from print_jobs order by id desc limit 10'); console.log(JSON.stringify({settings:s.rows,jobs:j.rows},null,2)); process.exit(0); })().catch(e=>{ console.error(e); process.exit(1); });"
```

Fix:

- For BLE-owned store, keep `SERVER_AUTO_PRINT_ENABLED=false`
- Set DB `auto_print_kitchen=false`, `auto_print_receipt=false`
- Only one Android device should have BLE auto print enabled
- Install latest APK from `deploy\mobile`

### Symptom: printer outputs raw text such as SIZE, GAP, BITMAP, or unreadable command bytes

Likely causes:

- Printer is ESC/POS but app is sending TSPL
- BLE buffer overrun caused binary stream corruption
- Old APK sends `writeWithoutResponse` too aggressively

Fix:

- In mobile BLE settings choose `ESC/POS`
- Paper type should be `ต่อเนื่อง / continuous` for receipt rolls
- Use latest APK with BLE write lock and safe auto protocol
- Test manual BLE print before testing customer order auto print

### Symptom: last line disappears after cutting paper

Fix knobs:

- Backend bitmap bottom feed: `PRINTER_BITMAP_BOTTOM_FEED_PX`
- Backend ESC/POS feed lines: `PRINTER_FEED_LINES`
- Current production default:
  - `bottom_feed_px=256`
  - `feed_lines=12`
  - `raster_band_height=128`

Verify payload:

```powershell
$s = Invoke-RestMethod -Method Post -Uri "http://localhost:4000/api/auth/staff-session"
$h = @{ Authorization = "Bearer $($s.token)" }
Invoke-RestMethod -Headers $h -Uri "http://localhost:4000/api/print/payload/test?width_px=384&render_mode=image&protocol=escpos&paper_type=continuous"
```

### Symptom: payment QR does not show on receipt

Checks:

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/api/settings" |
  Select-Object payment_qr_enabled,payment_qr_type,payment_qr_id,payment_qr_account_name,payment_qr_include_amount
```

Fix:

- Admin web → เครื่องพิมพ์ → QR ชำระเงินบนใบเสร็จ
- `payment_qr_type=promptpay` for mobile/national ID/e-wallet PromptPay
- `payment_qr_type=merchant` for Thai QR merchant/biller ID such as `014000009395435`
- Keep `payment_qr_include_amount=true` when the QR should carry the order total

### Symptom: ECONNRESET / ECONNREFUSED on backend printer

Meaning:

- `ECONNREFUSED`: no printer service listening at `PRINTER_HOST:PRINTER_PORT`
- `ECONNRESET`: printer accepted connection then closed, often after accepting bytes

Fix:

- If using BLE mobile printing, disable server-side auto print
- If using TCP printer, set `PRINTER_HOST` to the printer IP, not `127.0.0.1`
- Confirm port `9100` is open:

```powershell
Test-NetConnection -ComputerName <PRINTER_IP> -Port 9100
```

## 8. WebSocket Incident Guide

### Expected behavior

- Backend emits persisted `realtime:event`
- Backend also emits legacy direct event for web/mobile compatibility
- Mobile dedupes both event paths before dispatching handlers
- Reconnect should replay missed events from `last_event_id`

### Symptoms

- New order does not appear: socket disconnected or replay table missing
- New order appears twice: duplicate direct + realtime event or multiple devices
- Auto print not firing: mobile not logged in, BLE auto toggle off, or socket not connected

### Mobile logs to look for

```text
[socket] duplicate skipped event=order:new source=legacy key=order:new:<id>
[auto-print] queued
[auto-print] payload ready
[auto-print] success
[ble-printer] sent bytes=...
```

## 9. Server Logs

### Backend stdout

```powershell
Get-Content "D:\POS_V2\backend\logs\out.log" -Tail 200
```

### Backend stderr

```powershell
Get-Content "D:\POS_V2\backend\logs\err.log" -Tail 200
```

Important scopes:

- `auto-print`
- `printer.queue`
- `printer.socket`
- `printer.health`
- `websocket.connection`
- `websocket.replay`
- `rate-limit`

## 10. Customer Order Flow Debug

1. Customer submits `POST /api/public/orders`
2. Backend creates order transactionally
3. Backend emits `order:new`
4. Web/mobile receives realtime event
5. Mobile auto print enqueues local job if:
   - logged in
   - BLE printer selected
   - auto print toggle enabled
6. Mobile fetches `/api/print/payload/order/:id`
7. Mobile writes binary chunks to BLE printer

Manual print uses the same payload endpoint. If manual print works but customer order fails, investigate:

- auto print toggle
- socket duplicate/replay path
- BLE write timing
- server-side auto print accidentally enabled
- whether latest APK is installed

## 11. Rollback Plan

### Backend rollback

- Restore previous changed files from backup/source control
- Restart backend
- Check `/api/discovery/info`

### Mobile rollback

- Install previous APK from `D:\POS_V2\deploy\mobile`
- Keep only one Android device with auto print enabled

### Print safety rollback

If print duplication happens during service:

1. Turn off mobile BLE auto print toggles
2. Set DB `auto_print_kitchen=false`, `auto_print_receipt=false`
3. Keep manual print only until root cause is confirmed

## 12. Production Checklist After Any Patch

- Backend syntax check:

```powershell
node --check src\routes\orders.js
node --check src\routes\print.js
```

- Flutter format:

```powershell
dart format lib
```

- Flutter analyze:

```powershell
flutter analyze
```

- Build APK:

```powershell
flutter build apk --release --dart-define=POS_API_BASE=http://192.168.1.163:4000
```

- Restart backend
- Verify `SERVER_AUTO_PRINT_ENABLED`
- Verify DB `restaurant_settings.auto_print_*`
- Test manual BLE print
- Test one customer QR order
- Confirm exactly one kitchen ticket and zero/one receipt ticket depending on mobile toggle


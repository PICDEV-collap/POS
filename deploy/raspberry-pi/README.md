# POS V2 Raspberry Pi Deploy

ชุดนี้ทำให้ Raspberry Pi เป็น local server สำหรับร้านใหม่ได้แบบติดตั้งครั้งเดียว:

- PostgreSQL database
- Node.js backend API + Socket.io realtime
- Next.js web/admin/kitchen/customer order
- Nginx reverse proxy สำหรับ `/api`, `/socket.io`, `/uploads`
- systemd services restart อัตโนมัติหลังไฟดับ/รีบูต
- daily database backup
- Thai thermal print dependencies
- production `.env` + generated secrets + initial admin

## Supported OS

- Raspberry Pi OS 64-bit หรือ 32-bit
- Debian/Ubuntu ARM64/ARMv7 ที่ใช้ `apt` และ `systemd`

## One-Click Install

บน Raspberry Pi ให้ clone หรือ copy โปรเจคนี้ลงเครื่อง แล้วรัน:

```bash
cd POS_V2
sudo bash deploy/raspberry-pi/install.sh
```

แบบไม่ถามค่า เหมาะกับทำ image/ติดตั้งร้านอื่น:

```bash
sudo POS_SHOP_NAME="ร้านตัวอย่าง" \
  POS_ADMIN_USER="admin" \
  POS_ADMIN_PASSWORD="CHANGE_THIS_STRONG_PASSWORD" \
  POS_PRINTER_HOST="192.168.1.50" \
  bash deploy/raspberry-pi/install.sh --non-interactive
```

ถ้าเครื่องพิมพ์ยังไม่ได้ตั้งค่า ให้ปล่อย `POS_PRINTER_HOST` ว่างไว้ ระบบจะติดตั้งสำเร็จแต่ข้ามการพิมพ์จริงจนกว่าจะใส่ IP ใน `/etc/pos-v2/backend.env`

## Installed Paths

- App: `/opt/pos-v2`
- Config/secrets: `/etc/pos-v2`
- Product uploads: `/var/lib/pos-v2/uploads`
- Logs: `/var/log/pos-v2`
- Backups: `/var/backups/pos-v2`

ไฟล์รหัส admin รอบแรกอยู่ที่:

```bash
sudo cat /etc/pos-v2/initial-admin.txt
```

## URLs After Install

ตัว installer จะแสดง LAN IP ตอนจบ เช่น:

- Web/Admin/Kitchen/Customer: `http://192.168.1.50`
- Backend สำหรับ mobile app: `http://192.168.1.50:4000`

เส้นทางสำคัญ:

- Admin login: `/login`
- Admin panel: `/admin`
- Kitchen: `/kitchen`
- Customer QR order: `/order?token=...`

## Service Commands

```bash
sudo systemctl status pos-v2-backend
sudo systemctl status pos-v2-web
sudo systemctl status nginx
sudo journalctl -u pos-v2-backend -f
sudo journalctl -u pos-v2-web -f
```

Restart:

```bash
sudo systemctl restart pos-v2-backend pos-v2-web nginx
```

Health check:

```bash
sudo /opt/pos-v2/deploy/raspberry-pi/scripts/healthcheck.sh
```

## Update Existing Pi Install

เมื่อมีโค้ดเวอร์ชันใหม่ ให้ copy/clone โปรเจคล่าสุดลง Pi แล้วรัน:

```bash
cd POS_V2
sudo bash deploy/raspberry-pi/scripts/update.sh
```

สคริปต์จะ sync โค้ดเข้า `/opt/pos-v2`, install dependencies, build web, run migrations, restart service และ health check

## Database Migration

Installer ใช้ migration runner เดิมของ backend:

```bash
cd /opt/pos-v2/backend
sudo -u posv2 npm run db:migrate
```

Migration เป็น idempotent และบันทึกไฟล์ที่ apply แล้วในตาราง `_migrations`

## Backup

ระบบตั้ง timer สำรองฐานข้อมูลทุกวันเวลา 03:15:

```bash
systemctl list-timers pos-v2-backup.timer
ls -lh /var/backups/pos-v2
```

สำรองเอง:

```bash
sudo systemctl start pos-v2-backup.service
```

## Printer Config

แก้ค่าใน:

```bash
sudo nano /etc/pos-v2/backend.env
sudo systemctl restart pos-v2-backend
```

ค่าหลัก:

```dotenv
PRINTER_ENABLED=true
PRINTER_HOST=192.168.1.50
PRINTER_PORT=9100
PRINTER_RENDER_MODE=image
PRINTER_WIDTH_PX=384
PRINTER_FONT_PATH=/usr/share/fonts/truetype/tlwg/Garuda.ttf
```

`PRINTER_RENDER_MODE=image` ถูกตั้งเป็นค่าเริ่มต้นบน Pi เพื่อกันปัญหาภาษาไทยบน thermal printer

## GPS / Wi-Fi Guard Note

ถ้าลูกค้าอยู่ใน Wi-Fi ร้าน ระบบสามารถใช้เงื่อนไข LAN/Wi-Fi ได้โดยไม่ต้องขอ GPS ตาม logic ปัจจุบันของ backend/mobile

ถ้าจะให้ลูกค้าสั่งผ่าน public internet และต้องใช้ GPS ใน browser ต้องใช้ HTTPS เช่น ngrok/Caddy/โดเมนจริง เพราะ browser ส่วนใหญ่ไม่อนุญาต geolocation บน HTTP ที่ไม่ใช่ localhost

## Production Checklist

- เปลี่ยนรหัส admin หลังติดตั้ง
- ตั้งค่า printer IP จริง
- ตั้งค่าเวลาเปิด-ปิดร้านใน admin
- ทดสอบ QR โต๊ะจริง 1 ใบ และ QR กลับบ้าน 1 ใบ
- ทดสอบ mobile app manual server เป็น `http://<pi-ip>:4000`
- ทดสอบปิดไฟ/รีบูต Pi แล้ว service กลับมาเอง
- ตรวจ backup ใน `/var/backups/pos-v2`

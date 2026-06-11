# POS_V2 Customer Web

Next.js (App Router) — หน้าเว็บสำหรับลูกค้าสแกน QR เพื่อสั่งอาหาร

## Setup

```bash
cp .env.example .env.local   # ตั้งค่า NEXT_PUBLIC_API_BASE หากไม่ได้ใช้ localhost:4000
npm install
npm run dev                  # http://localhost:3000
```

## หน้า

- `/` — landing
- `/order?t=<qr_token>` — เมนู + ตะกร้า + สั่งอาหาร
- `/order/status?t=<qr_token>&id=<order_id>` — ดูสถานะออเดอร์ (poll ทุก 5 วินาที)

`<qr_token>` ดูได้จาก output ของ `npm run db:reset` ในฝั่ง backend

# POS V2 — Docker Deployment

รัน POS V2 แบบ container สำหรับ lab, สาขาใหม่, หรือ cloud ผ่าน **Caddy** (HTTP `:8080` + HTTPS `:443` เมื่อตั้งโดเมน)

## สถาปัตยกรรม

```text
[Browser / Mobile]
        |
   proxy:80 / :443  (HTTP_PORT / HTTPS_PORT)
    /    |    \
   /     |     \___ /socket.io → backend:4000
  /      \________ /api, /uploads → backend:4000
 /________________ / → web:3000 (Next.js)
                          |
                    backend:4000
                          |
                    postgres:5432 (internal only)
```

- **postgres** — โหลด `database/schema.sql` ครั้งแรกที่ volume ว่าง จากนั้น backend รัน `migrate.js` ทุก start
- **backend** — ไม่ publish พอร์ตออก host (เข้าผ่าน Caddy เท่านั้น)
- **web** — `NEXT_PUBLIC_API_BASE=''` เพื่อ same-origin ผ่าน proxy
- **proxy (Caddy)** — TLS อัตโนมัติเมื่อตั้ง `CADDY_DOMAIN` + ส่ง `X-Forwarded-*` ให้ rate limit / LAN guard ทำงานถูก

## เริ่มต้นเร็ว

```bash
# จาก root โปรเจกต์
cp docker/.env.example docker/.env
# แก้ PGPASSWORD, JWT_SECRET (อย่างน้อย 32 ตัวอักษร)

docker compose --env-file docker/.env up -d --build

# สร้าง admin (ครั้งแรก)
docker compose --env-file docker/.env exec backend \
  node scripts/create-admin.js admin "YourStrongPass123" "Administrator" \
  --role super_admin --store-id 1 --allowed-store-ids 1
```

เปิดเว็บ: `http://localhost:8080/login` (หรือพอร์ตตาม `HTTP_PORT`)

### HTTPS (Let's Encrypt)

1. ชี้ DNS `A` record ของโดเมนมาที่เซิร์ฟเวอร์
2. เปิดพอร์ต **80 และ 443** ที่ firewall
3. แก้ `docker/.env`:

```env
CADDY_DOMAIN=pos.your-domain.com
ACME_EMAIL=you@your-domain.com
PUBLIC_BASE_URL=https://pos.your-domain.com
CORS_ORIGINS=https://pos.your-domain.com
HTTP_PORT=80
HTTPS_PORT=443
```

4. รันพร้อม TLS override:

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml --env-file docker/.env up -d --build
```

Caddy จะออกใบรับรอง Let's Encrypt อัตโนมัติ — ครั้งแรกอาจใช้เวลา 1–2 นาที

> โหมด HTTP-only (ไม่มีโดเมน): ใช้แค่ `docker compose --env-file docker/.env up -d` — ไม่ต้องใส่ `docker-compose.tls.yml`

## คำสั่งที่ใช้บ่อย

| งาน | คำสั่ง |
|-----|--------|
| ดู log | `docker compose --env-file docker/.env logs -f backend` |
| migrate | อัตโนมัติตอน backend start |
| seed dev (ไม่ใช้ production) | `docker compose exec -e NODE_ENV=development backend node scripts/db-seed.js` |
| QA multi-store | `docker compose exec backend npm run verify:multi-store` |
| หยุด | `docker compose --env-file docker/.env down` |
| ลบ DB | `docker compose down -v` |

## ความปลอดภัยใน Docker

อ่านรายละเอียดเต็มใน [`../SECURITY.md`](../SECURITY.md) และสรุปด้านล่าง

| หัวข้อ | แนวทาง |
|--------|--------|
| Secrets | ใส่ใน `docker/.env` เท่านั้น — **ห้าม commit** |
| Postgres | ไม่ expose `5432` ออก host (เฉพาะ network `pos_internal`) |
| API | เข้าผ่าน Caddy เท่านั้น — ไม่ map `4000:4000` ใน compose มาตรฐาน |
| Admin จากอินเทอร์เน็ต | `ADMIN_CONTROL_LAN_ONLY=true` (default) บล็อกการแก้เมนู/ร้าน/ผู้ใช้จาก WAN — staff สั่งออเดอร์/ครัวยังใช้ได้ |
| HTTPS | ตั้ง `CADDY_DOMAIN` + `ACME_EMAIL` ใน `docker/.env` (Caddy ใน compose) |
| พิมพ์ thermal | container มัก **ไม่** เห็นเครื่องพิมพ์ LAN — ตั้ง `PRINTER_ENABLED=false` หรือใช้ host network / print relay แยก |

### Production checklist

1. `cp docker/.env.example docker/.env` แล้วรัน `cd backend && npm run rotate-secrets` คัดลอกค่าใหม่
2. `JWT_EXPIRES_IN=2h`, `BCRYPT_COST=12`
3. `CORS_ORIGINS` และ `PUBLIC_BASE_URL` = URL จริง (https)
4. อย่า seed user `admin123` เมื่อ `NODE_ENV=production`
5. ใส่ reverse proxy TLS หน้า `:8080` และจำกัด firewall

## เครื่องพิมพ์จาก container

ค่าเริ่มต้น `PRINTER_ENABLED=false` เพราะ IP เครื่องพิมพ์อยู่บน LAN ของ host

ทางเลือก:

- รัน backend บน Windows service (แบบเดิม) สำหรับพิมพ์ + ใช้ Docker เฉพาะ dev/สาขา
- `network_mode: host` (Linux only) สำหรับ backend
- Print relay แยกที่ bind LAN

## ความต่างจาก Windows service

| | Windows WinSW | Docker Compose |
|--|---------------|----------------|
| พิมพ์ TCP LAN | รองรับเต็ม | ต้องตั้งค่าเพิ่ม |
| ngrok / Caddy บน host | มีอยู่แล้ว | ใช้ proxy container หรือ host |
| อัปเดต | `git pull` + restart service | `docker compose build && up -d` |

Windows production ในร้านยังแนะนำ `deploy/services/` — Docker เหมาะกับ staging, สาขาใหม่, หรือ VPS

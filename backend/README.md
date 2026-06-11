# POS_V2 Backend

Node.js (Express) + PostgreSQL + Socket.io.

## Setup

```bash
cp .env.example .env       # then edit DB credentials / JWT secret
npm install
createdb -U postgres pos_v2   # or use pgAdmin/psql to create the DB
npm run db:reset              # apply schema.sql + seed.sql + create dev users
npm run dev                   # starts on http://localhost:4000
```

`db:reset` prints the per-table QR tokens — paste one into the customer-web URL
as `?t=<token>` to simulate a customer scanning that table's QR.

## Default dev users

| username | password   | role    |
|----------|-----------|---------|
| admin    | admin123  | admin   |
| staff1   | staff123  | staff   |
| kitchen  | kitchen123| kitchen |

Change these before going to production.

## Endpoints

- `POST   /api/auth/login`           — returns `{ token, user }`
- `GET    /api/auth/me`              — current user (requires JWT)
- `GET    /api/categories`           — public
- `GET    /api/products?category_id=&available_only=1` — public
- `POST/PUT/DELETE /api/products`    — admin only
- `GET    /api/tables`               — auth
- `POST   /api/tables`               — admin
- `POST   /api/tables/:id/rotate-qr` — admin
- `GET    /api/orders?status=`       — auth (staff/admin/kitchen)
- `POST   /api/orders`               — staff/admin (creates order on behalf of table)
- `PATCH  /api/orders/:id/status`    — staff/admin/kitchen
- `PATCH  /api/orders/items/:itemId/status` — staff/admin/kitchen

Public (customer QR, no auth — token in URL identifies the table):

- `GET  /api/public/table/:token`
- `GET  /api/public/menu`
- `POST /api/public/orders`              `{ token, items: [{product_id, quantity, note?}], note? }`
- `GET  /api/public/orders/:id?token=`

## Realtime

Socket.io is mounted on the same HTTP server. Events emitted server-side:

- `order:new`    — full order payload when created
- `order:update` — full order payload on status change

Kitchen tablet should `socket.emit('join', 'kitchen')` (room is reserved for
future per-room targeting; today events are broadcast).

# POS V2 — GitHub Copilot instructions

> This file mirrors `AGENTS.md` at the repo root. Update both together.
> Copilot does not follow markdown imports, so the content is copied
> in full below.

POS V2 is a multi-tenant **Thai-language restaurant POS** running on a
Windows 11 in-store server. It is shared by admin / staff / kitchen
users plus customers who scan a per-table QR from their phone.

## Stack

| Layer | Tech | Lives in |
|-------|------|----------|
| Backend API + Socket.io + thermal printer driver | Node.js (Express), PostgreSQL | `backend/` |
| Web UI for customer / staff / kitchen / admin | Next.js 14 (App Router) | `customer-web/` |
| Mobile app (Bluetooth thermal print) | Flutter | `mobile/` |
| Database schema + migrations | PostgreSQL | `database/` |
| Windows service wrappers, deploy scripts | WinSW XMLs + .bat | `deploy/` |

## Conventions

- **UI text is Thai by default.** Code identifiers, comments, commit
  messages, and log lines stay English.
- **Multi-store**: domain tables are scoped by `store_id`; routes use
  `resolveStoreId(req)` and require `X-POS-Store-ID` headers from the
  client (`customer-web/src/lib/auth.js → activeStoreHeaders`).
- **Roles**: `super_admin`, `admin`, `staff`, `kitchen`. Customers are
  unauthenticated, identified by per-table `qr_token`.
- **Currency**: THB (`฿`), `Asia/Bangkok` timezone.
- **Styling**: inline styles + a small set of global classes in
  `customer-web/src/app/globals.css` (`admin-header`, `admin-table-wrap`,
  `login-shell`, `print-preview-paper`, ...). Match surrounding style.
- **Comments**: minimum; explain WHY when non-obvious, never WHAT.

## Production runtime

Two WinSW services:

| Service | Wraps | Working dir | Port |
|---------|-------|-------------|------|
| `pos-v2-backend` | `node src/server.js` | `backend/` | 4000 |
| `pos-v2-web`     | `next start`         | `customer-web/` | 3000 |

**Code edits do NOT take effect until services are restarted.** The web
service runs from `customer-web/.next/` production build, so source
changes there also need `npm run build` first.

```powershell
# After editing customer-web sources
cd D:\POS_V2\customer-web; npm run build
D:\POS_V2\deploy\services\pos-v2-web.exe restart

# After editing backend sources
D:\POS_V2\deploy\services\pos-v2-backend.exe restart

# Both at once
D:\POS_V2\deploy\services\restart-services.bat
```

Logs roll by size in `backend/logs/` and `customer-web/logs/`.

## Local development

```bash
# Backend
cd backend
cp .env.example .env       # DATABASE_URL, JWT_SECRET
npm install
npm run db:reset           # schema + seed + dev users
npm run dev                # http://localhost:4000

# Web
cd customer-web
npm install
npm run dev                # http://localhost:3000
```

Default dev users (from `backend/scripts/db-seed.js`):

| username | password   | role        |
|----------|------------|-------------|
| admin    | admin123   | super_admin |
| staff1   | staff123   | staff       |
| kitchen  | kitchen123 | kitchen     |

## Database

PostgreSQL. Schema in `database/schema.sql`, **migrations** in
`database/migrations/NNN_*.sql` (lexicographic order, applied by
`backend/scripts/migrate.js`).

Rules:

1. Never edit a migration that has already been applied — add a new one.
2. For CHECK constraints, drop via a name-agnostic `DO $$ ... $$` block
   then re-add. See `019_print_jobs_qr_type.sql`.
3. Apply with `cd backend && node scripts/migrate.js` — safe to re-run.

Core tables: `stores`, `tables`, `categories`, `products`,
`product_variants`, `product_options`, `orders`, `order_items`,
`print_jobs`, `print_stations`, `restaurant_settings`,
`mobile_print_claims`, `users`.

Order status state machine: `pending → cooking → served → paid` (plus
`cancelled`).

## Thermal printing pipeline

A70Pro receipt printer (ESC/POS over TCP/IP) has **no Thai font
onboard**. Two paths in `backend/src/printer.js`:

- `renderMode: 'text'` — ESC/POS + TIS-620 codepage. Works only if the
  printer has Thai built-in.
- `renderMode: 'image'` (default for A70Pro) — `printer-bitmap.js`
  rasterizes lines through `node-canvas` using `tahoma.ttf`.

For every new printable artifact, supply **both** builders and dispatch:

```js
const payload = cfg.renderMode === 'image'
  ? bitmap.buildXBitmap(args, cfg)
  : buildX(args, cfg);
```

Jobs go through `print_jobs` with exponential backoff. Every job
`type` must be in the `print_jobs.type` CHECK constraint
(currently: `kitchen`, `receipt`, `test`, `custom`, `qr`) — extend via
a migration if you add a new one. TSPL printers use
`backend/src/printer-tspl.js`.

## Web ↔ Mobile parity (IMPORTANT)

Admin/Staff features live in BOTH `customer-web/` (Next.js) AND
`mobile/` (Flutter). When adding/changing an admin/staff feature on the
web, port the same change to mobile in the same task.

| Web | Mobile |
|-----|--------|
| `customer-web/src/app/admin/page.jsx` ProductsTab | `mobile/lib/screens/admin_screen.dart` `_ProductsTabState` |
| `customer-web/src/app/admin/page.jsx` TablesTab | `mobile/lib/screens/admin_screen.dart` `_TablesTabState` |
| `customer-web/src/app/staff/page.jsx` | `mobile/lib/screens/staff_screen.dart` |
| `customer-web/src/lib/api.js` | `mobile/lib/services/api_service.dart` |

Checklist: (1) backend route, (2) web UI, (3) mobile UI + `api_service.dart`,
(4) build customer-web + flutter APK, (5) restart services.

## Web UI structure (Next.js App Router)

`customer-web/src/app/`:

- `page.jsx` → root, redirects to `/login`.
- `login/page.jsx` — single login form for admin/staff/kitchen.
- `admin/page.jsx` — tabbed admin (≈3k lines; one file by design).
- `staff/page.jsx` — table sidebar + order entry + print.
- `kitchen/page.jsx` — dark theme display + status transitions.
- `order/page.jsx` — customer menu/cart (requires `?t=qr_token`).

Shared libs in `customer-web/src/lib/` (`auth.js`, `api.js`,
`realtimeRecovery.js`, `printQr.js`, ...).

## Where to look first

| Need to … | Start here |
|-----------|-----------|
| Add an API endpoint | `backend/src/routes/*.js` + `backend/src/middleware/auth.js` |
| Touch the print pipeline | `backend/src/printer.js`, `printer-bitmap.js`, `printer-tspl.js`, `routes/print.js` |
| Change the admin UI | `customer-web/src/app/admin/page.jsx` |
| Change the customer flow | `customer-web/src/app/order/page.jsx`, `routes/public.js` |
| Adjust the kitchen display | `customer-web/src/app/kitchen/page.jsx` |
| Add a setting toggle | `restaurant_settings` table + `routes/settings.js` + relevant UI tab |
| Multi-store rule | `backend/src/lib/storeScope.js`, `accessBoundary.js` |
| Add a migration | `database/migrations/NNN_*.sql` then `node scripts/migrate.js` |

## Out of scope by default

- `mobile/` (Flutter) — phase 2.2, only touch when explicitly asked.
- `tools/`, `artifacts/` — scratch space.
- `app.js` at repo root — old reference, not live code.

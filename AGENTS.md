# POS V2 — AI Agent Guide

This document is the canonical context for AI coding agents working on
this repository. It is read by:

- **OpenAI Codex CLI** (`codex`) and **ChatGPT Codex** (web) — they read `AGENTS.md` natively.
- **Claude Code** (`claude`) — reads `CLAUDE.md`, which imports this file.
- **GitHub Copilot** — reads `.github/copilot-instructions.md`, mirrored from this file.

If you change the project structure, commands, or conventions, update
this file first, then sync the other two so all agents stay in sync.

---

## 1. Project at a glance

POS V2 is a multi-tenant **Thai-language restaurant POS** system. It runs
on a Windows 11 in-store server and is shared by admin / staff / kitchen
users plus customers who scan a per-table QR code from their phone.

Stack:

| Layer | Tech | Lives in |
|-------|------|----------|
| Backend API + Socket.io + thermal printer driver | Node.js (Express), PostgreSQL | `backend/` |
| Web UI for customer / staff / kitchen / admin | Next.js 14 (App Router) | `customer-web/` |
| Mobile app (Bluetooth thermal print, offline-friendly) | Flutter | `mobile/` |
| Database schema + migrations | PostgreSQL | `database/` |
| Windows service wrappers, deploy scripts | WinSW XMLs + .bat | `deploy/` |

Languages and conventions:

- **UI text is Thai by default.** Code identifiers stay in English.
- **Currency**: THB (`฿`), `Asia/Bangkok` timezone.
- **Multi-store**: every domain table is scoped by `store_id`; API requests
  send `X-POS-Store-ID` (handled in `backend/src/lib/storeScope.js`).
- **Roles**: `super_admin`, `admin`, `staff`, `kitchen`. Customers are
  unauthenticated, identified by a per-table `qr_token`.

## 2. Production runtime

The Windows server runs **two WinSW Windows services**:

| Service | Wraps | Working dir | Port |
|---------|-------|-------------|------|
| `pos-v2-backend` | `node src/server.js` | `backend/` | 4000 |
| `pos-v2-web`     | `next start`         | `customer-web/` | 3000 |

Both are defined in `deploy/services/pos-v2-{backend,web}.xml` and
restarted via `deploy/services/restart-services.bat`.

**Code edits do NOT take effect until services are restarted.** The web
service runs from the `.next/` production build, so changes to
`customer-web/src/` also need `npm run build` first.

```powershell
# After editing customer-web sources
cd D:\POS_V2\customer-web; npm run build
D:\POS_V2\deploy\services\pos-v2-web.exe restart

# After editing backend sources
D:\POS_V2\deploy\services\pos-v2-backend.exe restart
```

Logs land in `backend/logs/pos-v2-backend.*.log` and
`customer-web/logs/pos-v2-web.*.log` (rolled by size).

## 3. Local development

```bash
# Backend
cd backend
cp .env.example .env       # set DATABASE_URL, JWT_SECRET
npm install
npm run db:reset           # schema.sql + migrations + seed + dev users
npm run dev                # http://localhost:4000

# Web
cd customer-web
npm install
npm run dev                # http://localhost:3000
```

Default dev users (in `backend/scripts/db-seed.js`):

| username | password   | role        |
|----------|------------|-------------|
| admin    | admin123   | super_admin |
| staff1   | staff123   | staff       |
| kitchen  | kitchen123 | kitchen     |

## 4. Database

PostgreSQL. Schema in `database/schema.sql`, migrations in
`database/migrations/NNN_*.sql` (lexicographic order, applied by
`backend/scripts/migrate.js`).

**Add a migration** — never edit a past one:

1. Create `database/migrations/NNN_describe_change.sql` (next sequence).
2. Use `DO $$ ... DROP CONSTRAINT ... $$` blocks when you redefine
   CHECK constraints — they may have different names on different
   environments. See `019_print_jobs_qr_type.sql` for the pattern.
3. Apply with `cd backend && node scripts/migrate.js`.
4. The script records applied files in `_migrations`, so it is safe to
   re-run.

Domain tables to know:

- `stores`, `tables`, `categories`, `products`, `product_variants`,
  `product_options`
- `orders`, `order_items` (status state machine: `pending → cooking → served → paid`, plus `cancelled`)
- `print_jobs` (queue with `pending|processing|success|failed|retrying|cancelled`)
- `print_stations` (one printer per kitchen station + a receipt printer)
- `restaurant_settings` (singleton id=1) with per-store overlays
- `mobile_print_claims` (one-shot claim so mobile only prints once)
- `users` with `allowed_store_ids` and `permissions`

## 5. Thermal printing pipeline

The receipt printer (`A70Pro` over TCP/IP, ESC/POS) does **not** have
Thai fonts onboard. Two render modes are supported in
`backend/src/printer.js`:

- `renderMode: 'text'` — ESC/POS text + TIS-620 codepage (printer-side
  Thai font). Only works when the printer has Thai built-in.
- `renderMode: 'image'` — `printer-bitmap.js` rasterizes lines through
  `node-canvas` using `tahoma.ttf`, then sends ESC/POS raster bytes.
  **This is the default for A70Pro and similar.**

When you add a new printable artifact (receipt, kitchen ticket, QR
label, ...), supply **both** builders and dispatch on `cfg.renderMode`:

```js
// in printer.js queueX()
const payload = cfg.renderMode === 'image'
  ? bitmap.buildXBitmap(args, cfg)
  : buildX(args, cfg);
```

Jobs go through `print_jobs` with a worker that does exponential
backoff. Each job type must be in the `print_jobs.type` CHECK
constraint — extend it via a migration if you add a new type
(`kitchen`, `receipt`, `test`, `custom`, `qr` so far).

TSPL label printers (AYIN, IPRT) have their own path in
`backend/src/printer-tspl.js`.

## 6. Web UI structure

`customer-web/src/app/` (Next.js App Router):

- `page.jsx` → root, redirects to `/login`.
- `login/page.jsx` — single login form for admin/staff/kitchen.
- `admin/page.jsx` — tabbed admin (ภาพรวม, ออเดอร์, เมนู, หมวด, โต๊ะ, QR, เครื่องพิมพ์, คิวพิมพ์, บัญชี).
- `staff/page.jsx` — sidebar of tables, order entry, pay, print.
- `kitchen/page.jsx` — dark theme display, status transitions.
- `order/page.jsx` — customer-facing menu/cart (requires `?t=qr_token`).

Auth helpers in `customer-web/src/lib/auth.js`. Realtime recovery in
`realtimeRecovery.js`. Active-store helpers in `auth.js` and forwarded
via `X-POS-Store-ID` on every authenticated request.

Styling is **inline styles + a few global CSS classes** in
`globals.css`. There is some Tailwind, but most components use plain
inline styles or class names like `.admin-header`, `.admin-table-wrap`,
`.login-shell`, `.print-preview-paper`. Match the surrounding style
when adding UI.

## 6.1 Web ↔ Mobile parity (IMPORTANT)

Admin and Staff features live in **both** `customer-web/` (Next.js) and
`mobile/` (Flutter). When you add or change an admin/staff feature on
the web, **port the same change to mobile in the same task** unless
the user explicitly says otherwise.

| Web file | Mobile counterpart |
|----------|-------------------|
| `customer-web/src/app/admin/page.jsx` ProductsTab | `mobile/lib/screens/admin_screen.dart` `_ProductsTabState` |
| `customer-web/src/app/admin/page.jsx` TablesTab + QRCodesTab | `mobile/lib/screens/admin_screen.dart` `_TablesTabState` |
| `customer-web/src/app/admin/page.jsx` OrdersTab | `mobile/lib/screens/admin_screen.dart` orders list |
| `customer-web/src/app/admin/page.jsx` PrinterTab | `mobile/lib/screens/admin_screen.dart` printer settings |
| `customer-web/src/app/staff/page.jsx` | `mobile/lib/screens/staff_screen.dart` |
| `customer-web/src/app/kitchen/page.jsx` | `mobile/lib/screens/kitchen_screen.dart` |
| `customer-web/src/lib/api.js` + `lib/socket.js` | `mobile/lib/services/api_service.dart` + `socket_service.dart` |

**Checklist for every admin/staff feature change:**

1. Backend endpoint in `backend/src/routes/*.js` (one source of truth).
2. Web UI in `customer-web/src/app/{admin,staff}/page.jsx`.
3. Matching mobile UI in `mobile/lib/screens/*.dart` and method in
   `mobile/lib/services/api_service.dart`.
4. Build customer-web (`npm run build`), build mobile APK
   (`flutter build apk --release`), restart services if needed.

Skip mobile only when the user explicitly limits the scope (e.g.
"web only" or "ระหว่างทดสอบ").

## 7. Conventions for AI agents

- **Tone**: replies to the human user are Thai-friendly; comments and
  identifiers stay English. Existing UI strings are Thai — match that.
- **Don't restart services without saying so.** Production runs as
  Windows services; ask before running `restart-services.bat` or
  `pos-v2-*.exe restart`. Same for force-pushes, destructive SQL, etc.
- **Build before restart.** `customer-web` changes need
  `npm run build` first or the service serves the old `.next/`.
- **Schema changes go through migrations** (never edit
  `database/schema.sql` for live changes — that file is for fresh DBs).
- **Thai text on thermal printer must go through the bitmap path** when
  `cfg.renderMode === 'image'`. Adding ESC/POS-only text will print
  garbage on the A70Pro.
- **Multi-store**: any new table that holds customer-visible data needs
  a `store_id` column, an index on it, and the scope filter applied in
  routes (`resolveStoreId(req)`).
- **CHECK constraints**: prefer `ALTER TABLE ... DROP CONSTRAINT` via a
  `DO $$` block (so the migration is name-agnostic), then re-add.
- **Comments**: minimum, only for non-obvious WHY. Don't restate WHAT.

## 8. Useful commands cheat sheet

```bash
# DB
cd backend && node scripts/migrate.js       # apply pending migrations
cd backend && npm run db:reset              # schema + migrations + seed (dev only)
cd backend && node scripts/create-admin.js  # one-off admin user

# Backend
cd backend && npm run dev                   # local nodemon
D:\POS_V2\deploy\services\pos-v2-backend.exe restart   # prod

# Web
cd customer-web && npm run dev              # local Next.js dev
cd customer-web && npm run build            # production build
D:\POS_V2\deploy\services\pos-v2-web.exe restart       # prod

# Both
D:\POS_V2\deploy\services\restart-services.bat
```

Health check URLs (replace host as needed):

- `http://localhost:4000/api/discovery/info`
- `http://localhost:3000/login`

## 9. Where to look first

| Need to … | Start here |
|-----------|-----------|
| Add an API endpoint | `backend/src/routes/*.js` + auth in `backend/src/middleware/auth.js` |
| Touch the print pipeline | `backend/src/printer.js`, `printer-bitmap.js`, `printer-tspl.js`, `routes/print.js` |
| Change the admin UI | `customer-web/src/app/admin/page.jsx` (one big file by design) |
| Change the customer flow | `customer-web/src/app/order/page.jsx`, `routes/public.js` |
| Adjust the kitchen display | `customer-web/src/app/kitchen/page.jsx` |
| Add a setting toggle | `restaurant_settings` table + `routes/settings.js` + the relevant UI tab |
| Multi-store rule change | `backend/src/lib/storeScope.js`, `backend/src/lib/accessBoundary.js` |
| Add a migration | `database/migrations/NNN_*.sql` then `node scripts/migrate.js` |

## 10. Out of scope / handled elsewhere

- `mobile/` (Flutter) is phase 2.2 — touch only when explicitly asked.
- `tools/`, `artifacts/` are scratch space, not loaded by the app.
- `app.js` at the repo root is reference material from the old
  single-file system; the live code is under `backend/` and
  `customer-web/`.

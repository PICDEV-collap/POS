# POS — Krutom Noodle

A modern web point-of-sale for the Krutom Noodle shop, built with React, TypeScript, Vite, and Tailwind CSS v4.

## Features

- Touch-friendly menu grid with category tabs, live search, popular/sold-out badges
- Order cart with quantity controls, per-line totals, and quick percentage discounts
- Payment flow supporting cash (with quick-tender buttons and change calculation), QR/PromptPay, and card
- Post-payment receipt with print support and one-tap new order

## Getting started

```bash
cd web
npm install
npm run dev      # start dev server at http://localhost:5173
```

Other scripts (run from `web/`):

```bash
npm run build    # type-check and produce production bundle in dist/
npm run lint     # run ESLint
npm run preview  # preview the production build
```

## Project structure

```
web/
├── src/
│   ├── App.tsx                  # POS layout and order state
│   ├── components/
│   │   ├── Header.tsx           # Branding, search, order number
│   │   ├── CategoryTabs.tsx     # Menu category filter
│   │   ├── ProductCard.tsx      # Menu item tile
│   │   ├── CartPanel.tsx        # Order lines, discount, totals, charge
│   │   ├── PaymentModal.tsx     # Cash / QR / card payment
│   │   └── ReceiptModal.tsx     # Payment confirmation & receipt
│   ├── data/menu.ts             # Menu items, categories, currency helper
│   └── types.ts                 # Shared types
└── ...
```

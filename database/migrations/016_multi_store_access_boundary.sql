-- Multi-store foundation for a single central server.
-- Backward compatible: all existing data is assigned to store_id=1.

CREATE TABLE IF NOT EXISTS stores (
  id                         SERIAL PRIMARY KEY,
  code                       VARCHAR(32) UNIQUE NOT NULL,
  slug                       VARCHAR(64) UNIQUE NOT NULL,
  name                       VARCHAR(128) NOT NULL,
  logo                       VARCHAR(16) DEFAULT '🍽️',
  currency                   VARCHAR(8) NOT NULL DEFAULT '฿',
  public_base_url            TEXT,
  timezone                   VARCHAR(64) NOT NULL DEFAULT 'Asia/Bangkok',
  ordering_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  ordering_open_time         TIME NOT NULL DEFAULT '00:00',
  ordering_close_time        TIME NOT NULL DEFAULT '23:59',
  ordering_timezone          VARCHAR(64) NOT NULL DEFAULT 'Asia/Bangkok',
  ordering_days              INT[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6]::INT[],
  ordering_require_session   BOOLEAN NOT NULL DEFAULT TRUE,
  ordering_require_private_ip BOOLEAN NOT NULL DEFAULT FALSE,
  ordering_require_gps       BOOLEAN NOT NULL DEFAULT FALSE,
  ordering_shop_lat          DOUBLE PRECISION,
  ordering_shop_lng          DOUBLE PRECISION,
  ordering_max_distance_m    INT NOT NULL DEFAULT 20,
  is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO stores (
  id, code, slug, name, logo, currency, public_base_url, timezone,
  ordering_enabled, ordering_open_time, ordering_close_time,
  ordering_timezone, ordering_days, ordering_require_session,
  ordering_require_private_ip, ordering_require_gps,
  ordering_shop_lat, ordering_shop_lng, ordering_max_distance_m
)
SELECT
  1,
  'default',
  'default',
  COALESCE(NULLIF(name, ''), 'POS V2 Restaurant'),
  COALESCE(NULLIF(logo, ''), '🍽️'),
  COALESCE(NULLIF(currency, ''), '฿'),
  base_url,
  COALESCE(NULLIF(ordering_timezone, ''), 'Asia/Bangkok'),
  ordering_enabled,
  ordering_open_time,
  ordering_close_time,
  ordering_timezone,
  ordering_days,
  ordering_require_session,
  ordering_require_private_ip,
  ordering_require_gps,
  ordering_shop_lat,
  ordering_shop_lng,
  ordering_max_distance_m
FROM restaurant_settings
WHERE id = 1
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  logo = EXCLUDED.logo,
  currency = EXCLUDED.currency,
  public_base_url = COALESCE(stores.public_base_url, EXCLUDED.public_base_url),
  updated_at = NOW();

SELECT setval(pg_get_serial_sequence('stores', 'id'), GREATEST((SELECT MAX(id) FROM stores), 1), true);

ALTER TABLE users ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_store_ids INT[] NOT NULL DEFAULT ARRAY[1]::INT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE users SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE users ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE users ALTER COLUMN store_id SET NOT NULL;
UPDATE users SET allowed_store_ids = ARRAY[store_id] WHERE allowed_store_ids IS NULL OR array_length(allowed_store_ids, 1) IS NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'admin', 'staff', 'kitchen'));

ALTER TABLE tables ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
UPDATE tables SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE tables ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE tables ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE tables DROP CONSTRAINT IF EXISTS tables_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_store_code_unique ON tables(store_id, lower(code));
CREATE INDEX IF NOT EXISTS idx_tables_store_active ON tables(store_id, is_active);

ALTER TABLE categories ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
UPDATE categories SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE categories ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE categories ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_categories_store_sort ON categories(store_id, is_active, sort_order, id);

ALTER TABLE print_stations ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
UPDATE print_stations SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE print_stations ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE print_stations ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_print_stations_store_active ON print_stations(store_id, is_active, sort_order);

ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
UPDATE products p
   SET store_id = COALESCE(c.store_id, 1)
  FROM categories c
 WHERE p.category_id = c.id
   AND p.store_id IS NULL;
UPDATE products SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE products ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE products ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_store_category ON products(store_id, category_id, is_available, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_products_store_barcode ON products(store_id, barcode) WHERE barcode IS NOT NULL;

ALTER TABLE customer_order_sessions ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
UPDATE customer_order_sessions cos
   SET store_id = COALESCE(t.store_id, 1)
  FROM tables t
 WHERE cos.table_id = t.id
   AND cos.store_id IS NULL;
UPDATE customer_order_sessions SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE customer_order_sessions ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE customer_order_sessions ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_store_table ON customer_order_sessions(store_id, table_id, last_seen_at DESC);

ALTER TABLE order_daily_sequences ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
UPDATE order_daily_sequences SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE order_daily_sequences ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE order_daily_sequences ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE order_daily_sequences DROP CONSTRAINT IF EXISTS order_daily_sequences_pkey;
ALTER TABLE order_daily_sequences
  ADD CONSTRAINT order_daily_sequences_pkey PRIMARY KEY (store_id, business_date);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
UPDATE orders o
   SET store_id = COALESCE(t.store_id, 1)
  FROM tables t
 WHERE o.table_id = t.id
   AND o.store_id IS NULL;
UPDATE orders SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE orders ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE orders ALTER COLUMN store_id SET NOT NULL;
DROP INDEX IF EXISTS idx_orders_business_date_daily_seq;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_store_business_date_daily_seq
  ON orders(store_id, business_date, daily_seq);
CREATE INDEX IF NOT EXISTS idx_orders_store_status_created
  ON orders(store_id, status, created_at DESC);

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
UPDATE stock_movements sm
   SET store_id = COALESCE(
     (SELECT o.store_id FROM orders o WHERE o.id = sm.order_id),
     (SELECT p.store_id FROM products p WHERE p.id = sm.product_id),
     1
   )
 WHERE sm.store_id IS NULL;
UPDATE stock_movements SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE stock_movements ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE stock_movements ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_store_created ON stock_movements(store_id, created_at DESC);

ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
UPDATE payment_transactions pt
   SET store_id = COALESCE(o.store_id, 1)
  FROM orders o
 WHERE pt.order_id = o.id
   AND pt.store_id IS NULL;
UPDATE payment_transactions SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE payment_transactions ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE payment_transactions ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_transactions_store_created ON payment_transactions(store_id, created_at DESC);

ALTER TABLE accounting_exports ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE RESTRICT;
UPDATE accounting_exports SET store_id = 1 WHERE store_id IS NULL;
ALTER TABLE accounting_exports ALTER COLUMN store_id SET DEFAULT 1;
ALTER TABLE accounting_exports ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounting_exports_store_created ON accounting_exports(store_id, created_at DESC);

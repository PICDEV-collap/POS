-- Migration 014 — split kitchen printing by production station and add stock barcode sales.
-- Backward compatible:
-- - Existing products default to food/kitchen.
-- - Existing print jobs keep their stored printer_host/printer_port.
-- - Stations with no host fall back to the legacy PRINTER_HOST env config.

CREATE TABLE IF NOT EXISTS print_stations (
    key          VARCHAR(32) PRIMARY KEY,
    name         VARCHAR(128) NOT NULL,
    station_type VARCHAR(16) NOT NULL DEFAULT 'kitchen'
                 CHECK (station_type IN ('kitchen', 'drink', 'snack', 'receipt', 'custom')),
    printer_key  VARCHAR(128),
    printer_host TEXT,
    printer_port INT,
    width_chars  INT NOT NULL DEFAULT 42,
    thai_cp      INT NOT NULL DEFAULT 21,
    render_mode  VARCHAR(16) NOT NULL DEFAULT 'text'
                 CHECK (render_mode IN ('text', 'image')),
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO print_stations
    (key, name, station_type, sort_order)
VALUES
    ('kitchen', 'ครัว / อาหาร', 'kitchen', 10),
    ('drink',   'เครื่องดื่ม',   'drink',   20),
    ('snack',   'ขนม / สต๊อก',  'snack',   30)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS product_type VARCHAR(16) NOT NULL DEFAULT 'food',
    ADD COLUMN IF NOT EXISTS barcode VARCHAR(64),
    ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS stock_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS stock_alert_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS print_station_key VARCHAR(32);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_product_type_check'
      AND conrelid = 'products'::regclass
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_product_type_check
      CHECK (product_type IN ('food', 'drink', 'stock'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_print_station_key_fkey'
      AND conrelid = 'products'::regclass
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_print_station_key_fkey
      FOREIGN KEY (print_station_key) REFERENCES print_stations(key) ON DELETE SET NULL;
  END IF;
END $$;

UPDATE products
   SET print_station_key = CASE
         WHEN print_station_key IS NOT NULL THEN print_station_key
         WHEN product_type = 'drink' THEN 'drink'
         WHEN product_type = 'stock' THEN 'snack'
         ELSE 'kitchen'
       END
 WHERE print_station_key IS NULL;

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS print_station_key VARCHAR(32);

UPDATE order_items oi
   SET print_station_key = COALESCE(p.print_station_key, 'kitchen')
  FROM products p
 WHERE oi.product_id = p.id
   AND oi.print_station_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_products_print_station
    ON products(print_station_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique
    ON products(barcode)
 WHERE barcode IS NOT NULL AND barcode <> '';

CREATE INDEX IF NOT EXISTS idx_products_stock_tracking
    ON products(track_stock, product_type)
 WHERE track_stock = TRUE OR product_type = 'stock';

CREATE INDEX IF NOT EXISTS idx_order_items_print_station
    ON order_items(order_id, print_station_key);

CREATE TABLE IF NOT EXISTS stock_movements (
    id              SERIAL PRIMARY KEY,
    movement_key    TEXT UNIQUE NOT NULL,
    product_id      INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    order_id        INT REFERENCES orders(id) ON DELETE SET NULL,
    order_item_id   INT REFERENCES order_items(id) ON DELETE SET NULL,
    movement_type   VARCHAR(24) NOT NULL
                    CHECK (movement_type IN ('sale', 'cancel_order', 'cancel_item', 'manual_adjust')),
    quantity_delta  NUMERIC(12,3) NOT NULL,
    stock_after     NUMERIC(12,3),
    note            TEXT,
    created_by      INT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_created
    ON stock_movements(product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_order
    ON stock_movements(order_id, order_item_id);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0);

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS cost_price_snapshot NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cost_price_snapshot >= 0);

CREATE INDEX IF NOT EXISTS idx_order_items_cost_report
  ON order_items (order_id, product_id);

CREATE TABLE IF NOT EXISTS accounting_exports (
    id           SERIAL PRIMARY KEY,
    export_type  VARCHAR(32) NOT NULL,
    from_date    DATE NOT NULL,
    to_date      DATE NOT NULL,
    row_count    INT NOT NULL DEFAULT 0,
    created_by   INT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounting_exports_created
  ON accounting_exports (created_at DESC);

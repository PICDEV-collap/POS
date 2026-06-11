CREATE TABLE IF NOT EXISTS order_daily_sequences (
    business_date DATE PRIMARY KEY,
    last_seq      INT NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS business_date DATE;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS daily_seq INT;

UPDATE orders
   SET business_date = (created_at AT TIME ZONE 'Asia/Bangkok')::date
 WHERE business_date IS NULL;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY business_date
           ORDER BY created_at, id
         )::int AS seq
    FROM orders
   WHERE daily_seq IS NULL
)
UPDATE orders o
   SET daily_seq = ranked.seq
  FROM ranked
 WHERE o.id = ranked.id;

INSERT INTO order_daily_sequences (business_date, last_seq, updated_at)
SELECT business_date, COALESCE(MAX(daily_seq), 0), NOW()
  FROM orders
 WHERE business_date IS NOT NULL
 GROUP BY business_date
ON CONFLICT (business_date) DO UPDATE
   SET last_seq = GREATEST(order_daily_sequences.last_seq, EXCLUDED.last_seq),
       updated_at = NOW();

ALTER TABLE orders
  ALTER COLUMN business_date SET NOT NULL;

ALTER TABLE orders
  ALTER COLUMN daily_seq SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_business_date_daily_seq
    ON orders (business_date, daily_seq);

CREATE INDEX IF NOT EXISTS idx_orders_business_date_created_at
    ON orders (business_date, created_at, id);

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS fulfillment_type VARCHAR(16);

UPDATE order_items oi
   SET fulfillment_type = COALESCE(o.order_type, 'dine-in')
  FROM orders o
 WHERE oi.order_id = o.id
   AND oi.fulfillment_type IS NULL;

UPDATE order_items
   SET fulfillment_type = 'dine-in'
 WHERE fulfillment_type IS NULL;

ALTER TABLE order_items
  ALTER COLUMN fulfillment_type SET DEFAULT 'dine-in';

ALTER TABLE order_items
  ALTER COLUMN fulfillment_type SET NOT NULL;

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_fulfillment_type_check;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_fulfillment_type_check
  CHECK (fulfillment_type IN ('dine-in', 'takeaway'));

CREATE INDEX IF NOT EXISTS idx_order_items_fulfillment_type
    ON order_items (order_id, fulfillment_type);

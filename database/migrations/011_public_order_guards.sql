ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_open_time TIME NOT NULL DEFAULT '00:00';

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_close_time TIME NOT NULL DEFAULT '23:59';

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Bangkok';

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_days INT[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6]::INT[];

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_require_session BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_require_private_ip BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS customer_order_sessions (
  id              BIGSERIAL PRIMARY KEY,
  session_token   VARCHAR(96) UNIQUE NOT NULL,
  table_id        INT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  customer_key    VARCHAR(96) NOT NULL,
  first_ip        VARCHAR(64),
  last_ip         VARCHAR(64),
  user_agent_hash VARCHAR(64),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_table
    ON customer_order_sessions (table_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_key
    ON customer_order_sessions (customer_key, expires_at DESC)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_expiry
    ON customer_order_sessions (expires_at)
    WHERE is_active = TRUE;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_session_id BIGINT
  REFERENCES customer_order_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_customer_session
    ON orders (customer_session_id)
    WHERE customer_session_id IS NOT NULL;

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS payment_auto_close_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS payment_transactions (
    id                SERIAL PRIMARY KEY,
    order_id          INT REFERENCES orders(id) ON DELETE SET NULL,
    provider          VARCHAR(32) NOT NULL DEFAULT 'manual',
    provider_event_id TEXT,
    reference         TEXT,
    amount            NUMERIC(10,2),
    currency          VARCHAR(8) NOT NULL DEFAULT 'THB',
    status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'confirmed', 'rejected', 'failed', 'refunded')),
    raw_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    error             TEXT,
    confirmed_at      TIMESTAMPTZ,
    created_by        INT REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_order
  ON payment_transactions(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_reference
  ON payment_transactions(provider, reference);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_status
  ON payment_transactions(status, created_at DESC);

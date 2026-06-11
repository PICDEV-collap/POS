CREATE TABLE IF NOT EXISTS mobile_print_claims (
    id             SERIAL PRIMARY KEY,
    order_id       INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    type           VARCHAR(16) NOT NULL CHECK (type IN ('kitchen', 'receipt')),
    status         VARCHAR(16) NOT NULL DEFAULT 'claimed'
                   CHECK (status IN ('claimed', 'success', 'failed', 'expired')),
    claimed_by     INT REFERENCES users(id) ON DELETE SET NULL,
    claimed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 minutes',
    completed_at   TIMESTAMPTZ,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (order_id, type)
);

CREATE INDEX IF NOT EXISTS idx_mobile_print_claims_status
  ON mobile_print_claims(status, expires_at);

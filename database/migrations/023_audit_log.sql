CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  username    VARCHAR(64),
  role        VARCHAR(16),
  store_id    INT REFERENCES stores(id) ON DELETE SET NULL,
  action      VARCHAR(64) NOT NULL,
  target_type VARCHAR(32),
  target_id   TEXT,
  ip_address  VARCHAR(64),
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_store_created ON audit_log (store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  username     VARCHAR(64) PRIMARY KEY,
  failed_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_locked_until
  ON login_attempts (locked_until)
  WHERE locked_until IS NOT NULL;

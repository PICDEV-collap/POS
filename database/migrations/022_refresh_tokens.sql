CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  ip_address   VARCHAR(64),
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
  ON refresh_tokens (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

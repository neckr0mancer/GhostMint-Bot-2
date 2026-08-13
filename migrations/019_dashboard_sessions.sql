CREATE TABLE dashboard_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX dashboard_sessions_user_active_idx
  ON dashboard_sessions (user_id, expires_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX dashboard_sessions_expiry_idx ON dashboard_sessions (expires_at);

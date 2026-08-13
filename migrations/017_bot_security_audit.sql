CREATE TABLE bot_security_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('telegram','discord')),
  platform_user_id TEXT,
  context_id TEXT,
  command_name TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('unauthorized','rate_limited','invalid_context')),
  reason TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX bot_security_audit_user_time_idx ON bot_security_audit (user_id,attempted_at DESC);
CREATE INDEX bot_security_audit_platform_time_idx ON bot_security_audit (platform,attempted_at DESC);

CREATE TABLE social_adapter_usage (
  usage_id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  rule_id UUID REFERENCES social_watch_rules(rule_id) ON DELETE SET NULL,
  rule_name TEXT NOT NULL,
  adapter_method TEXT NOT NULL CHECK (adapter_method IN ('official_api','managed_service','scraper')),
  request_type TEXT NOT NULL CHECK (request_type IN ('read','poll','post')),
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count > 0),
  provider_cost_usd NUMERIC(14,6),
  provider_credits NUMERIC(18,6),
  succeeded BOOLEAN NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX social_adapter_usage_time_idx ON social_adapter_usage (requested_at DESC);
CREATE INDEX social_adapter_usage_user_time_idx ON social_adapter_usage (user_id, requested_at DESC);
CREATE INDEX social_adapter_usage_rule_time_idx ON social_adapter_usage (rule_id, requested_at DESC);

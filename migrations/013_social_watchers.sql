CREATE TABLE social_watch_rules (
  rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('twitter_account','twitter_keyword','discord_channel','discord_keyword')),
  method TEXT NOT NULL CHECK (method IN ('official_api','managed_service','scraper')),
  config JSONB NOT NULL DEFAULT '{}'::JSONB,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cursor JSONB,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE INDEX social_watch_rules_due_idx ON social_watch_rules (enabled, next_poll_at)
  WHERE enabled = TRUE;
CREATE INDEX social_watch_rules_user_idx ON social_watch_rules (user_id, created_at);

CREATE TABLE social_trigger_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  trigger_source TEXT NOT NULL DEFAULT 'social-triggered' CHECK (trigger_source = 'social-triggered'),
  platform TEXT NOT NULL CHECK (platform IN ('twitter','discord')),
  source_content_id TEXT NOT NULL,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  matched_rule_ids UUID[] NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedup_key TEXT NOT NULL UNIQUE,
  CHECK (address ~ '^0x[0-9a-fA-F]{40}$')
);

CREATE INDEX social_trigger_events_user_time_idx ON social_trigger_events (user_id, detected_at DESC);
CREATE INDEX social_trigger_events_user_address_idx ON social_trigger_events (user_id, LOWER(address), detected_at DESC);

ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('active','suspended','banned','deactivated'));
ALTER TABLE users ADD COLUMN status_reason TEXT;
ALTER TABLE users ADD COLUMN status_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN status_changed_by UUID REFERENCES users(user_id);
ALTER TABLE users ADD COLUMN suspended_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN subscription_active BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN good_standing_override BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users ADD CONSTRAINT users_suspended_until_check
  CHECK (account_status = 'suspended' OR suspended_until IS NULL);

CREATE INDEX users_account_status_idx ON users (account_status) WHERE account_status <> 'active';
CREATE INDEX users_suspended_until_idx ON users (suspended_until) WHERE account_status = 'suspended' AND suspended_until IS NOT NULL;

ALTER TABLE seat_groups ADD COLUMN retention_period_days INTEGER CHECK (retention_period_days IS NULL OR retention_period_days > 0);
ALTER TABLE seat_groups ADD COLUMN require_active_subscription BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE seat_groups ADD COLUMN require_recent_activity_days INTEGER CHECK (require_recent_activity_days IS NULL OR require_recent_activity_days > 0);

ALTER TABLE user_governance ADD COLUMN scheduled_removal_at TIMESTAMPTZ;
ALTER TABLE user_governance ADD COLUMN retention_renewed_at TIMESTAMPTZ;

CREATE INDEX user_governance_scheduled_removal_idx ON user_governance (scheduled_removal_at) WHERE scheduled_removal_at IS NOT NULL;

CREATE TABLE group_retention_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES seat_groups(group_id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('renewed','removed')),
  reason TEXT NOT NULL,
  previous_scheduled_removal_at TIMESTAMPTZ,
  next_scheduled_removal_at TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX group_retention_events_user_time_idx ON group_retention_events (user_id, evaluated_at DESC);

ALTER TABLE bot_security_audit DROP CONSTRAINT bot_security_audit_outcome_check;
ALTER TABLE bot_security_audit ADD CONSTRAINT bot_security_audit_outcome_check
  CHECK (outcome IN ('unauthorized','rate_limited','invalid_context','success','account_blocked'));

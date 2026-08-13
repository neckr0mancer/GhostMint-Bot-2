CREATE TABLE target_trigger_policies (
  policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('sniper','social_rule')),
  target_id UUID NOT NULL,
  blockchain_trigger_mode TEXT NOT NULL DEFAULT 'auto' CHECK (blockchain_trigger_mode IN ('auto','manual')),
  social_trigger_mode TEXT NOT NULL DEFAULT 'manual' CHECK (social_trigger_mode IN ('auto','manual')),
  human_verification TEXT NOT NULL DEFAULT 'on' CHECK (human_verification IN ('on','bypassed')),
  dont_ask_again BOOLEAN NOT NULL DEFAULT FALSE,
  wallet_label TEXT,
  mint_preset_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id,target_type,target_id),
  CHECK (target_type <> 'social_rule' OR (wallet_label IS NULL AND mint_preset_name IS NULL) OR
    (wallet_label IS NOT NULL AND mint_preset_name IS NOT NULL))
);

CREATE INDEX target_trigger_policies_user_idx ON target_trigger_policies (user_id,target_type);

CREATE TABLE target_bypass_challenges (
  challenge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('sniper','social_rule')),
  target_id UUID NOT NULL,
  dont_ask_again BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX target_bypass_challenges_pending_idx ON target_bypass_challenges
  (user_id,expires_at) WHERE used_at IS NULL;

CREATE TABLE trigger_execution_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('sniper','social_rule')),
  target_id UUID NOT NULL,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('blockchain-triggered','social-triggered')),
  source_event_id TEXT NOT NULL,
  preview JSONB NOT NULL,
  execution_payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executing','executed','failed','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id,target_type,target_id,trigger_source,source_event_id)
);
CREATE INDEX trigger_execution_requests_pending_idx ON trigger_execution_requests (user_id,expires_at)
  WHERE status='pending';

CREATE TABLE trigger_execution_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  trigger_source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  verification_state TEXT NOT NULL CHECK (verification_state IN ('on','bypassed')),
  dont_ask_again_active BOOLEAN NOT NULL,
  confirmation_shown BOOLEAN NOT NULL,
  transaction_intent_id UUID REFERENCES transaction_intents(intent_id) ON DELETE SET NULL,
  transaction_hash TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('submitted','confirmed','failed')),
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX trigger_execution_audit_user_time_idx ON trigger_execution_audit (user_id,executed_at DESC);
CREATE INDEX trigger_execution_audit_target_idx ON trigger_execution_audit (user_id,target_type,target_id,executed_at DESC);

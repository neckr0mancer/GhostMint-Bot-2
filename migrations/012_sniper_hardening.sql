ALTER TABLE snipers
  ADD COLUMN max_gas_gwei NUMERIC NOT NULL DEFAULT 200 CHECK (max_gas_gwei >= 0),
  ADD COLUMN daily_spending_cap_eth NUMERIC NOT NULL DEFAULT 0.25 CHECK (daily_spending_cap_eth >= 0),
  ADD COLUMN cooldown_ms INTEGER NOT NULL DEFAULT 60000 CHECK (cooldown_ms BETWEEN 0 AND 86400000),
  ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN contract_allowlist TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN contract_denylist TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN source_confirmations INTEGER NOT NULL DEFAULT 2 CHECK (source_confirmations BETWEEN 1 AND 1000);

ALTER TABLE sniper_seen_transactions
  ADD COLUMN state TEXT NOT NULL DEFAULT 'detected',
  ADD COLUMN source_block_number BIGINT,
  ADD COLUMN source_block_hash TEXT,
  ADD COLUMN contract_address TEXT,
  ADD COLUMN copied_value_wei NUMERIC(78,0),
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN skip_reason TEXT,
  ADD COLUMN failure_reason TEXT,
  ADD COLUMN retryable BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN transaction_intent_id UUID REFERENCES transaction_intents(intent_id) ON DELETE SET NULL,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE sniper_seen_transactions SET state='failed',failure_reason='legacy seen marker has unknown execution outcome';

ALTER TABLE sniper_seen_transactions
  ADD CONSTRAINT sniper_event_state_check
  CHECK (state IN ('detected','skipped','submitted','confirmed','failed'));

CREATE INDEX sniper_events_ready_idx
  ON sniper_seen_transactions (source_block_number, seen_at) WHERE state='detected';
CREATE INDEX sniper_events_state_idx
  ON sniper_seen_transactions (user_id,sniper_id,state,updated_at DESC);
CREATE INDEX sniper_events_intent_idx
  ON sniper_seen_transactions (transaction_intent_id) WHERE transaction_intent_id IS NOT NULL;

CREATE TABLE sniper_event_transitions (
  transition_id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  sniper_id UUID NOT NULL,
  tx_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('detected','skipped','submitted','confirmed','failed')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (user_id,sniper_id,tx_hash)
    REFERENCES sniper_seen_transactions(user_id,sniper_id,tx_hash) ON DELETE CASCADE
);
CREATE INDEX sniper_event_transitions_event_idx
  ON sniper_event_transitions (user_id,sniper_id,tx_hash,created_at);

INSERT INTO sniper_event_transitions (user_id,sniper_id,tx_hash,state,reason)
  SELECT user_id,sniper_id,tx_hash,state,failure_reason FROM sniper_seen_transactions;

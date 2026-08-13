ALTER TABLE wallets ADD CONSTRAINT wallets_user_id_id_key UNIQUE (user_id, id);

CREATE TABLE transaction_policies (
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('wallet', 'target')),
  scope_id TEXT NOT NULL,
  simulation_enabled BOOLEAN,
  gas_ceiling_gwei NUMERIC,
  max_transaction_value_wei NUMERIC(78,0),
  daily_spending_budget_wei NUMERIC(78,0),
  required_confirmations INTEGER,
  transaction_timeout_ms INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, scope_type, scope_id),
  CHECK (scope_id <> ''),
  CHECK (gas_ceiling_gwei IS NULL OR gas_ceiling_gwei >= 0),
  CHECK (max_transaction_value_wei IS NULL OR max_transaction_value_wei >= 0),
  CHECK (daily_spending_budget_wei IS NULL OR daily_spending_budget_wei >= 0),
  CHECK (required_confirmations IS NULL OR required_confirmations BETWEEN 1 AND 1000),
  CHECK (transaction_timeout_ms IS NULL OR transaction_timeout_ms BETWEEN 1000 AND 86400000)
);

CREATE TABLE transaction_intents (
  intent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  wallet_id BIGINT NOT NULL,
  target_id TEXT,
  chain TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  calldata TEXT NOT NULL,
  value_wei NUMERIC(78,0) NOT NULL,
  nonce BIGINT NOT NULL,
  gas_limit NUMERIC(78,0) NOT NULL,
  gas_price_wei NUMERIC(78,0),
  max_fee_per_gas_wei NUMERIC(78,0),
  max_priority_fee_per_gas_wei NUMERIC(78,0),
  estimated_cost_wei NUMERIC(78,0) NOT NULL,
  simulation_enabled BOOLEAN NOT NULL,
  required_confirmations INTEGER NOT NULL,
  transaction_timeout_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('submitted','pending','confirmed','reverted','replaced','unknown')),
  tx_hash TEXT,
  replacement_tx_hash TEXT,
  block_number BIGINT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pending_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  last_reconciled_at TIMESTAMPTZ,
  timeout_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT transaction_intents_wallet_fkey
    FOREIGN KEY (user_id, wallet_id) REFERENCES wallets(user_id, id) ON DELETE RESTRICT,
  CHECK (value_wei >= 0 AND nonce >= 0 AND gas_limit > 0 AND estimated_cost_wei >= 0),
  CHECK (required_confirmations BETWEEN 1 AND 1000),
  CHECK (transaction_timeout_ms BETWEEN 1000 AND 86400000)
);

CREATE UNIQUE INDEX transaction_intents_tx_hash_key
  ON transaction_intents (tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX transaction_intents_nonfinal_idx
  ON transaction_intents (state, last_reconciled_at)
  WHERE state IN ('submitted','pending','unknown');
CREATE INDEX transaction_intents_wallet_spend_idx
  ON transaction_intents (user_id, wallet_id, created_at DESC);

CREATE TABLE transaction_state_transitions (
  transition_id BIGSERIAL PRIMARY KEY,
  intent_id UUID NOT NULL REFERENCES transaction_intents(intent_id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (to_state IN ('submitted','pending','confirmed','reverted','replaced','unknown')),
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX transaction_state_transitions_intent_idx
  ON transaction_state_transitions (intent_id, occurred_at);

CREATE TABLE live_acceptance_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  chain TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  wallet_id BIGINT NOT NULL,
  method_signature TEXT NOT NULL,
  intent_id UUID REFERENCES transaction_intents(intent_id) ON DELETE SET NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
  failure_code TEXT,
  failure_reason TEXT,
  simulation_performed BOOLEAN NOT NULL,
  policy_snapshot JSONB NOT NULL,
  evidence JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT live_acceptance_runs_wallet_fkey
    FOREIGN KEY (operator_user_id, wallet_id) REFERENCES wallets(user_id, id) ON DELETE RESTRICT,
  CHECK (contract_address <> ''),
  CHECK (method_signature <> ''),
  CHECK ((outcome = 'failed') = (failure_code IS NOT NULL))
);

CREATE INDEX live_acceptance_runs_operator_idx
  ON live_acceptance_runs (operator_user_id, finished_at DESC);

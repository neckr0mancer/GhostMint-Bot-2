-- TX-021/TX-022 (Model 2 phase-2): append-only broadcast attempt tracking. Every signed hash
-- is durable BEFORE any provider receives its bytes, so restart reconciliation can find it
-- even after timeout, process interruption, or database failure. Replaces the single
-- bumped_from_tx_hash slot which erased older possibly-live hashes on multi-rung ladders.
CREATE TABLE IF NOT EXISTS transaction_broadcast_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES transaction_intents(intent_id),
  tx_hash TEXT NOT NULL,
  nonce BIGINT NOT NULL,
  gas_price_wei TEXT,
  max_fee_per_gas_wei TEXT,
  max_priority_fee_per_gas_wei TEXT,
  is_replacement BOOLEAN NOT NULL DEFAULT FALSE,
  broadcast_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (intent_id, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_attempts_intent
  ON transaction_broadcast_attempts (intent_id);

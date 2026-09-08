ALTER TABLE sniper_seen_transactions
  ADD COLUMN source_current_hash TEXT,
  ADD COLUMN source_data TEXT,
  ADD COLUMN source_value_wei NUMERIC(78,0),
  ADD COLUMN source_gas_price_wei NUMERIC(78,0),
  ADD COLUMN source_max_fee_per_gas_wei NUMERIC(78,0),
  ADD COLUMN source_max_priority_fee_per_gas_wei NUMERIC(78,0),
  ADD COLUMN source_gas_limit NUMERIC(78,0),
  ADD COLUMN reserved_network_cost_wei NUMERIC(78,0),
  ADD COLUMN claim_expires_at TIMESTAMPTZ;

UPDATE sniper_seen_transactions
SET source_current_hash = tx_hash
WHERE source_current_hash IS NULL;

CREATE INDEX sniper_claim_recovery_idx
  ON sniper_seen_transactions (claim_expires_at)
  WHERE state = 'submitted';

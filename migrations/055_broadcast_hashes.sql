-- TX-021/TX-022: append-only broadcast hash tracking. Every signed tx hash for an intent is
-- recorded BEFORE any provider receives the bytes, so restart reconciliation can find it even
-- after timeout, process interruption, or database failure. Replaces the single-slot
-- bumped_from_tx_hash which overwrites older hashes on multi-rung ladders.
CREATE TABLE IF NOT EXISTS transaction_broadcast_hashes (
  intent_id UUID NOT NULL REFERENCES transaction_intents(intent_id),
  tx_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (intent_id, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_hashes_intent ON transaction_broadcast_hashes(intent_id);

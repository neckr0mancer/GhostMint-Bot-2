-- Delta follow-up to 050: the trigger_source column (and the partial-scan index) were added to
-- that file AFTER it had already been applied to a database, and the migration runner correctly
-- skips recorded filenames -- so these arrived here instead. IF NOT EXISTS everywhere keeps this
-- idempotent against databases that have not yet seen 050 at all.
ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS trigger_source TEXT;
ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS bumped_from_tx_hash TEXT;
CREATE INDEX IF NOT EXISTS transaction_intents_bump_scan_idx
  ON transaction_intents (state, COALESCE(pending_at, submitted_at))
  WHERE state IN ('pending');

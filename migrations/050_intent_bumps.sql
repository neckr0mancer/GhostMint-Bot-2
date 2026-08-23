-- Stuck-transaction recovery (the bump ladder): track how many times an intent has been re-bid,
-- preserve the superseded hash so history stays auditable after tx_hash moves to the new one, and
-- record which execution surface fired each intent -- the ladder only re-bids the sources the
-- operator enabled (launch/scheduled by default). Legacy rows get NULL and are simply never
-- candidates; nothing older than the ladder was ever bump-managed.
ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS bump_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS bumped_from_tx_hash TEXT;
ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS trigger_source TEXT;
CREATE INDEX IF NOT EXISTS transaction_intents_bump_scan_idx
  ON transaction_intents (state, COALESCE(pending_at, submitted_at))
  WHERE state IN ('pending');

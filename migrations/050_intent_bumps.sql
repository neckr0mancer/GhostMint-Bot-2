-- Stuck-transaction recovery (the bump ladder): track how many times an intent has been re-bid,
-- and preserve the superseded hash so history stays auditable after tx_hash moves to the new one.
ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS bump_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS bumped_from_tx_hash TEXT;

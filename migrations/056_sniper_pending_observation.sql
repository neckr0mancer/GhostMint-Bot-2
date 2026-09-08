ALTER TABLE users
  ADD COLUMN sniper_observation_default TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (sniper_observation_default IN ('confirmed','pending'));

ALTER TABLE snipers
  ADD COLUMN observation_mode TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (observation_mode IN ('confirmed','pending'));

ALTER TABLE sniper_seen_transactions
  ADD COLUMN observation_mode TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (observation_mode IN ('confirmed','pending')),
  ADD COLUMN source_sender TEXT,
  ADD COLUMN source_nonce TEXT,
  ADD COLUMN source_key TEXT;

-- A pending transaction can be replaced with a different hash while retaining the same sender
-- and nonce. Treat that as one source action so replacement delivery cannot submit two copies.
-- Confirmed observations leave source_key NULL and continue to deduplicate by transaction hash.
CREATE UNIQUE INDEX sniper_pending_source_once_idx
  ON sniper_seen_transactions (user_id, sniper_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX snipers_observation_chain_idx
  ON snipers (chain, observation_mode)
  WHERE active = TRUE AND archived_at IS NULL;

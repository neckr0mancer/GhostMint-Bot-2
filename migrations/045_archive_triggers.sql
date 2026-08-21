-- Removing a sniper or a watch rule was a hard DELETE: the row went, and with it any way to answer
-- "what was that trigger that spent my money in March". The trigger_audit rows survive and still
-- reference the target id, so a delete left audit entries pointing at nothing.
--
-- Archiving instead. The row stays, stops being listed, stops polling, and remains joinable from
-- the audit trail. This is the §13.8 backlog item for these two tables; wallets, P&L and presets
-- still hard-delete and are not touched here.
--
-- Nullable rather than a boolean: WHEN it was archived is the useful fact, and NULL is the
-- unambiguous "still live" that a boolean default cannot express as cheaply.
ALTER TABLE snipers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE social_watch_rules ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Every list path filters on archived_at IS NULL, so these are the indexes those reads want.
CREATE INDEX IF NOT EXISTS snipers_live_idx ON snipers (user_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS social_watch_rules_live_idx ON social_watch_rules (user_id) WHERE archived_at IS NULL;

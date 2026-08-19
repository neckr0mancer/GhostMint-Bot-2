-- An expired scheduled mint is a thing that happened TO the user and then vanished: expiry is
-- derived from the clock (mint_time past the grace window), so nothing is written when it occurs
-- and nothing records that it ever did. A failed mint at least leaves a history entry; one whose
-- window simply passed left none at all.
--
-- This column marks that the expiry has been written to activity, so the sweep records it exactly
-- once. Deliberately a column rather than in-memory state: a duplicated warning is noise, but a
-- duplicated HISTORY row is a permanent lie about how many times something happened, and a restart
-- would produce one on every boot.
ALTER TABLE mint_tasks ADD COLUMN IF NOT EXISTS expired_logged_at TIMESTAMPTZ;

-- Only ever scanned for the handful of rows that are past their window and not yet recorded.
CREATE INDEX IF NOT EXISTS mint_tasks_expiry_sweep_idx
  ON mint_tasks (mint_time)
  WHERE expired_logged_at IS NULL AND status IN ('paused','failed');

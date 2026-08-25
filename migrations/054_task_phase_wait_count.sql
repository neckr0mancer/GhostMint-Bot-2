-- Claim attempts remain a complete audit sequence, while phase checks must not consume the
-- bounded execution/RPC retry budget. Track the subset that ended only in a phase deferral so
-- effective execution attempts are `attempt_count - phase_wait_count`.
ALTER TABLE mint_tasks
  ADD COLUMN phase_wait_count INTEGER NOT NULL DEFAULT 0
  CHECK (phase_wait_count >= 0 AND phase_wait_count <= attempt_count);

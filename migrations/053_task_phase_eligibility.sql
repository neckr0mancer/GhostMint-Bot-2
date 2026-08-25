-- Persist the OpenSea phase a scheduled mint is tracking. The database keeps the conservative
-- specific-stage default; callers may explicitly opt OpenSea tasks into earliest-eligible mode.
ALTER TABLE mint_tasks
  ADD COLUMN stage_uuid TEXT,
  ADD COLUMN stage_label TEXT,
  ADD COLUMN eligibility_mode TEXT NOT NULL DEFAULT 'specific_stage',
  ADD COLUMN eligibility_deadline TIMESTAMPTZ,
  ADD CONSTRAINT mint_tasks_eligibility_mode_check
    CHECK (eligibility_mode IN ('specific_stage','earliest_eligible'));

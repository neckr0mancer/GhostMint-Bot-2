-- Persist the exact schedule/spend envelope the user approved. Runtime provider reads may move
-- opening times, prices, and call configuration; those changes must be classified durably before
-- the worker can sign or broadcast anything.
ALTER TABLE mint_tasks
  ADD COLUMN original_opening_at TIMESTAMPTZ,
  ADD COLUMN accepted_opening_at TIMESTAMPTZ,
  ADD COLUMN last_observed_opening_at TIMESTAMPTZ,
  ADD COLUMN time_change_policy TEXT NOT NULL DEFAULT 'approval'
    CHECK (time_change_policy IN ('approval','auto_within_limit')),
  ADD COLUMN max_opening_delay_ms BIGINT
    CHECK (max_opening_delay_ms IS NULL OR max_opening_delay_ms BETWEEN 1000 AND 86400000),
  ADD COLUMN accepted_price_wei_per_item NUMERIC(78,0)
    CHECK (accepted_price_wei_per_item IS NULL OR accepted_price_wei_per_item >= 0),
  ADD COLUMN last_observed_price_wei_per_item NUMERIC(78,0)
    CHECK (last_observed_price_wei_per_item IS NULL OR last_observed_price_wei_per_item >= 0),
  ADD COLUMN price_change_policy TEXT NOT NULL DEFAULT 'approval'
    CHECK (price_change_policy IN ('approval','allow_up_to_cap')),
  ADD COLUMN max_price_wei_per_item NUMERIC(78,0)
    CHECK (max_price_wei_per_item IS NULL OR max_price_wei_per_item >= 0),
  ADD COLUMN accepted_config_fingerprint TEXT,
  ADD COLUMN last_observed_config_fingerprint TEXT,
  ADD COLUMN accepted_config_summary JSONB,
  ADD COLUMN last_observed_config_summary JSONB,
  ADD COLUMN change_state TEXT NOT NULL DEFAULT 'clear'
    CHECK (change_state IN ('clear','awaiting_approval')),
  ADD COLUMN change_version INTEGER NOT NULL DEFAULT 0 CHECK (change_version >= 0),
  ADD COLUMN pending_change JSONB,
  ADD COLUMN change_detected_at TIMESTAMPTZ,
  ADD COLUMN change_review_expires_at TIMESTAMPTZ;

-- Existing schedules keep their original opening and price as the approved baseline. OpenSea
-- builder rows historically stored zero; a later non-zero observation will therefore pause for
-- review instead of silently authorizing spend for a legacy task.
UPDATE mint_tasks
SET original_opening_at=mint_time,
    accepted_opening_at=mint_time,
    last_observed_opening_at=mint_time,
    accepted_price_wei_per_item=ROUND(COALESCE(price_eth,0) * 1000000000000000000)::NUMERIC,
    last_observed_price_wei_per_item=ROUND(COALESCE(price_eth,0) * 1000000000000000000)::NUMERIC;

-- Keep the new baseline columns nullable for one rolling-deploy window: an old process may still
-- insert a task while this migration is being applied. New writers always populate them, and the
-- readers retain the mint_time fallback. A later release may safely add NOT NULL after every old
-- instance has drained.

ALTER TABLE mint_tasks
  ADD CONSTRAINT mint_tasks_change_state_shape CHECK (
    (change_state='clear' AND pending_change IS NULL AND change_review_expires_at IS NULL)
    OR (change_state='awaiting_approval' AND status='paused' AND pending_change IS NOT NULL
      AND change_review_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT mint_tasks_time_change_policy_shape CHECK (
    time_change_policy<>'auto_within_limit' OR max_opening_delay_ms IS NOT NULL
  ),
  ADD CONSTRAINT mint_tasks_price_change_policy_shape CHECK (
    price_change_policy<>'allow_up_to_cap' OR max_price_wei_per_item IS NOT NULL
  ),
  ADD CONSTRAINT mint_tasks_accepted_config_pair CHECK (
    (accepted_config_fingerprint IS NULL) = (accepted_config_summary IS NULL)
    AND (accepted_config_summary IS NULL OR jsonb_typeof(accepted_config_summary)='object')
  ),
  ADD CONSTRAINT mint_tasks_observed_config_pair CHECK (
    (last_observed_config_fingerprint IS NULL) = (last_observed_config_summary IS NULL)
    AND (last_observed_config_summary IS NULL OR jsonb_typeof(last_observed_config_summary)='object')
  );

CREATE TABLE mint_task_change_events (
  event_id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  task_id UUID NOT NULL,
  change_version INTEGER NOT NULL CHECK (change_version > 0),
  event_fingerprint TEXT NOT NULL,
  kinds TEXT[] NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('accepted','auto_rescheduled','awaiting_approval','approved','cancelled','expired')),
  previous_snapshot JSONB NOT NULL,
  observed_snapshot JSONB NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  FOREIGN KEY (user_id,task_id) REFERENCES mint_tasks(user_id,id) ON DELETE CASCADE,
  UNIQUE (user_id,task_id,change_version)
);

CREATE INDEX mint_task_change_events_fingerprint_idx
  ON mint_task_change_events (user_id,task_id,event_fingerprint);

CREATE INDEX mint_task_change_events_task_idx
  ON mint_task_change_events (user_id,task_id,event_id DESC);

CREATE INDEX mint_tasks_change_review_idx
  ON mint_tasks (change_review_expires_at,user_id,id)
  WHERE change_state='awaiting_approval';

-- The existing durable preflight outbox also carries schedule-change notices. Keep the ordinary
-- readiness result separate: a safe price decrease and a low balance can both be true in the same
-- check, and neither fact should erase the other.
ALTER TABLE mint_task_preflight_checks
  ADD COLUMN schedule_change_action TEXT
    CHECK (schedule_change_action IS NULL OR schedule_change_action IN
      ('accepted','auto_rescheduled','awaiting_approval','expired')),
  ADD COLUMN schedule_change_version INTEGER CHECK (schedule_change_version IS NULL OR schedule_change_version > 0),
  ADD COLUMN schedule_change_reason TEXT;

-- A review that receives no answer before its bounded review deadline is a terminal, durable
-- outcome. Phase-aware tasks use their eligibility deadline; direct tasks get a 24-hour decision
-- window when the change is detected, so no paused review can remain actionable forever.
-- Reuse the preflight notification outbox, but keep the synthetic expiry row distinct from the
-- genuine five-minute and thirty-second readiness history.
ALTER TABLE mint_task_preflight_checks
  DROP CONSTRAINT mint_task_preflight_checks_checkpoint_check,
  ADD CONSTRAINT mint_task_preflight_checks_checkpoint_check
    CHECK (checkpoint IN ('five_minute','thirty_second','change_review_expiry')),
  DROP CONSTRAINT mint_task_preflight_checks_result_check,
  ADD CONSTRAINT mint_task_preflight_checks_result_check
    CHECK (result IS NULL OR result IN
      ('ready','short','price_unknown','sold_out','check_failed','review_expired'));

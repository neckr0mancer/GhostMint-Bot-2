-- A user may explicitly opt in to following the authoritative opening time of the same stage,
-- even when a project moves it to another day. Keep the old bounded policy for existing clients
-- and rows; the new policy is separate so no existing schedule is silently broadened.
ALTER TABLE mint_tasks
  DROP CONSTRAINT IF EXISTS mint_tasks_time_change_policy_check;

ALTER TABLE mint_tasks
  ADD CONSTRAINT mint_tasks_time_change_policy_check CHECK (
    time_change_policy IN ('approval','auto_within_limit','auto_follow_stage')
  );

-- Bounded legacy rows still require their explicit cap. auto_follow_stage deliberately has no
-- arbitrary delay value: stage identity/configuration and the separately-approved price cap remain
-- the authorization boundary.
ALTER TABLE mint_tasks
  DROP CONSTRAINT IF EXISTS mint_tasks_time_change_policy_shape;

ALTER TABLE mint_tasks
  ADD CONSTRAINT mint_tasks_time_change_policy_shape CHECK (
    time_change_policy<>'auto_within_limit' OR max_opening_delay_ms IS NOT NULL
  );

-- The execution retry time is not necessarily the advertised/live launch time. Keep a separate
-- semantic target and generation so a short RPC retry cannot accidentally create a second set of
-- five-minute/30-second checks, while a real phase/opening-time move can safely re-arm both.
ALTER TABLE mint_tasks
  ADD COLUMN preflight_target_at TIMESTAMPTZ,
  ADD COLUMN preflight_generation INTEGER NOT NULL DEFAULT 1
    CHECK (preflight_generation > 0);

UPDATE mint_tasks
SET preflight_target_at=COALESCE(next_attempt_at,mint_time,created_at);

ALTER TABLE mint_tasks ALTER COLUMN preflight_target_at SET NOT NULL;

CREATE TABLE mint_task_preflight_checks (
  check_id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  task_id UUID NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  target_at TIMESTAMPTZ NOT NULL,
  checkpoint TEXT NOT NULL CHECK (checkpoint IN ('five_minute','thirty_second')),
  due_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','claimed','completed','superseded')),
  result TEXT CHECK (result IS NULL OR result IN
    ('ready','short','price_unknown','sold_out','check_failed')),
  reason TEXT,
  mint_value_wei NUMERIC(78,0),
  estimated_gas_wei NUMERIC(78,0),
  total_debit_wei NUMERIC(78,0),
  balance_wei NUMERIC(78,0),
  shortfall_wei NUMERIC(78,0),
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ,
  notification_attempted_at TIMESTAMPTZ,
  notification_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (user_id,task_id) REFERENCES mint_tasks(user_id,id) ON DELETE CASCADE,
  UNIQUE (user_id,task_id,generation,checkpoint),
  CHECK (
    (state='claimed' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR state<>'claimed'
  )
);

CREATE INDEX mint_task_preflight_checks_due_idx
  ON mint_task_preflight_checks (due_at,target_at)
  WHERE state='pending';

CREATE INDEX mint_task_preflight_checks_stale_claim_idx
  ON mint_task_preflight_checks (lease_expires_at)
  WHERE state='claimed';

CREATE INDEX mint_task_preflight_checks_task_idx
  ON mint_task_preflight_checks (user_id,task_id,generation,checkpoint);

-- Existing future tasks receive durable checkpoints on migration. Tasks already inside the final
-- 30 seconds get only that final check; the old five-minute moment is not fabricated after fact.
INSERT INTO mint_task_preflight_checks
  (user_id,task_id,generation,target_at,checkpoint,due_at)
SELECT user_id,id,preflight_generation,preflight_target_at,'five_minute',
  preflight_target_at-INTERVAL '5 minutes'
FROM mint_tasks
WHERE status IN ('scheduled','retry') AND preflight_target_at>NOW()+INTERVAL '30 seconds'
UNION ALL
SELECT user_id,id,preflight_generation,preflight_target_at,'thirty_second',
  preflight_target_at-INTERVAL '30 seconds'
FROM mint_tasks
WHERE status IN ('scheduled','retry') AND preflight_target_at>NOW();

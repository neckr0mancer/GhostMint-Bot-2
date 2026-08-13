ALTER TABLE transaction_intents ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX transaction_intents_idempotency_key_unique
  ON transaction_intents (idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE mint_tasks
  ADD COLUMN next_attempt_at TIMESTAMPTZ,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN claimed_by TEXT,
  ADD COLUMN claimed_at TIMESTAMPTZ,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN transaction_intent_id UUID REFERENCES transaction_intents(intent_id) ON DELETE SET NULL,
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN last_error TEXT,
  ADD COLUMN completed_at TIMESTAMPTZ;

UPDATE mint_tasks SET
  status = CASE status
    WHEN 'done' THEN 'succeeded'
    WHEN 'running' THEN 'retry'
    WHEN 'failed' THEN 'failed'
    ELSE 'scheduled'
  END,
  next_attempt_at = mint_time,
  idempotency_key = 'scheduled-mint:' || user_id || ':' || id;

ALTER TABLE mint_tasks
  ALTER COLUMN next_attempt_at SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ADD CONSTRAINT mint_tasks_status_check CHECK (status IN ('scheduled','claimed','retry','paused','cancelled','succeeded','failed')),
  ADD CONSTRAINT mint_tasks_claim_check CHECK (
    (status='claimed' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status<>'claimed'
  );

CREATE UNIQUE INDEX mint_tasks_idempotency_key_unique ON mint_tasks (idempotency_key);
CREATE INDEX mint_tasks_due_claim_idx ON mint_tasks (next_attempt_at, mint_time)
  WHERE status IN ('scheduled','retry');
CREATE INDEX mint_tasks_stale_claim_idx ON mint_tasks (lease_expires_at)
  WHERE status='claimed';
CREATE INDEX mint_tasks_intent_idx ON mint_tasks (transaction_intent_id)
  WHERE transaction_intent_id IS NOT NULL;

CREATE TABLE mint_task_attempts (
  attempt_id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  task_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('running','success','failure','retry','recovered')),
  reason TEXT,
  transaction_intent_id UUID REFERENCES transaction_intents(intent_id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  FOREIGN KEY (user_id,task_id) REFERENCES mint_tasks(user_id,id) ON DELETE CASCADE,
  UNIQUE (user_id,task_id,attempt_number)
);

CREATE INDEX mint_task_attempts_task_idx
  ON mint_task_attempts (user_id,task_id,attempt_number DESC);

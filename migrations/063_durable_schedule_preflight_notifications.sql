-- A completed readiness check and its user notification are separate facts. Persist notification
-- delivery as a bounded outbox so a crash after the check commit cannot silently lose the alert.
ALTER TABLE mint_task_preflight_checks
  ADD COLUMN notification_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_state IN ('pending','claimed','delivered','failed')),
  ADD COLUMN notification_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (notification_attempts >= 0),
  ADD COLUMN notification_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN notification_claimed_by TEXT,
  ADD COLUMN notification_claimed_at TIMESTAMPTZ,
  ADD COLUMN notification_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN notification_delivered_at TIMESTAMPTZ,
  ADD CONSTRAINT mint_task_preflight_notification_claim_check CHECK (
    (notification_state='claimed' AND notification_claimed_by IS NOT NULL
      AND notification_claimed_at IS NOT NULL AND notification_lease_expires_at IS NOT NULL)
    OR notification_state<>'claimed'
  );

-- Preserve the outcome of any checkpoint delivered by the pre-outbox implementation. Failed or
-- interrupted deliveries remain pending and are safely retried by the new worker.
UPDATE mint_task_preflight_checks
SET notification_state=CASE
      WHEN notification_attempted_at IS NOT NULL AND notification_error IS NULL THEN 'delivered'
      ELSE 'pending'
    END,
    notification_attempts=CASE WHEN notification_attempted_at IS NULL THEN 0 ELSE 1 END,
    notification_next_attempt_at=COALESCE(notification_attempted_at,NOW()),
    notification_delivered_at=CASE
      WHEN notification_attempted_at IS NOT NULL AND notification_error IS NULL
      THEN notification_attempted_at ELSE NULL END;

CREATE INDEX mint_task_preflight_notification_due_idx
  ON mint_task_preflight_checks (notification_next_attempt_at,check_id)
  WHERE state='completed' AND notification_state='pending';

CREATE INDEX mint_task_preflight_notification_stale_claim_idx
  ON mint_task_preflight_checks (notification_lease_expires_at,check_id)
  WHERE state='completed' AND notification_state='claimed';

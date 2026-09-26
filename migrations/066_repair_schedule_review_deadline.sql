-- Migration 065 was exercised in a temporary Railway database before its final review-expiry
-- column was added. That database therefore records 065 as applied but cannot receive later edits
-- to the same filename. Repair the drift forward; never rewrite migration history in place.
ALTER TABLE mint_tasks
  ADD COLUMN IF NOT EXISTS change_review_expires_at TIMESTAMPTZ;

-- A review must always be bounded. Preserve a phase-aware task's eligibility deadline when it is
-- sooner; otherwise give the already-detected change the same 24-hour decision window used by the
-- current worker. A missing historical detection timestamp is conservatively measured from now.
UPDATE mint_tasks
SET change_review_expires_at=CASE
  WHEN eligibility_deadline IS NOT NULL THEN
    LEAST(eligibility_deadline,COALESCE(change_detected_at,NOW())+INTERVAL '24 hours')
  ELSE COALESCE(change_detected_at,NOW())+INTERVAL '24 hours'
END
WHERE change_state='awaiting_approval'
  AND pending_change IS NOT NULL
  AND change_review_expires_at IS NULL;

-- Add a new, uniquely named invariant instead of dropping the older constraint during a rolling
-- deploy. Fresh databases already have the stronger 065 constraint; the extra check is harmless.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='mint_tasks_change_review_deadline_shape'
      AND conrelid='mint_tasks'::regclass
  ) THEN
    ALTER TABLE mint_tasks
      ADD CONSTRAINT mint_tasks_change_review_deadline_shape CHECK (
        (change_state='clear' AND change_review_expires_at IS NULL)
        OR (change_state='awaiting_approval' AND change_review_expires_at IS NOT NULL)
      );
  END IF;
END $$;

-- Fresh databases already receive this exact index from migration 065. The temporarily drifted
-- database has an older same-named index with different columns, so create the repair index only
-- when no equivalent index definition exists; this avoids duplicate write/storage overhead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname=current_schema()
      AND tablename='mint_tasks'
      AND indexdef ILIKE '%(change_review_expires_at, user_id, id)%'
      AND indexdef ILIKE '%change_state%awaiting_approval%'
  ) THEN
    CREATE INDEX mint_tasks_change_review_deadline_idx
      ON mint_tasks (change_review_expires_at,user_id,id)
      WHERE change_state='awaiting_approval';
  END IF;
END $$;

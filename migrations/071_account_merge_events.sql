CREATE OR REPLACE FUNCTION account_merge_is_nonnegative_count_map(candidate JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(candidate) <> 'object' THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_each(candidate) AS entry(entry_key, entry_value)
      WHERE entry_key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
        OR jsonb_typeof(entry_value) <> 'number'
        OR entry_value::TEXT !~ '^(0|[1-9][0-9]*)$'
    )
  END
$function$;

CREATE OR REPLACE FUNCTION account_merge_are_identity_snapshots(candidate JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(candidate) <> 'array' OR jsonb_array_length(candidate) = 0 THEN FALSE
    ELSE
      NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(candidate) AS snapshot(identity_snapshot)
        WHERE jsonb_typeof(identity_snapshot) <> 'object'
          OR NOT identity_snapshot ?& ARRAY['platform', 'platformUserId', 'linkedAt']
          OR identity_snapshot - ARRAY['platform', 'platformUserId', 'linkedAt'] <> '{}'::JSONB
          OR jsonb_typeof(identity_snapshot->'platform') <> 'string'
          OR jsonb_typeof(identity_snapshot->'platformUserId') <> 'string'
          OR jsonb_typeof(identity_snapshot->'linkedAt') <> 'string'
          OR identity_snapshot->>'platform' NOT IN ('telegram', 'discord')
          OR BTRIM(identity_snapshot->>'platformUserId') = ''
          OR BTRIM(identity_snapshot->>'linkedAt') = ''
      )
      AND (
        SELECT COUNT(*) = COUNT(DISTINCT identity_snapshot->>'platform')
        FROM jsonb_array_elements(candidate) AS snapshot(identity_snapshot)
      )
  END
$function$;

CREATE TABLE account_merge_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_schema_version SMALLINT NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  outcome_code TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  source_user_id UUID NOT NULL,
  target_user_id UUID NOT NULL,
  actor_identities JSONB NOT NULL,
  source_identities_before JSONB NOT NULL,
  target_identities_before JSONB NOT NULL,
  target_identities_after JSONB NOT NULL,
  plan_version INTEGER NOT NULL,
  plan_digest TEXT NOT NULL,
  resolution_map JSONB NOT NULL DEFAULT '{}'::JSONB,
  moved_counts JSONB NOT NULL DEFAULT '{}'::JSONB,
  revoked_counts JSONB NOT NULL DEFAULT '{}'::JSONB,
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  requested_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT account_merge_events_idempotency_key_check
    CHECK (
      idempotency_key = BTRIM(idempotency_key)
      AND LENGTH(idempotency_key) BETWEEN 16 AND 200
      AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$'
    ),
  CONSTRAINT account_merge_events_schema_version_check
    CHECK (event_schema_version = 1),
  CONSTRAINT account_merge_events_status_check
    CHECK (status IN ('committed', 'already_unified', 'rejected')),
  CONSTRAINT account_merge_events_outcome_code_check
    CHECK (outcome_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT account_merge_events_identity_snapshots_check
    CHECK (
      account_merge_are_identity_snapshots(actor_identities)
      AND account_merge_are_identity_snapshots(source_identities_before)
      AND account_merge_are_identity_snapshots(target_identities_before)
      AND account_merge_are_identity_snapshots(target_identities_after)
    ),
  CONSTRAINT account_merge_events_plan_check
    CHECK (
      plan_version > 0
      AND plan_digest ~ '^sha256:[0-9a-f]{64}$'
    ),
  CONSTRAINT account_merge_events_resolution_map_check
    CHECK (jsonb_typeof(resolution_map) = 'object'),
  CONSTRAINT account_merge_events_moved_counts_check
    CHECK (account_merge_is_nonnegative_count_map(moved_counts)),
  CONSTRAINT account_merge_events_revoked_counts_check
    CHECK (account_merge_is_nonnegative_count_map(revoked_counts)),
  CONSTRAINT account_merge_events_evidence_check
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT account_merge_events_timeline_check
    CHECK (
      requested_at <= started_at
      AND started_at <= finished_at
      AND finished_at <= recorded_at
    ),
  CONSTRAINT account_merge_events_terminal_shape_check
    CHECK (
      (status = 'committed' AND source_user_id <> target_user_id)
      OR (
        status = 'already_unified'
        AND source_user_id = target_user_id
        AND moved_counts = '{}'::JSONB
        AND revoked_counts = '{}'::JSONB
      )
      OR (
        status = 'rejected'
        AND moved_counts = '{}'::JSONB
        AND revoked_counts = '{}'::JSONB
      )
    )
);

CREATE INDEX account_merge_events_actor_timeline_idx
  ON account_merge_events(actor_user_id, recorded_at DESC);
CREATE INDEX account_merge_events_source_timeline_idx
  ON account_merge_events(source_user_id, recorded_at DESC);
CREATE INDEX account_merge_events_target_timeline_idx
  ON account_merge_events(target_user_id, recorded_at DESC);
CREATE INDEX account_merge_events_plan_digest_idx
  ON account_merge_events(plan_digest);

COMMENT ON TABLE account_merge_events IS
  'Immutable terminal evidence for account reconciliation. UUID columns are historical snapshots and intentionally have no cascading identity relationship.';
COMMENT ON COLUMN account_merge_events.idempotency_key IS
  'Server-generated request key. One terminal event is allowed for each merge request.';

CREATE OR REPLACE FUNCTION reject_account_merge_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'account_merge_events is append-only'
    USING ERRCODE = '55000';
  RETURN NULL;
END
$function$;

CREATE TRIGGER account_merge_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON account_merge_events
FOR EACH STATEMENT
EXECUTE FUNCTION reject_account_merge_event_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE account_merge_events FROM PUBLIC;

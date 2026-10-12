const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.join(
  __dirname,
  '..',
  'migrations',
  '071_account_merge_events.sql',
), 'utf8');

test('account merge evidence is terminal, self-contained, and independent of account deletion', () => {
  assert.match(migration, /CREATE TABLE account_merge_events/);
  for (const column of [
    'event_schema_version',
    'idempotency_key',
    'actor_user_id',
    'source_user_id',
    'target_user_id',
    'source_identities_before',
    'target_identities_before',
    'target_identities_after',
    'plan_version',
    'plan_digest',
    'resolution_map',
    'moved_counts',
    'revoked_counts',
    'evidence',
  ]) assert.match(migration, new RegExp(`\\b${column}\\b`));

  assert.doesNotMatch(migration, /REFERENCES\s+users/i,
    'historical merge evidence must survive deletion of actor, source, and target accounts');
  assert.match(migration, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(migration, /idempotency_key ~ '\^\[A-Za-z0-9\]/);
  assert.match(migration, /event_schema_version = 1/);
  assert.match(migration, /status IN \('committed', 'already_unified', 'rejected'\)/);
  assert.match(migration, /plan_digest ~ '\^sha256:\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /account_merge_is_nonnegative_count_map\(moved_counts\)/);
  assert.match(migration, /account_merge_is_nonnegative_count_map\(revoked_counts\)/);
  assert.match(migration, /account_merge_are_identity_snapshots\(actor_identities\)/);
  assert.match(migration, /identity_snapshot - ARRAY\['platform', 'platformUserId', 'linkedAt'\]/);
  assert.match(migration, /jsonb_typeof\(identity_snapshot->'platformUserId'\) <> 'string'/);
});

test('account merge evidence rejects mutation even when the application role owns the table', () => {
  assert.match(migration,
    /BEFORE UPDATE OR DELETE OR TRUNCATE ON account_merge_events[\s\S]*FOR EACH STATEMENT[\s\S]*reject_account_merge_event_mutation\(\)/);
  assert.match(migration, /ERRCODE = '55000'/);
  assert.match(migration,
    /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE account_merge_events FROM PUBLIC/);
});

test('account merge evidence records only internally consistent terminal outcomes', () => {
  assert.match(migration, /requested_at <= started_at/);
  assert.match(migration, /started_at <= finished_at/);
  assert.match(migration, /finished_at <= recorded_at/);
  assert.match(migration, /status = 'committed' AND source_user_id <> target_user_id/);
  assert.match(migration, /status = 'already_unified'[\s\S]*source_user_id = target_user_id/);
  assert.match(migration, /status = 'rejected'[\s\S]*moved_counts = '\{\}'::JSONB/);
});

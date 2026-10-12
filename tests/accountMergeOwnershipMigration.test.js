const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sql = fs.readFileSync(path.join(
  __dirname,
  '..',
  'migrations',
  '072_account_merge_ownership_fks.sql',
), 'utf8');
const repository = fs.readFileSync(path.join(
  __dirname,
  '..',
  'src',
  'identity',
  'postgresIdentityRepository.js',
), 'utf8');

test('legacy launch squad ownership is locked, validated, converted, and constrained', () => {
  const lock = sql.indexOf('LOCK TABLE launch_squads IN ACCESS EXCLUSIVE MODE');
  const invalidUuid = sql.indexOf('launch_squads contains a non-UUID user_id');
  const orphan = sql.indexOf('launch_squads contains an orphan user_id');
  const conversion = sql.indexOf('ALTER COLUMN user_id TYPE UUID USING user_id::UUID');
  assert.ok(lock >= 0 && lock < invalidUuid && invalidUuid < orphan && orphan < conversion,
    'validation must run under a write-blocking lock before the type change');
  assert.match(sql, /FOREIGN KEY \(user_id\) REFERENCES users\(user_id\)[\s\S]*ON UPDATE CASCADE ON DELETE RESTRICT/);
  assert.doesNotMatch(repository, /launch_squads[^`'\n]*user_id=\$1::TEXT/,
    'application reads must remain compatible when the owner column becomes UUID');
  assert.match(repository, /launch_squads WHERE user_id::TEXT=\$1/);
});

test('all seven composite ownership foreign keys cascade owner updates without widening deletes', () => {
  const cascadeDeletes = [
    ['sniper_event_transitions', 'sniper_seen_transactions'],
    ['sniper_seen_transactions', 'snipers'],
    ['mint_task_attempts', 'mint_tasks'],
    ['mint_task_preflight_checks', 'mint_tasks'],
    ['mint_task_change_events', 'mint_tasks'],
    ['opensea_wallet_eligibility_authorizations', 'wallets'],
  ];
  for (const [table, parent] of cascadeDeletes) {
    assert.match(sql, new RegExp(
      `ALTER TABLE ${table}[\\s\\S]*?REFERENCES ${parent}\\([^;]+ON UPDATE CASCADE ON DELETE CASCADE NOT VALID`,
    ));
  }
  assert.match(sql,
    /ALTER TABLE live_acceptance_runs[\s\S]*?REFERENCES wallets\(user_id, id\)[\s\S]*?ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID/);

  const validateCount = (sql.match(/VALIDATE CONSTRAINT [a-z0-9_]+_merge_fkey/g) || []).length;
  assert.equal(validateCount, 7);
  assert.doesNotMatch(sql, /ALTER TABLE transaction_intents/,
    'the intentionally independent intent and wallet ownership constraints must not be rewritten here');
});

test('replacement constraints retain their established public names', () => {
  for (const constraint of [
    'sniper_event_transitions_user_id_sniper_id_tx_hash_fkey',
    'sniper_seen_transactions_owner_fkey',
    'mint_task_attempts_user_id_task_id_fkey',
    'mint_task_preflight_checks_user_id_task_id_fkey',
    'mint_task_change_events_user_id_task_id_fkey',
    'live_acceptance_runs_wallet_fkey',
    'opensea_wallet_eligibility_wallet_owner_fk',
  ]) {
    assert.match(sql, new RegExp(`DROP CONSTRAINT ${constraint}`));
    assert.match(sql, new RegExp(`TO ${constraint}`));
  }
});

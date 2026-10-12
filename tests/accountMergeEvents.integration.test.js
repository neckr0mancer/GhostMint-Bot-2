const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { CONFIG } = require('../src/config');
const {
  createTestDatabasePool,
  integrationTest,
  runTestMigrations,
} = require('./helpers/disposableDatabase');

function mergeEvent(overrides = {}) {
  const now = Date.now();
  const linkedAt = new Date(now - 60_000).toISOString();
  return {
    idempotencyKey: `account-merge:${randomUUID()}`,
    status: 'committed',
    outcomeCode: 'MERGE_COMMITTED',
    actorUserId: randomUUID(),
    sourceUserId: randomUUID(),
    targetUserId: randomUUID(),
    actorIdentities: [{ platform: 'telegram', platformUserId: 'owner-test', linkedAt }],
    sourceIdentitiesBefore: [{ platform: 'discord', platformUserId: 'source-test', linkedAt }],
    targetIdentitiesBefore: [{ platform: 'telegram', platformUserId: 'target-test', linkedAt }],
    targetIdentitiesAfter: [
      { platform: 'discord', platformUserId: 'source-test', linkedAt },
      { platform: 'telegram', platformUserId: 'target-test', linkedAt },
    ],
    planVersion: 2,
    planDigest: `sha256:${'a'.repeat(64)}`,
    resolutionMap: { wallets: 'no_collision' },
    movedCounts: { linkedAccounts: 1, wallets: 2 },
    revokedCounts: { accountLinkCodes: 1, dashboardSessions: 2 },
    evidence: { catalogVersion: 71 },
    requestedAt: new Date(now - 3_000),
    startedAt: new Date(now - 2_000),
    finishedAt: new Date(now - 1_000),
    ...overrides,
  };
}

function insertEvent(pool, event) {
  return pool.query({
    text: `INSERT INTO account_merge_events (
      idempotency_key, status, outcome_code,
      actor_user_id, source_user_id, target_user_id,
      actor_identities, source_identities_before,
      target_identities_before, target_identities_after,
      plan_version, plan_digest, resolution_map,
      moved_counts, revoked_counts, evidence,
      requested_at, started_at, finished_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7::JSONB, $8::JSONB, $9::JSONB, $10::JSONB,
      $11, $12, $13::JSONB, $14::JSONB, $15::JSONB, $16::JSONB,
      $17, $18, $19
    ) RETURNING event_id, idempotency_key, status, source_user_id, target_user_id`,
    values: [
      event.idempotencyKey, event.status, event.outcomeCode,
      event.actorUserId, event.sourceUserId, event.targetUserId,
      JSON.stringify(event.actorIdentities), JSON.stringify(event.sourceIdentitiesBefore),
      JSON.stringify(event.targetIdentitiesBefore), JSON.stringify(event.targetIdentitiesAfter),
      event.planVersion, event.planDigest, JSON.stringify(event.resolutionMap),
      JSON.stringify(event.movedCounts), JSON.stringify(event.revokedCounts),
      JSON.stringify(event.evidence), event.requestedAt, event.startedAt, event.finishedAt,
    ],
  });
}

function expectSqlState(code) {
  return error => {
    assert.equal(error.code, code);
    return true;
  };
}

integrationTest('account merge terminal evidence survives account deletion and is immutable',
  { timeout: 120_000 }, async () => {
    await runTestMigrations({ migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations') });
    const pool = await createTestDatabasePool({ max: 2 });
    const event = mergeEvent();
    try {
      await pool.query(
        'INSERT INTO users(user_id) VALUES ($1), ($2), ($3)',
        [event.actorUserId, event.sourceUserId, event.targetUserId],
      );
      const inserted = await insertEvent(pool, event);
      assert.equal(inserted.rows[0].status, 'committed');

      await pool.query(
        'DELETE FROM users WHERE user_id = ANY($1::UUID[])',
        [[event.actorUserId, event.sourceUserId, event.targetUserId]],
      );
      const preserved = await pool.query(
        'SELECT idempotency_key, source_user_id, target_user_id FROM account_merge_events WHERE event_id=$1',
        [inserted.rows[0].event_id],
      );
      assert.equal(preserved.rowCount, 1);
      assert.equal(preserved.rows[0].idempotency_key, event.idempotencyKey);

      await assert.rejects(
        pool.query('UPDATE account_merge_events SET outcome_code=$2 WHERE event_id=$1',
          [inserted.rows[0].event_id, 'TAMPERED']),
        expectSqlState('55000'),
      );
      await assert.rejects(
        pool.query('DELETE FROM account_merge_events WHERE event_id=$1', [inserted.rows[0].event_id]),
        expectSqlState('55000'),
      );
      await assert.rejects(
        pool.query('TRUNCATE TABLE account_merge_events'),
        expectSqlState('55000'),
      );

      await assert.rejects(insertEvent(pool, event), expectSqlState('23505'));
      await assert.rejects(insertEvent(pool, mergeEvent({ movedCounts: { wallets: -1 } })),
        expectSqlState('23514'));
      await assert.rejects(insertEvent(pool, mergeEvent({
        actorIdentities: [{ platform: 'telegram', platformUserId: 'owner-test', privateKey: 'forbidden' }],
      })), expectSqlState('23514'));

      const concurrent = mergeEvent();
      const outcomes = await Promise.allSettled([
        insertEvent(pool, concurrent),
        insertEvent(pool, concurrent),
      ]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      const rejection = outcomes.find(result => result.status === 'rejected');
      assert.equal(rejection?.reason?.code, '23505');
    } finally {
      await pool.end();
    }
  });

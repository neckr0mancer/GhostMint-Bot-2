const assert = require('node:assert/strict');
const test = require('node:test');
const { acquireTelegramPollingLock, POLLING_LOCK_KEY } = require('../src/security/telegramSingleInstanceLock');

function fakePool() {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, params) { queries.push({ sql, params }); },
    release() { released = true; },
  };
  return { queries, client, isReleased: () => released, async connect() { return client; } };
}

test('acquires the advisory lock on a dedicated connection using the stable, exported key', async () => {
  const pool = fakePool();
  await acquireTelegramPollingLock(pool);
  assert.equal(pool.queries.length, 1);
  assert.match(pool.queries[0].sql, /pg_advisory_lock/);
  assert.deepEqual(pool.queries[0].params, [POLLING_LOCK_KEY]);
});

test('release() unlocks and returns the client to the pool', async () => {
  const pool = fakePool();
  const release = await acquireTelegramPollingLock(pool);
  await release();
  assert.equal(pool.queries.length, 2);
  assert.match(pool.queries[1].sql, /pg_advisory_unlock/);
  assert.deepEqual(pool.queries[1].params, [POLLING_LOCK_KEY]);
  assert.equal(pool.isReleased(), true);
});

test('release() is idempotent -- calling it twice only unlocks once', async () => {
  const pool = fakePool();
  const release = await acquireTelegramPollingLock(pool);
  await release();
  await release();
  assert.equal(pool.queries.filter(q => /pg_advisory_unlock/.test(q.sql)).length, 1);
});

test('does not resolve until the pg_advisory_lock query itself resolves -- Postgres blocks that query server-side while another session holds the lock, which is what actually serializes two GhostMint instances during a Railway deploy overlap', async () => {
  let queryResolved = false;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (!/pg_advisory_lock/.test(sql)) return;
          await new Promise(resolve => setTimeout(resolve, 20));
          queryResolved = true;
        },
        release() {},
      };
    },
  };
  await acquireTelegramPollingLock(pool);
  assert.equal(queryResolved, true);
});

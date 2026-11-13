const assert = require('node:assert/strict');
const test = require('node:test');
const { createPostgresStorage } = require('../src/storage/postgresStorage');

function createActivityStorage() {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{
        id: calls.length,
        user_id: params[0],
        status: params[1],
        title: params[2],
        wallet_label: params[3],
        tx_hash: params[4],
        explorer: params[5],
        occurred_at: new Date(params[6]),
        actual_network_cost_wei: params[7],
        trigger_source: params[8],
        verification_state: params[9],
        address: params[10],
      }] };
    },
  };
  return { calls, storage: createPostgresStorage(pool) };
}

test('addActivity accepts occurredAt while preserving the legacy time field', async () => {
  const { calls, storage } = createActivityStorage();
  const occurredAt = 1_729_000_000_123;
  const legacyTime = occurredAt + 1_000;

  const current = await storage.addActivity({
    userId: 'user-a', status: 'success', title: 'Current activity', walletLabel: null,
    txHash: null, explorer: null, occurredAt,
  });
  const legacy = await storage.addActivity({
    userId: 'user-a', status: 'success', title: 'Legacy activity', walletLabel: null,
    txHash: null, explorer: null, time: legacyTime,
  });

  assert.equal(calls[0].params[6], occurredAt);
  assert.equal(current.time, occurredAt);
  assert.equal(calls[1].params[6], legacyTime);
  assert.equal(legacy.time, legacyTime);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { guidedTaskInput, scheduleTaskFromGuidedFlow } = require('../src/scheduler/taskCommandAdapter');

test('guided task input preserves stage and change-policy data for both bot surfaces', () => {
  const input = guidedTaskInput({
    name: 'Launch', walletLabel: 'Trading', contractAddress: '0x0000000000000000000000000000000000000011',
    chain: 'ethereum', quantity: 2, priceETH: 0.01, mintTime: '2030-01-02T03:04:05.000Z',
    viaOpenSea: true, stageUuid: 'stage-1', stageLabel: 'Allowlist', stageType: 'allowlist',
    eligibilityMode: 'selected_stage', eligibilityDeadline: '2030-01-03T03:04:05.000Z',
    autoReschedule: true, acceptPriceChanges: true, expectedPriceWeiPerItem: '100',
    maxPriceWeiPerItem: '200',
  });
  assert.deepEqual(input, {
    name: 'Launch', walletLabel: 'Trading', contractAddress: '0x0000000000000000000000000000000000000011',
    chain: 'ethereum', quantity: 2, priceETH: 0.01, mintTime: '2030-01-02T03:04:05.000Z',
    viaOpenSea: true, stageUuid: 'stage-1', stageLabel: 'Allowlist', stageType: 'allowlist',
    eligibilityMode: 'selected_stage', eligibilityDeadline: '2030-01-03T03:04:05.000Z',
    autoReschedule: true, acceptPriceChanges: true, expectedPriceWeiPerItem: '100',
    maxPriceWeiPerItem: '200',
  });
});

test('guided bot scheduling rate-limits and creates against the canonical user', async () => {
  const calls = [];
  const task = await scheduleTaskFromGuidedFlow({
    platform: 'telegram', userId: 'canonical-user',
    flowData: { name: 'Launch', quantity: 0 },
    rateLimiter: { check: (...args) => calls.push(['rate', ...args]) },
    commands: { createTask: async (...args) => { calls.push(['create', ...args]); return { id: 'task-1' }; } },
  });
  assert.equal(task.id, 'task-1');
  assert.deepEqual(calls[0], ['rate', 'telegram', 'canonical-user', 'task']);
  assert.equal(calls[1][0], 'create');
  assert.equal(calls[1][1], 'canonical-user');
  assert.equal(calls[1][2].quantity, 1);
});

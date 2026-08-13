const assert = require('node:assert/strict');
const test = require('node:test');
const { findOwnedTask, findOwnedWallet, stateForUser } = require('../src/identity/ownership');

const state = {
  wallets: [
    { userId: 'user-a', label: 'alpha' },
    { userId: 'user-b', label: 'beta' },
  ],
  tasks: [
    { userId: 'user-a', id: 101 },
    { userId: 'user-b', id: 202 },
  ],
  activity: [{ userId: 'user-a' }, { userId: 'user-b' }],
  pnl: [{ userId: 'user-a' }, { userId: 'user-b' }],
  snipers: [{ userId: 'user-a' }, { userId: 'user-b' }],
};

test('Telegram list commands expose only the resolved user state', () => {
  const visible = stateForUser(state, 'user-a');
  assert.deepEqual(visible.wallets.map(item => item.label), ['alpha']);
  assert.deepEqual(visible.tasks.map(item => item.id), [101]);
  assert.equal(visible.activity.length, 1);
  assert.equal(visible.pnl.length, 1);
  assert.equal(visible.snipers.length, 1);
});

test('Telegram mutation commands cannot select another user wallet or task by guessed identifier', () => {
  assert.equal(findOwnedWallet(state, 'user-a', 'beta'), null);
  assert.equal(findOwnedTask(state, 'user-a', 202), null);
  assert.equal(findOwnedWallet(state, 'user-a', 'ALPHA').label, 'alpha');
  assert.equal(findOwnedTask(state, 'user-a', 101).id, 101);
});

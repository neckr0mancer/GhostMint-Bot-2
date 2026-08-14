const assert = require('node:assert/strict');
const test = require('node:test');
const { createFlowStateStore } = require('../src/telegram/flowState');

test('no active flow returns null until one is started', () => {
  const store = createFlowStateStore();
  assert.equal(store.get('telegram', 'chat-1'), null);
  const started = store.start('telegram', 'chat-1', 'wallet_create', 'awaiting_label');
  assert.equal(started.flow, 'wallet_create');
  assert.equal(started.step, 'awaiting_label');
  assert.deepEqual(store.get('telegram', 'chat-1').data, {});
});

test('flows are isolated per platform and per chat', () => {
  const store = createFlowStateStore();
  store.start('telegram', 'chat-1', 'wallet_create', 'awaiting_label');
  assert.equal(store.get('telegram', 'chat-2'), null);
  assert.equal(store.get('discord', 'chat-1'), null);
});

test('advance merges new data and moves the step without needing confirmation', () => {
  const store = createFlowStateStore();
  store.start('telegram', 'chat-1', 'wallet_create', 'awaiting_label', { label: null });
  const advanced = store.advance('telegram', 'chat-1', 'awaiting_chain', { label: 'main' });
  assert.equal(advanced.step, 'awaiting_chain');
  assert.deepEqual(advanced.data, { label: 'main' });
  const further = store.advance('telegram', 'chat-1', 'confirm', { chain: 'ethereum' });
  assert.deepEqual(further.data, { label: 'main', chain: 'ethereum' });
});

test('advance on a chat with no flow is a no-op', () => {
  const store = createFlowStateStore();
  assert.equal(store.advance('telegram', 'chat-1', 'anything'), null);
});

test('pending-cancel toggles independently of the flow step', () => {
  const store = createFlowStateStore();
  store.start('telegram', 'chat-1', 'wallet_create', 'awaiting_label');
  const marked = store.markPendingCancel('telegram', 'chat-1');
  assert.equal(marked.pendingCancel, true);
  const cleared = store.clearPendingCancel('telegram', 'chat-1');
  assert.equal(cleared.pendingCancel, false);
  assert.equal(cleared.step, 'awaiting_label');
});

test('clear fully removes the flow, leaving nothing behind', () => {
  const store = createFlowStateStore();
  store.start('telegram', 'chat-1', 'wallet_create', 'awaiting_label');
  store.clear('telegram', 'chat-1');
  assert.equal(store.get('telegram', 'chat-1'), null);
  assert.equal(store.advance('telegram', 'chat-1', 'x'), null);
});

test('a flow older than the TTL is treated as gone and is swept from the store', () => {
  let now = 0;
  const store = createFlowStateStore({ ttlMs: 1_000, now: () => now });
  store.start('telegram', 'chat-1', 'wallet_create', 'awaiting_label');
  now = 500;
  assert.ok(store.get('telegram', 'chat-1'));
  now = 1_500;
  assert.equal(store.get('telegram', 'chat-1'), null);
  now = 1_600;
  assert.equal(store.advance('telegram', 'chat-1', 'x'), null);
});

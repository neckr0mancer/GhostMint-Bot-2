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

// Regression test: advance/markPendingCancel/clearPendingCancel used to read the map directly
// without checking expiry themselves, trusting that a caller had already called get() (which does
// check) first. Every real call site happens to follow that order, but the store didn't enforce it
// itself -- calling advance() on an expired entry with no prior get() would have silently resurrected
// a flow that should have been gone. This calls advance() first, with no preceding get(), to prove
// expiry is self-enforced rather than borrowed from caller discipline.
test('advance (and the pending-cancel toggles) refuse an expired flow even without a prior get()', () => {
  let now = 0;
  const store = createFlowStateStore({ ttlMs: 1_000, now: () => now });
  store.start('telegram', 'chat-1', 'wallet_create', 'awaiting_label');
  now = 1_500;
  assert.equal(store.advance('telegram', 'chat-1', 'awaiting_chain'), null,
    'advance must not resurrect an expired flow just because get() was never called on it');
  assert.equal(store.get('telegram', 'chat-1'), null, 'the expired entry must actually be gone, not merely rejected');

  store.start('telegram', 'chat-2', 'wallet_import', 'awaiting_label');
  now = 3_000;
  assert.equal(store.markPendingCancel('telegram', 'chat-2'), null);
  assert.equal(store.clearPendingCancel('telegram', 'chat-2'), null);
});

// Regression test: `flows` only shed an entry via clear() or a get() call that happened to land on
// an already-expired key -- a chat that starts a flow and never interacts again left its entry in
// memory forever. sweepThreshold is set low here since the real default (10,000) isn't practical to
// reach in a unit test.
test('flow entries that have fully aged out are pruned once the store grows large, not kept forever', () => {
  let now = 0;
  const store = createFlowStateStore({ ttlMs: 100, now: () => now, sweepThreshold: 3 });
  store.start('telegram', 'stale-1', 'wallet_create', 'awaiting_label');
  store.start('telegram', 'stale-2', 'wallet_create', 'awaiting_label');
  now = 1_000; // both flows above are now well past ttlMs=100
  store.start('telegram', 'fresh', 'wallet_create', 'awaiting_label'); // brings size to 3 == sweepThreshold
  // start() checks size before adding its own key, so the sweep fires on the NEXT start() once size
  // has already reached the threshold, not the call that reached it.
  store.start('telegram', 'trigger-sweep', 'wallet_create', 'awaiting_label');
  assert.ok(store.get('telegram', 'fresh'), 'a still-live flow must survive the sweep');
  assert.equal(store.get('telegram', 'stale-1'), null);
  assert.equal(store.get('telegram', 'stale-2'), null);
});

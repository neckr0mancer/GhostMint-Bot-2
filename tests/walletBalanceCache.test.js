const assert = require('node:assert/strict');
const test = require('node:test');
const { createWalletBalanceCache } = require('../src/commands/walletBalanceCache');

test('a miss returns null until set() stores a value', () => {
  const cache = createWalletBalanceCache();
  assert.equal(cache.get('user-a', 'main'), null);
  cache.set('user-a', 'main', [{ chain: 'ethereum', balance: '1.0' }]);
  assert.deepEqual(cache.get('user-a', 'main'), [{ chain: 'ethereum', balance: '1.0' }]);
});

test('entries are isolated per user and per wallet label', () => {
  const cache = createWalletBalanceCache();
  cache.set('user-a', 'main', ['a-main']);
  cache.set('user-a', 'second', ['a-second']);
  cache.set('user-b', 'main', ['b-main']);
  assert.deepEqual(cache.get('user-a', 'main'), ['a-main']);
  assert.deepEqual(cache.get('user-a', 'second'), ['a-second']);
  assert.deepEqual(cache.get('user-b', 'main'), ['b-main']);
});

test('an entry older than the TTL is treated as a miss', () => {
  let now = 0;
  const cache = createWalletBalanceCache({ ttlMs: 1_000, now: () => now });
  cache.set('user-a', 'main', ['fresh']);
  now = 500;
  assert.deepEqual(cache.get('user-a', 'main'), ['fresh']);
  now = 1_500;
  assert.equal(cache.get('user-a', 'main'), null);
});

test('invalidate clears a specific entry without touching others', () => {
  const cache = createWalletBalanceCache();
  cache.set('user-a', 'main', ['a-main']);
  cache.set('user-a', 'second', ['a-second']);
  cache.invalidate('user-a', 'main');
  assert.equal(cache.get('user-a', 'main'), null);
  assert.deepEqual(cache.get('user-a', 'second'), ['a-second']);
});

test('invalidating a key that was never set is a safe no-op', () => {
  const cache = createWalletBalanceCache();
  assert.doesNotThrow(() => cache.invalidate('user-a', 'never-set'));
});

test('entries that have fully aged out are pruned once the store grows large, not kept forever', () => {
  let now = 0;
  const cache = createWalletBalanceCache({ ttlMs: 100, now: () => now, sweepThreshold: 3 });
  cache.set('user-a', 'stale-1', ['1']);
  cache.set('user-a', 'stale-2', ['2']);
  now = 1_000; // both entries above are now well past ttlMs=100
  cache.set('user-a', 'fresh', ['3']); // brings size to 3 == sweepThreshold
  // set() checks size before adding its own key, so the sweep fires on the NEXT set() once size has
  // already reached the threshold, not the call that reached it.
  cache.set('user-a', 'trigger-sweep', ['4']);
  assert.deepEqual(cache.get('user-a', 'fresh'), ['3'], 'a still-live entry must survive the sweep');
  assert.equal(cache.get('user-a', 'stale-1'), null);
  assert.equal(cache.get('user-a', 'stale-2'), null);
});

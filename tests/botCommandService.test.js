const assert = require('node:assert/strict');
const test = require('node:test');
const { createBotCommandService } = require('../src/commands/botCommandService');
const { ValidationError } = require('../src/validation/domain');

function fixture(extraDependencies = {}) {
  const state = {
    wallets: [
      { userId: 'user-a', label: 'alpha', address: '0x0000000000000000000000000000000000000001', chain: 'ethereum' },
      { userId: 'user-b', label: 'beta', address: '0x0000000000000000000000000000000000000002', chain: 'ethereum' },
    ],
    tasks: [], activity: [], pnl: [], snipers: [],
  };
  const calls = [];
  const service = createBotCommandService({
    storage: {
      addWallet: async value => { calls.push(['addWallet', value]); return { ...value, id: 3 }; },
      deleteWallet: async (...args) => { calls.push(['deleteWallet', ...args]); return true; },
    },
    schedulerRepository: { cancel: async (...args) => { calls.push(['cancel', ...args]); return null; } },
    providerService: {}, governance: {}, adminCommands: {}, sniperService: {}, supportedChains: ['ethereum'],
    chains: { ethereum: { sym: 'ETH' } },
    encryptPrivateKey: value => { calls.push(['encrypt', value]); return { ciphertext: 'encrypted' }; },
    getState: () => state,
    ...extraDependencies,
  });
  return { calls, service, state };
}

test('shared wallet commands cannot read or remove another Discord user wallet', async () => {
  const { calls, service } = fixture();
  assert.deepEqual(service.wallets('user-a').map(item => item.label), ['alpha']);
  await assert.rejects(service.removeWallet('user-a', 'beta'), ValidationError);
  assert.deepEqual(calls, []);
});

test('wallet creation generates a valid key server-side and returns only the public wallet details', async () => {
  const { calls, service } = fixture();
  const created = await service.createWallet('user-a', { label: 'generated', chain: 'ethereum' });
  assert.deepEqual(Object.keys(created).sort(), ['address', 'chain', 'label']);
  assert.match(created.address, /^0x[0-9A-Fa-f]{40}$/);
  const encryption = calls.find(call => call[0] === 'encrypt');
  assert.match(encryption[1], /^0x[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(created).includes(encryption[1]), false);
});

test('wallet import remains available through the separate fallback operation', async () => {
  const { calls, service } = fixture();
  const privateKey = `0x${'11'.repeat(32)}`;
  const imported = await service.importWallet('user-a', { label: 'imported', chain: 'ethereum', privateKey });
  assert.equal(imported.label, 'imported');
  assert.deepEqual(calls.find(call => call[0] === 'encrypt'), ['encrypt', privateKey]);
});

test('shared task controls always pass the resolved internal user ID to the repository', async () => {
  const { calls, service } = fixture();
  const id = '123e4567-e89b-42d3-a456-426614174000';
  await assert.rejects(service.controlTask('user-a', 'cancel', id), ValidationError);
  assert.deepEqual(calls, [['cancel', 'user-a', id]]);
});

test('a task control error names the action in real English, not `${action}d`', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  // Every control resolves to null here, which is the not-found branch -- the point is the wording
  // the user is shown. "canceld" and "retryd" both used to reach the dashboard's error toast.
  const repository = Object.fromEntries(['cancel', 'pause', 'resume', 'retry']
    .map(action => [action, async () => null]));
  const { service } = fixture({ schedulerRepository: repository });
  const seen = {};
  for (const action of ['cancel', 'pause', 'resume', 'retry']) {
    await assert.rejects(service.controlTask('user-a', action, id), error => {
      assert.ok(error instanceof ValidationError);
      seen[action] = error.issues[0].message;
      return true;
    });
  }
  assert.deepEqual(seen, {
    cancel: 'was not found or cannot be cancelled',
    pause: 'was not found or cannot be paused',
    resume: 'was not found or cannot be resumed',
    retry: 'was not found or cannot be retried',
  });
});

test('a task control action outside the four is rejected before the repository is touched', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  // action comes straight off a request body, and was dispatched as schedulerRepository[action].
  // Anything on that object -- including the state-mutating ones -- used to be reachable.
  const touched = [];
  const repository = new Proxy({}, { get: (target, name) => typeof name === 'string'
    ? async () => { touched.push(name); return null; } : undefined });
  const { service } = fixture({ schedulerRepository: repository });
  for (const action of ['complete', 'fail', 'attachIntent', 'recoverWithoutExecution', 'listStaleClaims',
    'toString', '__proto__', '', undefined]) {
    await assert.rejects(service.controlTask('user-a', action, id), error => {
      assert.ok(error instanceof ValidationError, `${action} should be a ValidationError`);
      assert.deepEqual(error.issues, [{ field: 'action', message: 'must be one of cancel, pause, resume, retry' }]);
      return true;
    });
  }
  assert.deepEqual(touched, []);
});

test('the pending task count spans the whole collection, not the page in view', async () => {
  // The chip above the Scheduled list reads "N pending". Counting it from the returned page made
  // it change as the user paged -- 22 tasks at pageSize 10 read 10, then 2, against a true 14.
  // Note paused is NOT pending here: it is suspended, not queued, and has its own filter
  // (backlog §11.1, re-ruled 2026-08-19).
  const tasks = Array.from({ length: 22 }, (_, index) => ({
    userId: 'user-a', id: `task-${index}`, name: `job-${index}`, walletLabel: 'alpha',
    status: index < 14 ? ['scheduled', 'retry', 'claimed'][index % 3] : 'cancelled',
  }));
  const { service, state } = fixture();
  state.tasks.push(...tasks);
  // No listPageForUser on the stub repository, so this is the in-memory fallback path.
  for (const page of [1, 2, 3]) {
    const result = await service.tasksPage('user-a', { page, pageSize: 10 });
    assert.equal(result.counts.pending, 14, `page ${page} should report the collection's pending count`);
    assert.equal(result.total, 22);
  }
  // Under a search, the counts narrow with total so the two describe one set.
  const searched = await service.tasksPage('user-a', { page: 1, pageSize: 10, search: 'job-1' });
  assert.equal(searched.total, 11);
  assert.equal(searched.counts.pending, tasks.filter(task => task.name.includes('job-1')
    && task.status !== 'cancelled').length);
});

test('repository-supplied counts are passed through untouched, and the filter reaches it', async () => {
  // The SQL path counts and filters itself; pageFrom must forward the result rather than recompute
  // from items, and must hand the status down so the repository can apply it.
  const seen = [];
  const repository = { listPageForUser: async (userId, options) => { seen.push(options);
    return { items: [{ id: 'a' }], total: 22, counts: { pending: 14, paused: 2, failed: 1, cancelled: 5, done: 0 } }; } };
  const { service } = fixture({ schedulerRepository: repository });
  const result = await service.tasksPage('user-a', { page: 2, pageSize: 10, status: 'failed' });
  assert.equal(seen[0].status, 'failed', 'the status filter must reach the repository');
  assert.equal(seen[0].limit, 10);
  assert.equal(seen[0].offset, 10);
  assert.deepEqual(result.counts, { pending: 14, paused: 2, failed: 1, cancelled: 5, done: 0 });
  assert.equal(result.total, 22);
  assert.equal(result.totalPages, 3);
});

test('the buckets partition every status the schema allows', async () => {
  // The DB constrains status to exactly these seven (migrations/011_durable_scheduler.sql:30).
  // If a bucket ever stops covering one, rows in that status become unreachable in the UI --
  // which is why 'succeeded' has a bucket of its own rather than being left out.
  const SCHEMA_STATUSES = ['scheduled', 'claimed', 'retry', 'paused', 'cancelled', 'succeeded', 'failed'];
  // Mint times well in the future, so nothing is expired and each status shows its own bucket.
  const soon = Date.now() + 86_400_000;
  const tasks = SCHEMA_STATUSES.map((status, index) => ({
    userId: 'user-a', id: `task-${index}`, name: `job-${index}`, walletLabel: 'alpha', status, mintTime: soon }));
  const { service, state } = fixture();
  state.tasks.push(...tasks);
  const all = await service.tasksPage('user-a', { page: 1, pageSize: 50 });
  assert.equal(Object.values(all.counts).reduce((sum, value) => sum + value, 0), SCHEMA_STATUSES.length,
    'every status must land in exactly one bucket');
  assert.deepEqual(all.counts, { pending: 3, paused: 1, failed: 1, expired: 0, cancelled: 1, succeeded: 1 });
});

test('expiry needs the mint time to be well past, not merely past', async () => {
  // A mint FAILS because its time arrived, so "mint_time < now" is true for almost every failure.
  // Bucketing on that alone would empty the failed bucket and pile everything into expired, which
  // is why there is a grace period. Inside it a failure is still worth retrying.
  const { service, state } = fixture();
  const now = Date.now();
  state.tasks.push(
    { userId: 'user-a', id: 'just-failed', name: 'just failed', walletLabel: 'alpha',
      status: 'failed', mintTime: now - 60_000 },
    { userId: 'user-a', id: 'old-failed', name: 'old failed', walletLabel: 'alpha',
      status: 'failed', mintTime: now - 26 * 60 * 60 * 1000 },
    { userId: 'user-a', id: 'old-paused', name: 'old paused', walletLabel: 'alpha',
      status: 'paused', mintTime: now - 26 * 60 * 60 * 1000 },
    { userId: 'user-a', id: 'future-paused', name: 'future paused', walletLabel: 'alpha',
      status: 'paused', mintTime: now + 86_400_000 });
  const all = await service.tasksPage('user-a', { page: 1, pageSize: 50 });
  assert.equal(all.counts.failed, 1, 'a minute-old failure is still failed, not expired');
  assert.equal(all.counts.paused, 1, 'a future paused mint is still paused');
  assert.equal(all.counts.expired, 2, 'the day-old failure and the day-old pause are expired');
  const expired = await service.tasksPage('user-a', { page: 1, pageSize: 50, status: 'expired' });
  assert.deepEqual(expired.items.map(task => task.id).sort(), ['old-failed', 'old-paused']);
  const failed = await service.tasksPage('user-a', { page: 1, pageSize: 50, status: 'failed' });
  assert.deepEqual(failed.items.map(task => task.id), ['just-failed']);
});

test('a status filter narrows the rows and the total, but never the counts', async () => {
  const mix = ['scheduled', 'claimed', 'retry', 'paused', 'paused', 'failed', 'cancelled', 'succeeded'];
  const tasks = Array.from({ length: 24 }, (_, index) => ({
    userId: 'user-a', id: `task-${index}`, name: `job-${index}`, walletLabel: 'alpha',
    status: mix[index % mix.length], mintTime: Date.now() + 86_400_000 }));
  const { service, state } = fixture();
  state.tasks.push(...tasks);
  const unfiltered = await service.tasksPage('user-a', { page: 1, pageSize: 10 });
  assert.equal(unfiltered.total, 24);
  const BUCKETS = { pending: ['scheduled', 'claimed', 'retry'], paused: ['paused'],
    failed: ['failed'], cancelled: ['cancelled'], succeeded: ['succeeded'] };
  // every row is scheduled far ahead in this fixture, so none of them are expired
  for (const [bucket, statuses] of Object.entries(BUCKETS)) {
    const page = await service.tasksPage('user-a', { page: 1, pageSize: 50, status: bucket });
    assert.deepEqual([...new Set(page.items.map(task => task.status))].sort(), [...statuses].sort(),
      `${bucket} must return only its own statuses`);
    assert.equal(page.total, tasks.filter(task => statuses.includes(task.status)).length);
    // The chips have to keep reporting the whole collection while one of them is active.
    assert.deepEqual(page.counts, unfiltered.counts, `counts must not move when filtering to ${bucket}`);
  }
  // An unrecognised bucket filters nothing rather than silently emptying the list.
  const bogus = await service.tasksPage('user-a', { page: 1, pageSize: 50, status: 'nonsense' });
  assert.equal(bogus.total, 24);
});

test('send validates the request and hands off to executeSend with the resolved wallet', async () => {
  const calls = [];
  const state = { wallets: [{ userId: 'user-a', label: 'alpha', address: '0x0000000000000000000000000000000000000001', chain: 'ethereum' }], tasks: [], activity: [], pnl: [], snipers: [] };
  const service = createBotCommandService({
    storage: {}, schedulerRepository: {}, providerService: {}, governance: {}, adminCommands: {}, sniperService: {},
    supportedChains: ['ethereum'], chains: { ethereum: { sym: 'ETH' } },
    encryptPrivateKey: () => ({}), getState: () => state,
    executeSend: async ({ userId, wallet, request }) => { calls.push(['executeSend', userId, wallet.label, request]); return { state: 'confirmed', txHash: '0xabc' }; },
  });
  const result = await service.send('user-a', { walletLabel: 'alpha', toAddress: '0x0000000000000000000000000000000000000002', amountETH: 0.1 });
  assert.equal(result.txHash, '0xabc');
  assert.equal(calls.length, 1);
  const [, userId, walletLabel, request] = calls[0];
  assert.equal(userId, 'user-a');
  assert.equal(walletLabel, 'alpha');
  assert.equal(request.chain, 'ethereum');
  assert.equal(request.toAddress, '0x0000000000000000000000000000000000000002');
  assert.equal(request.amountETH, 0.1);
});

test('send cannot draw from another Discord user wallet', async () => {
  const { calls, service } = fixture();
  await assert.rejects(service.send('user-a', { walletLabel: 'beta', toAddress: '0x0000000000000000000000000000000000000002', amountETH: 0.1 }), ValidationError);
  assert.deepEqual(calls, []);
});

test('exportWalletKeyRaw resolves ownership before delegating to exportRawKey and cannot reach another user wallet', async () => {
  const calls = [];
  const { service } = fixture({ exportRawKey: async ({ wallet }) => { calls.push(wallet.label); return `0x${'ab'.repeat(32)}`; } });
  const result = await service.exportWalletKeyRaw('user-a', 'alpha');
  assert.equal(result.label, 'alpha');
  assert.equal(result.privateKey, `0x${'ab'.repeat(32)}`);
  assert.deepEqual(calls, ['alpha']);
  await assert.rejects(service.exportWalletKeyRaw('user-a', 'beta'), ValidationError);
});

test('exportWalletKeystore validates the password and never returns raw key material, only what exportKeystore returns', async () => {
  const calls = [];
  const { service } = fixture({ exportKeystore: async ({ wallet, password }) => { calls.push([wallet.label, password]); return '{"encrypted":"keystore-json"}'; } });
  const result = await service.exportWalletKeystore('user-a', 'alpha', 'a-strong-enough-password');
  assert.equal(result.label, 'alpha');
  assert.equal(result.keystore, '{"encrypted":"keystore-json"}');
  assert.deepEqual(calls, [['alpha', 'a-strong-enough-password']]);
  await assert.rejects(service.exportWalletKeystore('user-a', 'alpha', 'short'), ValidationError);
});

test('walletBalance caches its per-chain RPC fan-out instead of re-querying on every call', async () => {
  let performCalls = 0;
  const state = { wallets: [{ userId: 'user-a', label: 'alpha', address: '0x0000000000000000000000000000000000000001', chain: 'ethereum' }], tasks: [], activity: [], pnl: [], snipers: [] };
  const service = createBotCommandService({
    storage: {}, schedulerRepository: {}, providerService: { perform: async () => { performCalls++; return 1_000000000000000000n; } },
    governance: {}, adminCommands: {}, sniperService: {}, supportedChains: ['ethereum'], chains: { ethereum: { sym: 'ETH' } },
    encryptPrivateKey: () => ({}), getState: () => state,
  });
  const first = await service.walletBalance('user-a', 'alpha');
  const second = await service.walletBalance('user-a', 'alpha');
  assert.equal(performCalls, 1, 'the second call must be served from cache, not a second RPC round trip');
  assert.deepEqual(first.balances, second.balances);
});

test('invalidateBalance forces the next walletBalance call to re-query the chain', async () => {
  let performCalls = 0;
  const state = { wallets: [{ userId: 'user-a', label: 'alpha', address: '0x0000000000000000000000000000000000000001', chain: 'ethereum' }], tasks: [], activity: [], pnl: [], snipers: [] };
  const service = createBotCommandService({
    storage: {}, schedulerRepository: {}, providerService: { perform: async () => { performCalls++; return 1_000000000000000000n; } },
    governance: {}, adminCommands: {}, sniperService: {}, supportedChains: ['ethereum'], chains: { ethereum: { sym: 'ETH' } },
    encryptPrivateKey: () => ({}), getState: () => state,
  });
  await service.walletBalance('user-a', 'alpha');
  service.invalidateBalance('user-a', 'alpha');
  await service.walletBalance('user-a', 'alpha');
  assert.equal(performCalls, 2);
});

// Section Q -- accepting opensea.io collection links anywhere a contract address is accepted.
test('parseOpenSeaCollectionSlug accepts an opensea.io (or www) collection link and rejects everything else', () => {
  const { service } = fixture();
  assert.equal(service.parseOpenSeaCollectionSlug('https://opensea.io/collection/cool-cats'), 'cool-cats');
  assert.equal(service.parseOpenSeaCollectionSlug('https://www.opensea.io/collection/cool-cats'), 'cool-cats');
  assert.equal(service.parseOpenSeaCollectionSlug('not a url at all'), null);
  assert.equal(service.parseOpenSeaCollectionSlug('http://opensea.io/collection/cool-cats'), null, 'must be https');
  assert.equal(service.parseOpenSeaCollectionSlug('https://evil.example/collection/cool-cats'), null, 'must be opensea.io');
  assert.equal(service.parseOpenSeaCollectionSlug('https://opensea.io/assets/cool-cats/1'), null, 'must be a /collection/ path');
  assert.equal(service.parseOpenSeaCollectionSlug('https://opensea.io/collection/'), null, 'slug cannot be empty');
  assert.equal(service.parseOpenSeaCollectionSlug('https://opensea.io/collection/../../etc'), null, 'slug charset is restricted');
});

test('resolveMintContractInput passes a real address straight through without calling OpenSea', async () => {
  const address = '0x0000000000000000000000000000000000000001';
  const { service } = fixture({ openSeaService: { resolveCollectionContract: async () => { throw new Error('should not be called'); } } });
  assert.equal(await service.resolveMintContractInput(address), address);
});

test('resolveMintContractInput resolves an OpenSea link through the injected service, scoped to this app\'s supported chains', async () => {
  const calls = [];
  const { service } = fixture({
    supportedChains: ['ethereum'],
    openSeaService: {
      resolveCollectionContract: async (slug, supportedChains) => {
        calls.push([slug, supportedChains]);
        return { chain: 'ethereum', contractAddress: '0x0000000000000000000000000000000000000099' };
      },
    },
  });
  const result = await service.resolveMintContractInput('https://opensea.io/collection/cool-cats');
  assert.equal(result, '0x0000000000000000000000000000000000000099');
  assert.deepEqual(calls, [['cool-cats', ['ethereum']]]);
});

test('resolveMintContractInput returns null for a link OpenSea could not resolve, and for non-address/non-link input', async () => {
  const { service } = fixture({ openSeaService: { resolveCollectionContract: async () => null } });
  assert.equal(await service.resolveMintContractInput('https://opensea.io/collection/unknown-collection'), null);
  assert.equal(await service.resolveMintContractInput('not an address or a link'), null);
});

test('resolveMintContractInput returns null for a link when no OpenSea service is configured', async () => {
  const { service } = fixture({ openSeaService: null });
  assert.equal(await service.resolveMintContractInput('https://opensea.io/collection/cool-cats'), null);
});

// profileLimits backs the dashboard's daily-budget tile. The chain guard matters because
// gasCeilingGwei falls through to defaultPolicy(chain), which throws a bare Error for an unknown
// chain -- that would surface as a 500 instead of a validation failure.
test('profileLimits rejects an unsupported chain as validation, not a server error', async () => {
  const { service } = fixture({
    governance: { limitsForSelf: async () => ({ chain: 'ethereum' }) },
  });
  await assert.rejects(() => service.profileLimits('user-a', 'dogecoin'),
    error => error instanceof ValidationError && error.issues[0].field === 'chain');
});

test('profileLimits passes a supported chain through to the governance resolver', async () => {
  const seen = [];
  const { service } = fixture({
    governance: { limitsForSelf: async (userId, chain) => { seen.push([userId, chain]); return { chain, ceilingExempt: false }; } },
  });
  const result = await service.profileLimits('user-a', 'ethereum');
  assert.deepEqual(seen, [['user-a', 'ethereum']]);
  assert.equal(result.chain, 'ethereum');
});

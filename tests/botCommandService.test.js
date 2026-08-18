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
  return { calls, service };
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

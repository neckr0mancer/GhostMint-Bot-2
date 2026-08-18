const assert = require('node:assert/strict');
const test = require('node:test');
const { createBotCommandService } = require('../src/commands/botCommandService');
const { createMintExecutionService } = require('../src/mint/mintExecutionService');
const { createMintService } = require('../src/mint/mintService');
const { createProofResolver } = require('../src/mint/proofResolver');
const { SEADROP_MINT_SIGNATURE } = require('../src/mint/seaDropRegistry');
const { ValidationError } = require('../src/validation/domain');

const WALLET = '0x00000000000000000000000000000000000000A1';
const FEE_RECIPIENT = '0x00000000000000000000000000000000000000B2';
const CONTRACT = '0x00000000000000000000000000000000000000C3';
const SEADROP = '0x00000000000000000000000000000000000000D4';

function service(presetRepository = {}) {
  return createMintService({
    presetRepository, proofResolver: createProofResolver({ fetchJson: async () => { throw new Error('unused'); } }),
    supportedChains: ['ethereum'],
  });
}

test('prepare() routes a SeaDrop signature to buildSeaDropMintCall (distinct call target) and a whitelisted signature to buildMintCall (no call target)', async () => {
  const mintService = service();
  const seaDrop = await mintService.prepare({
    contractAddress: CONTRACT, methodSignature: SEADROP_MINT_SIGNATURE, seaDropAddress: SEADROP,
    arguments: [FEE_RECIPIENT, '$wallet', 1], walletAddress: WALLET, valueWei: 0n, chain: 'ethereum',
  });
  assert.equal(seaDrop.preview.callTarget, SEADROP);
  assert.equal(seaDrop.preview.contractAddress, CONTRACT);

  const whitelisted = await mintService.prepare({
    contractAddress: CONTRACT, methodSignature: 'mint(uint256)', arguments: [1],
    walletAddress: WALLET, valueWei: 0n, chain: 'ethereum',
  });
  assert.equal(whitelisted.preview.callTarget, undefined);
});

test('savePreset rejects a SeaDrop signature up front instead of saving an unloadable preset', async () => {
  let saveCalls = 0;
  const mintService = service({ save: async () => { saveCalls += 1; } });
  await assert.rejects(mintService.savePreset('user', {
    name: 'seadrop-preset', contractAddress: CONTRACT, methodSignature: SEADROP_MINT_SIGNATURE, seaDropAddress: SEADROP,
    arguments: [FEE_RECIPIENT, '$wallet', 1], walletAddress: WALLET, valueWei: 0n, chain: 'ethereum',
  }), ValidationError);
  assert.equal(saveCalls, 0);
});

test('mintExecutionService sends the transaction to callTarget when present, falling back to contractAddress otherwise', async () => {
  const seenTo = [];
  const transactionEngine = {
    submit: async ({ to }) => { seenTo.push(to); return {}; },
    preview: async ({ to }) => { seenTo.push(to); return {}; },
  };
  const execution = createMintExecutionService({ mintService: {}, transactionEngine });

  await execution.executePrepared({
    userId: 'user', wallet: { address: WALLET }, chain: 'ethereum',
    prepared: { chain: 'ethereum', calldata: '0x', valueWei: 0n, method: { signature: SEADROP_MINT_SIGNATURE },
      preview: { contractAddress: CONTRACT, callTarget: SEADROP } },
  });
  await execution.executePrepared({
    userId: 'user', wallet: { address: WALLET }, chain: 'ethereum',
    prepared: { chain: 'ethereum', calldata: '0x', valueWei: 0n, method: { signature: 'mint(uint256)' },
      preview: { contractAddress: CONTRACT } },
  });

  assert.deepEqual(seenTo, [SEADROP, CONTRACT]);
});

function commandServiceFixture({ contractValueResolver, seaDropDiscoveryService, openSeaService, priceFeedService }) {
  const state = { wallets: [{ userId: 'user-a', label: 'main', address: WALLET, chain: 'ethereum' }], tasks: [], activity: [], pnl: [], snipers: [] };
  const calls = [];
  const service = createBotCommandService({
    storage: {}, schedulerRepository: {}, providerService: { perform: async () => '0x1234' }, governance: {}, adminCommands: {}, sniperService: {},
    supportedChains: ['ethereum'], chains: { ethereum: { sym: 'ETH' } }, getState: () => state,
    contractValueResolver, seaDropDiscoveryService, openSeaService, priceFeedService,
    executeMint: async ({ userId, wallet, request }) => { calls.push(['executeMint', userId, wallet.label, request]); return { txHash: '0xabc' }; },
  });
  return { calls, service };
}

test('mint() proceeds without a manual price when a SeaDrop drop has a known PublicDrop price', async () => {
  const { calls, service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: null, maxSupply: null, maxPerWallet: null }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000' }, feeRecipient: FEE_RECIPIENT }) },
  });
  await service.mint('user-a', { walletLabel: 'main', contractAddress: CONTRACT, quantity: 1, chain: 'ethereum' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3].priceETH, 0);
});

test('mint() still requires a manual price when the SeaDrop core is found but its price cannot be read', async () => {
  const { calls, service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: null, maxSupply: null, maxPerWallet: null }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: null, feeRecipient: null }) },
  });
  await assert.rejects(service.mint('user-a', { walletLabel: 'main', contractAddress: CONTRACT, quantity: 1, chain: 'ethereum' }), ValidationError);
  assert.equal(calls.length, 0);
});

test('mint() still requires a manual price when neither resolver finds anything', async () => {
  const { calls, service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: null, maxSupply: null, maxPerWallet: null }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  });
  await assert.rejects(service.mint('user-a', { walletLabel: 'main', contractAddress: CONTRACT, quantity: 1, chain: 'ethereum' }), ValidationError);
  assert.equal(calls.length, 0);
});

test('detectMintContract tries SeaDrop first and returns a SeaDrop-shaped result when a core is found, including opening time and OpenSea metadata', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached -- SeaDrop was found first'); },
      probeMaxSupply: async () => ({ value: '10000', source: 'maxSupply' }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000', maxTotalMintableByWallet: 5, startTime: 1_700_000_000, endTime: 1_700_100_000 }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => ({ name: 'Cool Cats', floorPrice: 0.5 }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 2 });
  assert.equal(result.isSeaDrop, true);
  assert.equal(result.methodSignature, SEADROP_MINT_SIGNATURE);
  assert.equal(result.seaDropAddress, SEADROP);
  assert.equal(result.priceKnown, true);
  assert.equal(result.valueWei, '2000');
  assert.equal(result.maxPerWallet, 5);
  // SeaDrop's PublicDrop struct has no supply-cap field -- probed separately from the token
  // contract itself (Section AD Tier 1 follow-up: this used to be hardcoded null for every
  // SeaDrop drop, silently dropping "Max supply" from the collection card).
  assert.equal(result.maxSupply, 10000);
  assert.equal(result.startTime, 1_700_000_000);
  assert.equal(result.endTime, 1_700_100_000);
  assert.deepEqual(result.collection, { name: 'Cool Cats', floorPrice: 0.5 });
});

test('detectMintContract falls back to the plain mint(uint256) assumption when no SeaDrop core is found, and has no opening time', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500' }, maxSupply: { value: '10000' }, maxPerWallet: { value: '3' } }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 2 });
  assert.equal(result.isSeaDrop, false);
  assert.equal(result.methodSignature, 'mint(uint256)');
  assert.equal(result.seaDropAddress, null);
  assert.equal(result.priceKnown, true);
  assert.equal(result.valueWei, '1000');
  assert.equal(result.maxPerWallet, '3');
  assert.equal(result.startTime, null);
  assert.equal(result.endTime, null);
  assert.equal(result.collection, null);
});

test('detectMintContract shows the mint price as displayPrice while a SeaDrop drop is still open', async () => {
  const futureEndTime = Math.floor(Date.now() / 1000) + 3_600;
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached'); }, probeMaxSupply: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000000000000000000', endTime: futureEndTime }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => ({ floorPrice: 5 }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(result.soldOut, false);
  assert.deepEqual(result.displayPrice, { eth: 1, usd: null, source: 'mint' });
});

test('detectMintContract switches displayPrice to the OpenSea floor once a SeaDrop drop\'s endTime has passed', async () => {
  const pastEndTime = Math.floor(Date.now() / 1000) - 3_600;
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached'); }, probeMaxSupply: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000000000000000000', endTime: pastEndTime }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => ({ floorPrice: 2.5 }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(result.soldOut, true);
  assert.deepEqual(result.displayPrice, { eth: 2.5, usd: null, source: 'floor' });
});

test('a genuine floor price of exactly 0 on a sold-out collection is shown as 0, not treated as unavailable', async () => {
  const pastEndTime = Math.floor(Date.now() / 1000) - 3_600;
  const { service } = commandServiceFixture({
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000000000000000000', endTime: pastEndTime }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => ({ floorPrice: 0, floorPriceSymbol: 'ETH' }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(result.soldOut, true);
  assert.equal(result.displayPrice.eth, 0);
  assert.notEqual(result.displayPrice, null);
});

test('a sold-out drop with no OpenSea floor data available has no displayPrice at all', async () => {
  const pastEndTime = Math.floor(Date.now() / 1000) - 3_600;
  const { service } = commandServiceFixture({
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000000000000000000', endTime: pastEndTime }, feeRecipient: FEE_RECIPIENT }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(result.soldOut, true);
  assert.equal(result.displayPrice, null);
});

test('displayPrice includes a USD figure when a price feed is wired in', async () => {
  const futureEndTime = Math.floor(Date.now() / 1000) + 3_600;
  const { service } = commandServiceFixture({
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000000000000000000', endTime: futureEndTime }, feeRecipient: FEE_RECIPIENT }) },
    priceFeedService: { getUsdPrice: async symbol => (symbol === 'ETH' ? 3000 : null) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(result.displayPrice.eth, 1);
  assert.equal(result.displayPrice.usd, 3000);
});

test('a plain (non-SeaDrop) contract shows the mint price while totalMinted is below maxSupply', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500000000000000000' }, maxSupply: { value: '10000' }, maxPerWallet: null, totalMinted: { value: '9999' } }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(result.soldOut, false);
  assert.equal(result.displayPrice.source, 'mint');
  assert.equal(result.displayPrice.eth, 0.5);
});

test('a plain (non-SeaDrop) contract switches to the OpenSea floor once totalMinted reaches maxSupply', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500000000000000000' }, maxSupply: { value: '10000' }, maxPerWallet: null, totalMinted: { value: '10000' } }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
    openSeaService: { getCollectionMetadata: async () => ({ floorPrice: 1.2 }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(result.soldOut, true);
  assert.deepEqual(result.displayPrice, { eth: 1.2, usd: null, source: 'floor' });
});

test('a plain contract with an unknown totalMinted or maxSupply is never treated as sold out', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500000000000000000' }, maxSupply: null, maxPerWallet: null, totalMinted: { value: '10000' } }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(result.soldOut, false);
});

test('detectMintContract never fails just because no openSeaService is wired in', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500' }, maxSupply: null, maxPerWallet: null }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(result.collection, null);
});

// Section AD Tier 1 -- stats is opt-in via includeStats, computed live (never the cached
// resolve()/getCollectionMetadata values this function already uses elsewhere), and shared by
// both the SeaDrop and plain-mint branches.
test('detectMintContract omits stats entirely when includeStats is not set, for both branches', async () => {
  const seaDropResult = await commandServiceFixture({
    // probeMaxSupply is unconditional (unlike probeTotalMinted/getCollectionStats below) -- the
    // card's "Max supply" limits line needs it even on a plain paste with no includeStats, same as
    // the plain-mint branch's contractValueResolver.resolve() already runs unconditionally.
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached'); },
      probeTotalMinted: async () => { throw new Error('must not be called without includeStats'); },
      probeMaxSupply: async () => ({ value: '5000', source: 'maxSupply' }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000' }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => null, getCollectionStats: async () => { throw new Error('must not be called without includeStats'); } },
  }).service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(seaDropResult.stats, null);
  assert.equal(seaDropResult.maxSupply, 5000);

  const plainResult = await commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500' }, maxSupply: null, maxPerWallet: null }), probeTotalMinted: async () => { throw new Error('must not be called without includeStats'); } },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  }).service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(plainResult.stats, null);
});

test('detectMintContract computes live stats and market cap (floor x current minted supply) when includeStats is set, for a SeaDrop drop', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached -- SeaDrop was found first'); },
      probeTotalMinted: async () => ({ value: '4000', source: 'totalSupply' }), probeMaxSupply: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000' }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: {
      getCollectionMetadata: async () => ({ name: 'Cool Cats' }),
      getCollectionStats: async () => ({ floorPrice: 1.5, floorPriceSymbol: 'ETH', numOwners: 900,
        volume: { oneDay: 10, sevenDay: 50, thirtyDay: 200, allTime: 5000 },
        sales: { oneDay: 2, sevenDay: 9, thirtyDay: 40, allTime: 1200 } }),
    },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1, includeStats: true });
  assert.equal(result.stats.totalMinted, 4000);
  assert.equal(result.stats.floorPrice, 1.5);
  assert.equal(result.stats.numOwners, 900);
  assert.deepEqual(result.stats.volume, { oneDay: 10, sevenDay: 50, thirtyDay: 200, allTime: 5000 });
  assert.equal(result.stats.marketCap, 6000); // 1.5 ETH floor x 4000 minted
});

test('detectMintContract computes live stats for a plain (non-SeaDrop) contract too, reusing the same stats shape', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: {
      resolve: async () => ({ price: { value: '500' }, maxSupply: { value: '10000' }, maxPerWallet: null, totalMinted: { value: '1' } }),
      probeTotalMinted: async () => ({ value: '3333', source: 'totalSupply' }),
    },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
    openSeaService: { getCollectionMetadata: async () => null, getCollectionStats: async () => ({ floorPrice: 0.2, floorPriceSymbol: 'ETH', numOwners: 500,
      volume: { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null }, sales: { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null } }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1, includeStats: true });
  // Live-probed totalMinted (3333), not resolve()'s separately-cached totalMinted (1) used for soldOut.
  assert.equal(result.stats.totalMinted, 3333);
  assert.equal(result.stats.marketCap, 666.6);
});

test('market cap is null (not a guess) when either the floor price or the live minted count is unknown', async () => {
  const noFloor = await commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500' }, maxSupply: null, maxPerWallet: null }), probeTotalMinted: async () => ({ value: '100', source: 'totalSupply' }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
    openSeaService: { getCollectionMetadata: async () => null, getCollectionStats: async () => ({ floorPrice: null, floorPriceSymbol: null, numOwners: null,
      volume: { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null }, sales: { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null } }) },
  }).service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1, includeStats: true });
  assert.equal(noFloor.stats.marketCap, null);

  const noSupply = await commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500' }, maxSupply: null, maxPerWallet: null }), probeTotalMinted: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
    openSeaService: { getCollectionMetadata: async () => null, getCollectionStats: async () => ({ floorPrice: 1, floorPriceSymbol: 'ETH', numOwners: null,
      volume: { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null }, sales: { oneDay: null, sevenDay: null, thirtyDay: null, allTime: null } }) },
  }).service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1, includeStats: true });
  assert.equal(noSupply.stats.marketCap, null);
});

function taskServiceFixture({ contractValueResolver, seaDropDiscoveryService }) {
  const state = { wallets: [{ id: 1, userId: 'user-a', label: 'main', address: WALLET, chain: 'ethereum' }], tasks: [], activity: [], pnl: [], snipers: [] };
  const saved = [];
  const service = createBotCommandService({
    storage: { saveTask: async task => { saved.push(task); return true; } },
    schedulerRepository: {}, providerService: {}, governance: {}, adminCommands: {}, sniperService: {},
    supportedChains: ['ethereum'], chains: { ethereum: { sym: 'ETH' } }, getState: () => state,
    contractValueResolver, seaDropDiscoveryService, encryptPrivateKey: () => ({}),
  });
  return { saved, service };
}

test('createTask auto-fills price from a SeaDrop drop when priceETH is omitted, same as mint()', async () => {
  const { saved, service } = taskServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: null, maxSupply: null, maxPerWallet: null }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000' }, feeRecipient: FEE_RECIPIENT }) },
  });
  const mintTime = new Date(Date.now() + 60_000).toISOString();
  await service.createTask('user-a', { name: 'drop', walletLabel: 'main', contractAddress: CONTRACT, quantity: 1, mintTime });
  assert.equal(saved[0].price, 0);
});

test('createTask auto-fills mintTime from a SeaDrop drop\'s future opening time when omitted', async () => {
  const futureStartTime = Math.floor(Date.now() / 1000) + 3_600;
  const { saved, service } = taskServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500' }, maxSupply: null, maxPerWallet: null }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '500', startTime: futureStartTime }, feeRecipient: FEE_RECIPIENT }) },
  });
  await service.createTask('user-a', { name: 'drop', walletLabel: 'main', contractAddress: CONTRACT, quantity: 1 });
  assert.equal(saved[0].mintTime, futureStartTime * 1000);
});

test('createTask does not use a SeaDrop opening time that has already passed, and still requires mintTime', async () => {
  const pastStartTime = Math.floor(Date.now() / 1000) - 3_600;
  const { service } = taskServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500' }, maxSupply: null, maxPerWallet: null }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '500', startTime: pastStartTime }, feeRecipient: FEE_RECIPIENT }) },
  });
  await assert.rejects(service.createTask('user-a', { name: 'drop', walletLabel: 'main', contractAddress: CONTRACT, quantity: 1 }), ValidationError);
});

test('createTask still requires mintTime for a plain (non-SeaDrop) contract -- there is no opening time to detect', async () => {
  const { service } = taskServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500' }, maxSupply: null, maxPerWallet: null }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  });
  await assert.rejects(service.createTask('user-a', { name: 'drop', walletLabel: 'main', contractAddress: CONTRACT, quantity: 1 }), ValidationError);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBotCommandService } = require('../src/commands/botCommandService');
const { createMintExecutionService } = require('../src/mint/mintExecutionService');
const { createMintService } = require('../src/mint/mintService');
const { createProofResolver } = require('../src/mint/proofResolver');
const { SEADROP_MINT_SIGNATURE } = require('../src/mint/seaDropRegistry');
const { ARCHETYPE_INTERFACE, validateOpenSeaMintCall } = require('../src/mint/seaDropCall');
const { ValidationError } = require('../src/validation/domain');

const WALLET = '0x00000000000000000000000000000000000000A1';
const FEE_RECIPIENT = '0x00000000000000000000000000000000000000B2';
const CONTRACT = '0x00000000000000000000000000000000000000C3';
const SEADROP = '0x00000000000000000000000000000000000000D4';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const INVITE_KEY = `0x${'11'.repeat(32)}`;

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

test('OpenSea validation accepts the known Archetype ERC-721A mint shape and exposes a decoded preview', () => {
  const data = ARCHETYPE_INTERFACE.encodeFunctionData('mint', [
    { key: INVITE_KEY, proof: [] }, 2, ZERO_ADDRESS, '0x',
  ]);
  const preview = validateOpenSeaMintCall({
    built: { to: CONTRACT, data, valueWei: '0' }, contractAddress: CONTRACT,
    quantity: 2, minterAddress: WALLET,
  });
  assert.equal(preview.standard, 'Archetype ERC-721A');
  assert.equal(preview.methodSignature, 'mint((bytes32,bytes32[]),uint256,address,bytes)');
  assert.equal(preview.arguments.find(item => item.name === 'quantity').value, '2');
  assert.equal(preview.arguments.find(item => item.name === 'recipient').value, WALLET);
});

test('OpenSea validation rejects an Archetype mintTo that redirects the NFT to another wallet', () => {
  const other = '0x00000000000000000000000000000000000000E5';
  const data = ARCHETYPE_INTERFACE.encodeFunctionData('mintTo', [
    { key: INVITE_KEY, proof: [] }, 1, other, ZERO_ADDRESS, '0x',
  ]);
  assert.throws(() => validateOpenSeaMintCall({
    built: { to: CONTRACT, data, valueWei: '0' }, contractAddress: CONTRACT,
    quantity: 1, minterAddress: WALLET,
  }), ValidationError);
});

function commandServiceFixture({ contractValueResolver, seaDropDiscoveryService, openSeaService, priceFeedService, wallets }) {
  const state = { wallets: wallets || [{ userId: 'user-a', label: 'main', address: WALLET, chain: 'ethereum' }], tasks: [], activity: [], pnl: [], snipers: [] };
  const calls = [];
  const service = createBotCommandService({
    storage: {}, schedulerRepository: {}, providerService: { perform: async () => '0x1234' }, governance: {}, adminCommands: {}, sniperService: {},
    supportedChains: ['ethereum'], chains: { ethereum: { sym: 'ETH' } }, getState: () => state,
    contractValueResolver, seaDropDiscoveryService, openSeaService, priceFeedService,
    executeMint: async ({ userId, wallet, request }) => { calls.push(['executeMint', userId, wallet.label, request]); return { txHash: '0xabc' }; },
    executeMintViaOpenSea: async ({ userId, wallet, request, built }) => { calls.push(['executeMintViaOpenSea', userId, wallet.label, request, built]); return { txHash: '0xdef' }; },
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

// Section AF -- the point of the whole feature: an allowlist/GTD/FCFS SeaDrop stage has no on-chain
// proof this app can construct, because eligibility lives entirely in OpenSea's own backend.
// mintViaOpenSea asks OpenSea to build the calldata (openSeaService.buildMintTransaction) instead of
// this app's own prepareMintCall, then hands it to executeMintViaOpenSea -- the exact same execution
// path (governance ceilings, simulation, gas ceiling, activity recording) every other mint uses.
test('mintViaOpenSea builds calldata through OpenSea and executes it via executeMintViaOpenSea, not the normal calldata path', async () => {
  const built = { to: CONTRACT, data: ARCHETYPE_INTERFACE.encodeFunctionData('mint', [
    { key: `0x${'00'.repeat(32)}`, proof: [] }, 2, ZERO_ADDRESS, '0x',
  ]), valueWei: '50000000000000000', chain: 'ethereum' };
  const buildCalls = [];
  const { calls, service } = commandServiceFixture({
    openSeaService: { buildMintTransaction: async (...args) => { buildCalls.push(args); return built; } },
  });
  const result = await service.mintViaOpenSea('user-a', { walletLabel: 'main', contractAddress: CONTRACT, quantity: 2, chain: 'ethereum' });
  assert.deepEqual(buildCalls, [['ethereum', CONTRACT, WALLET, 2]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'executeMintViaOpenSea');
  assert.equal(calls[0][2], 'main');
  assert.equal(calls[0][3].quantity, 2);
  assert.deepEqual(calls[0][4], built);
  assert.equal(result.txHash, '0xdef');
});

test('batchMint prepares OpenSea calldata independently for every selected wallet', async () => {
  const secondWallet = '0x00000000000000000000000000000000000000B2';
  const data = ARCHETYPE_INTERFACE.encodeFunctionData('mint', [
    { key: `0x${'00'.repeat(32)}`, proof: [] }, 1, ZERO_ADDRESS, '0x',
  ]);
  const buildCalls = [];
  const { calls, service } = commandServiceFixture({
    wallets: [
      { userId: 'user-a', label: 'main', address: WALLET, chain: 'ethereum' },
      { userId: 'user-a', label: 'second', address: secondWallet, chain: 'ethereum' },
    ],
    openSeaService: { buildMintTransaction: async (...args) => {
      buildCalls.push(args);
      return { to: CONTRACT, data, valueWei: '0', chain: 'ethereum' };
    } },
  });

  const results = await service.batchMint('user-a', {
    viaOpenSea: true, walletLabels: ['main', 'second'], contractAddress: CONTRACT,
    quantity: 1, chain: 'ethereum',
  });

  assert.deepEqual(buildCalls, [
    ['ethereum', CONTRACT, WALLET, 1],
    ['ethereum', CONTRACT, secondWallet, 1],
  ]);
  assert.deepEqual(calls.map(call => [call[0], call[2]]), [
    ['executeMintViaOpenSea', 'main'], ['executeMintViaOpenSea', 'second'],
  ]);
  assert.deepEqual(results.map(result => [result.walletLabel, result.txHash]), [
    ['main', '0xdef'], ['second', '0xdef'],
  ]);
});

test('mintViaOpenSea throws instead of executing when OpenSea cannot build a mint for this contract', async () => {
  const { calls, service } = commandServiceFixture({
    openSeaService: { buildMintTransaction: async () => null },
  });
  await assert.rejects(
    service.mintViaOpenSea('user-a', { walletLabel: 'main', contractAddress: CONTRACT, quantity: 1, chain: 'ethereum' }),
    ValidationError,
  );
  assert.equal(calls.length, 0);
});

// buildMintTransaction itself throws ValidationError for a real 409/422 ineligibility (see
// openSeaService.test.js) -- that propagates through mintViaOpenSea unchanged, since it's already
// the exact honest reason to show the user, not something to wrap or reinterpret.
test('mintViaOpenSea propagates OpenSea\'s own ineligibility reason unchanged, rather than executing or masking it', async () => {
  const { calls, service } = commandServiceFixture({
    openSeaService: { buildMintTransaction: async () => { throw new ValidationError({ field: 'contractAddress', message: 'wallet is not on the allowlist' }); } },
  });
  await assert.rejects(
    service.mintViaOpenSea('user-a', { walletLabel: 'main', contractAddress: CONTRACT, quantity: 1, chain: 'ethereum' }),
    error => { assert.equal(error.issues[0].message, 'wallet is not on the allowlist'); return true; },
  );
  assert.equal(calls.length, 0);
});

test('mintViaOpenSea throws when no OpenSea integration is configured at all, instead of silently doing nothing', async () => {
  const { calls, service } = commandServiceFixture({});
  await assert.rejects(
    service.mintViaOpenSea('user-a', { walletLabel: 'main', contractAddress: CONTRACT, quantity: 1, chain: 'ethereum' }),
    ValidationError,
  );
  assert.equal(calls.length, 0);
});

test('dashboard prepareMint uses OpenSea-built Archetype calldata and simulates that exact call instead of mint(uint256)', async () => {
  const data = ARCHETYPE_INTERFACE.encodeFunctionData('mint', [
    { key: INVITE_KEY, proof: [] }, 1, ZERO_ADDRESS, '0x',
  ]);
  let previewed = null;
  const state = { wallets: [{ userId: 'user-a', label: 'main', address: WALLET, chain: 'ethereum' }], tasks: [], activity: [], pnl: [], snipers: [] };
  const commands = createBotCommandService({
    storage: {}, schedulerRepository: {}, providerService: {}, governance: {}, adminCommands: {}, sniperService: {},
    supportedChains: ['ethereum'], chains: { ethereum: { sym: 'ETH' } }, getState: () => state,
    openSeaService: { buildMintTransaction: async () => ({ to: CONTRACT, data, valueWei: '0', chain: 'ethereum' }) },
    mintService: { prepare: async () => { throw new Error('plain mint path must not run'); } },
    previewMint: async value => { previewed = value.prepared; return { simulationPerformed: true, simulationPassed: true }; },
  });
  const result = await commands.prepareMint('user-a', {
    viaOpenSea: true, walletLabel: 'main', contractAddress: CONTRACT, quantity: 1, chain: 'ethereum',
  });
  assert.equal(previewed.calldata, data);
  assert.equal(previewed.method.signature, 'mint((bytes32,bytes32[]),uint256,address,bytes)');
  assert.equal(result.simulation.simulationPassed, true);
});

test('Discord and dashboard share the on-chain public Archetype fallback when OpenSea returns 404/null', async () => {
  const state = { wallets: [{ userId: 'user-a', label: 'main', address: WALLET, chain: 'robinhood' }], tasks: [], activity: [], pnl: [], snipers: [] };
  const builtForDiscord = [];
  const previewedForDashboard = [];
  const providerCalls = [];
  const commands = createBotCommandService({
    storage: {}, schedulerRepository: {}, governance: {}, adminCommands: {}, sniperService: {},
    supportedChains: ['robinhood'], chains: { robinhood: { sym: 'ETH' } }, getState: () => state,
    openSeaService: { buildMintTransaction: async () => null },
    providerService: { perform: async (chain, operation) => {
      providerCalls.push([chain, operation]);
      return ARCHETYPE_INTERFACE.encodeFunctionResult('computePrice', [25000000000000n]);
    } },
    previewMint: async value => { previewedForDashboard.push(value.prepared); return { simulationPerformed: true, simulationPassed: true }; },
    executeMintViaOpenSea: async value => { builtForDiscord.push(value.built); return { state: 'submitted' }; },
  });

  await commands.prepareMint('user-a', { viaOpenSea: true, walletLabel: 'main',
    contractAddress: CONTRACT, quantity: 2, chain: 'robinhood' });
  await commands.mintViaOpenSea('user-a', { walletLabel: 'main', contractAddress: CONTRACT,
    quantity: 2, chain: 'robinhood' });

  assert.deepEqual(providerCalls, [
    ['robinhood', 'archetype:computePrice'], ['robinhood', 'archetype:computePrice'],
  ]);
  assert.equal(previewedForDashboard[0].calldata, builtForDiscord[0].data);
  assert.equal(previewedForDashboard[0].valueWei, 25000000000000n);
  assert.equal(previewedForDashboard[0].calldata.slice(0, 10), '0x4a21a2df');
  const [auth, quantity, affiliate, signature] = ARCHETYPE_INTERFACE.decodeFunctionData('mint', builtForDiscord[0].data);
  assert.equal(auth.key, `0x${'00'.repeat(32)}`);
  assert.deepEqual([...auth.proof], []);
  assert.equal(quantity, 2n);
  assert.equal(affiliate, ZERO_ADDRESS);
  assert.equal(signature, '0x');
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

test('an OpenSea-indexed non-SeaDrop collection prefers the safe OpenSea builder over guessing mint(uint256)', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: null, maxSupply: null, maxPerWallet: null }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
    openSeaService: { getCollectionMetadata: async () => ({ name: 'Raised Fist' }), getDrop: async () => null },
  });
  const result = await service.detectMintContract('user-a', {
    contractAddress: CONTRACT, quantity: 1, includeDrop: true,
  });
  assert.equal(result.collection.name, 'Raised Fist');
  assert.equal(result.openSeaMintRecommended, true);
});

// Section AF -- the on-chain SeaDrop PublicDrop struct only ever exposes ONE currently-configured
// stage, so it can never say what's coming next; OpenSea's Drops API is the real source for that.
// Gated on includeStats (same as the stats block) -- display-only, opt-in, not paid for by every
// plain paste. getDrop is not called at all when includeStats is omitted/false.
test('detectMintContract attaches real phase data from OpenSea when includeStats is true, converting stage prices from wei to ETH', async () => {
  const getDropCalls = [];
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached'); }, probeMaxSupply: async () => null, probeTotalMinted: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000', maxTotalMintableByWallet: 5 }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: {
      getCollectionMetadata: async () => ({ name: 'Cool Cats' }),
      getCollectionStats: async () => null,
      getDrop: async (...args) => { getDropCalls.push(args); return {
        isMinting: true, dropType: 'seadrop_v1_erc721', maxSupply: 10000, openSeaUrl: 'https://opensea.io/collection/cool-cats',
        activeStage: { uuid: 'a1', label: 'Public sale', startTime: 1_700_000_000, endTime: 1_700_100_000, priceWei: '50000000000000000', maxPerWallet: 5, stageType: 'public_sale' },
        nextStage: null,
        stages: [{ uuid: 'a1', label: 'Public sale', startTime: 1_700_000_000, endTime: 1_700_100_000, priceWei: '50000000000000000', maxPerWallet: 5, stageType: 'public_sale' }],
      }; },
    },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1, includeStats: true });
  assert.deepEqual(getDropCalls, [['ethereum', CONTRACT]]);
  assert.equal(result.drop.isMinting, true);
  assert.equal(result.drop.dropType, 'seadrop_v1_erc721');
  assert.equal(result.drop.maxSupply, 10000);
  assert.equal(result.drop.activeStage.priceETH, 0.05);
  assert.equal(result.drop.activeStage.priceWei, '50000000000000000');
  assert.equal(result.drop.nextStage, null);
  assert.equal(result.drop.stages[0].priceETH, 0.05);
  assert.equal(result.openSeaMintRecommended, false,
    'a direct public SeaDrop must not acquire an unnecessary OpenSea-builder dependency');
});

test('detectMintContract recommends the OpenSea builder for a wallet-gated SeaDrop phase', async () => {
  const gated = { uuid: 'allow-1', label: 'Allowlist', startTime: 1_800_000_000,
    endTime: 1_800_003_600, priceWei: '0', maxPerWallet: 1, stageType: 'signed_presale' };
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached'); }, probeMaxSupply: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP,
      publicDrop: { mintPriceWei: '0', maxTotalMintableByWallet: 1 }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => null, getDrop: async () => ({
      isMinting: false, activeStage: null, nextStage: gated, stages: [gated],
    }) },
  });
  const result = await service.detectMintContract('user-a', {
    contractAddress: CONTRACT, quantity: 1, includeDrop: true,
  });
  assert.equal(result.openSeaMintRecommended, true);
});

test('an active public phase keeps the direct SeaDrop path even when a later gated phase exists', async () => {
  const active = { uuid: 'public-1', label: 'Public sale', startTime: 1_700_000_000,
    endTime: 1_900_000_000, priceWei: '0', maxPerWallet: 2, stageType: 'public_sale' };
  const later = { uuid: 'allow-2', label: 'Collectors', startTime: 1_900_000_100,
    endTime: 1_900_003_600, priceWei: '0', maxPerWallet: 1, stageType: 'signed_presale' };
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached'); }, probeMaxSupply: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP,
      publicDrop: { mintPriceWei: '0', maxTotalMintableByWallet: 2 }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => null, getDrop: async () => ({
      isMinting: true, activeStage: active, nextStage: later, stages: [active, later],
    }) },
  });
  const result = await service.detectMintContract('user-a', {
    contractAddress: CONTRACT, quantity: 1, includeDrop: true,
  });
  assert.equal(result.openSeaMintRecommended, false);
});

test('detectMintContract never calls getDrop (or attaches drop) when neither includeDrop nor includeStats is requested', async () => {
  const getDropCalls = [];
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached'); }, probeMaxSupply: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000', maxTotalMintableByWallet: 5 }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => null, getDrop: async (...args) => { getDropCalls.push(args); return null; } },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(getDropCalls.length, 0);
  assert.equal(result.drop, null);
});

// Round 20: phases now show on every paste, not just /info -- includeDrop is its own opt-in flag,
// independent of includeStats (the heavier floor/holders/volume table), so this must work with
// includeStats left at its default false.
test('detectMintContract attaches drop data via includeDrop alone, without needing includeStats too', async () => {
  const getDropCalls = [];
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached'); }, probeMaxSupply: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000', maxTotalMintableByWallet: 5 }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => null, getDrop: async (...args) => { getDropCalls.push(args); return {
      isMinting: false, dropType: 'seadrop_v1_erc721', maxSupply: 4444, openSeaUrl: 'https://opensea.io/collection/kiyo',
      activeStage: null, nextStage: { uuid: 'n1', label: 'Early birds', startTime: 1_800_000_000, endTime: 1_800_001_800, priceWei: '0', maxPerWallet: 1, stageType: 'signed_presale' },
      stages: [],
    }; } },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1, includeDrop: true });
  assert.deepEqual(getDropCalls, [['ethereum', CONTRACT]]);
  assert.equal(result.drop.nextStage.label, 'Early birds');
  assert.equal(result.drop.nextStage.priceETH, 0);
  assert.equal(result.stats, null, 'includeDrop alone must not also pull in the heavier stats block');
  assert.equal(result.openSeaMintRecommended, true);
});

test('detectMintContract skips getDrop when includeDrop is explicitly false, even if includeStats is true', async () => {
  const getDropCalls = [];
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached'); }, probeMaxSupply: async () => null, probeTotalMinted: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000', maxTotalMintableByWallet: 5 }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => null, getCollectionStats: async () => null, getDrop: async (...args) => { getDropCalls.push(args); return null; } },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1, includeStats: true, includeDrop: false });
  assert.equal(getDropCalls.length, 0);
  assert.equal(result.drop, null);
});

test('detectMintContract leaves drop null when the contract is not an OpenSea-tracked drop, without throwing', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached'); }, probeMaxSupply: async () => null, probeTotalMinted: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000', maxTotalMintableByWallet: 5 }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => null, getCollectionStats: async () => null, getDrop: async () => null },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1, includeStats: true });
  assert.equal(result.drop, null);
});

// The plain mint(uint256) branch shares the same includeStats-gated drop fetch as the SeaDrop
// branch above -- computed once, before either branch, so it must reach the non-SeaDrop return too.
test('detectMintContract attaches drop data on the plain mint(uint256) branch too, not just SeaDrop', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500' }, maxSupply: { value: '10000' }, maxPerWallet: { value: '3' } }), probeTotalMinted: async () => null },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
    openSeaService: { getCollectionMetadata: async () => null, getCollectionStats: async () => null, getDrop: async () => ({
      isMinting: false, dropType: 'self_mint', maxSupply: 500, openSeaUrl: null,
      activeStage: null,
      nextStage: { uuid: 'n1', label: null, startTime: 1_700_000_000, endTime: 1_700_100_000, priceWei: '0', maxPerWallet: 2, stageType: 'presale' },
      stages: [],
    }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1, includeStats: true });
  assert.equal(result.isSeaDrop, false);
  assert.equal(result.openSeaMintRecommended, true);
  assert.equal(result.drop.nextStage.priceETH, 0);
  assert.equal(result.drop.nextStage.startTime, 1_700_000_000);
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

// Round 17 (Section AW): a SeaDrop collection that sells out well before its stage window closes
// used to keep showing the real mint price -- soldOut only ever checked endTime, never
// totalMinted>=maxSupply, unlike the plain-mint branch a few lines below in the source. Reproduces
// the live report against phoenix-in-the-hood: sold out (totalMinted === maxSupply) but endTime
// still in the future.
test('detectMintContract treats a SeaDrop drop as sold out once totalMinted reaches maxSupply, even while its stage window is still open', async () => {
  const futureEndTime = Math.floor(Date.now() / 1000) + 3_600;
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached -- SeaDrop was found first'); },
      probeTotalMinted: async () => ({ value: '4444', source: 'totalSupply' }), probeMaxSupply: async () => ({ value: '4444', source: 'maxSupply' }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '2000000000000000', endTime: futureEndTime }, feeRecipient: FEE_RECIPIENT }) },
    openSeaService: { getCollectionMetadata: async () => ({ floorPrice: 0 }), getCollectionStats: async () => ({ floorPrice: 0 }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1, includeStats: true });
  assert.equal(result.soldOut, true);
  assert.equal(result.displayPrice.source, 'floor');
});

test('the scheduler-only includeSupply check detects exhaustion without calling OpenSea collection stats', async () => {
  const futureEndTime = Math.floor(Date.now() / 1000) + 3_600;
  let statsCalls = 0;
  const { service } = commandServiceFixture({
    contractValueResolver:{
      resolve:async()=>{ throw new Error('should not be reached -- SeaDrop was found first'); },
      probeTotalMinted:async()=>({ value:'4444', source:'totalSupply' }),
      probeMaxSupply:async()=>({ value:'4444', source:'maxSupply' }),
    },
    seaDropDiscoveryService:{ resolve:async()=>({ address:SEADROP,
      publicDrop:{ mintPriceWei:'0', endTime:futureEndTime }, feeRecipient:FEE_RECIPIENT }) },
    openSeaService:{
      getCollectionMetadata:async()=>null,
      getCollectionStats:async()=>{ statsCalls += 1; return null; },
    },
  });

  const result = await service.detectMintContract('user-a', {
    contractAddress:CONTRACT, quantity:1, includeSupply:true, includeDrop:false,
  });
  assert.equal(result.soldOut, true);
  assert.equal(result.stats, null, 'the reminder did not request the display stats payload');
  assert.equal(statsCalls, 0, 'the per-minute safety check does not consume an OpenSea stats call');
});

// Outside includeStats/includeSupply there is no live totalMinted to compare against (see the
// comment in detectMintContract) -- ordinary card detection correctly stays lean and falls back to
// the time-window check alone.
test('detectMintContract cannot detect a sold-out SeaDrop drop by supply alone when includeStats is not set', async () => {
  const futureEndTime = Math.floor(Date.now() / 1000) + 3_600;
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached -- SeaDrop was found first'); },
      probeMaxSupply: async () => ({ value: '4444', source: 'maxSupply' }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '2000000000000000', endTime: futureEndTime }, feeRecipient: FEE_RECIPIENT }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 1 });
  assert.equal(result.soldOut, false);
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

// Section AF -- scheduling an OpenSea-backed mint (an allowlist/GTD/FCFS stage this app has no
// on-chain proof for). priceETH is forced to 0 and never resolved from the contract -- OpenSea's
// own response at execution time determines the real value, so resolvePriceIfMissing (which would
// throw for a price that genuinely can't be read on-chain, exactly this path's normal case) must
// never even run for a viaOpenSea task.
test('createTask forces priceETH to 0, persists its chosen phase, and safely defaults OpenSea eligibility', async () => {
  const { saved, service } = taskServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('must not be called for a viaOpenSea task'); } },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  });
  const mintTime = new Date(Date.now() + 60_000).toISOString();
  const task = await service.createTask('user-a', { name: 'allowlist phase', walletLabel: 'main',
    contractAddress: CONTRACT, quantity: 1, mintTime, viaOpenSea: true,
    stageUuid: 'stage-allow-1', stageLabel: 'Allowlist', stageType: 'signed_presale' });
  assert.equal(saved[0].price, 0);
  assert.equal(saved[0].viaOpenSea, true);
  assert.equal(task.viaOpenSea, true);
  assert.equal(task.stageUuid, 'stage-allow-1');
  assert.equal(task.stageLabel, 'Allowlist');
  assert.equal(task.stageType, 'signed_presale');
  assert.equal(task.eligibilityMode, 'earliest_eligible');
  assert.equal(task.eligibilityDeadline, Date.parse(mintTime) + 24 * 60 * 60 * 1000);
});

test('createTask rejects a viaOpenSea schedule with no persisted phase identity', async () => {
  const { service } = taskServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('must not be called'); } },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  });
  const mintTime = new Date(Date.now() + 60_000).toISOString();
  await assert.rejects(service.createTask('user-a', { name:'unsafe phase', walletLabel:'main',
    contractAddress:CONTRACT, quantity:1, mintTime, viaOpenSea:true }), error => (
    error instanceof ValidationError && error.issues.some(issue => issue.field === 'stageUuid')
  ));
});

test('createTask still requires an explicit mintTime for a viaOpenSea task -- there is no PublicDrop opening time to auto-fill from', async () => {
  const { service } = taskServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('must not be called'); } },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  });
  await assert.rejects(service.createTask('user-a', { name: 'allowlist phase', walletLabel: 'main', contractAddress: CONTRACT, quantity: 1, viaOpenSea: true }), ValidationError);
});

test('a non-viaOpenSea task never has viaOpenSea set on the saved row', async () => {
  const { saved, service } = taskServiceFixture({
    contractValueResolver: { resolve: async () => ({ price: { value: '500' }, maxSupply: null, maxPerWallet: null }) },
    seaDropDiscoveryService: { resolve: async () => ({ address: null, publicDrop: null, feeRecipient: null }) },
  });
  const mintTime = new Date(Date.now() + 60_000).toISOString();
  await service.createTask('user-a', { name: 'plain', walletLabel: 'main', contractAddress: CONTRACT, quantity: 1, mintTime });
  assert.equal(saved[0].viaOpenSea, false);
  assert.equal(saved[0].eligibilityMode, 'specific_stage');
  assert.equal(saved[0].eligibilityDeadline, null);
});

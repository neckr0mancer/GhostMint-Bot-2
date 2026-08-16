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

function commandServiceFixture({ contractValueResolver, seaDropDiscoveryService }) {
  const state = { wallets: [{ userId: 'user-a', label: 'main', address: WALLET, chain: 'ethereum' }], tasks: [], activity: [], pnl: [], snipers: [] };
  const calls = [];
  const service = createBotCommandService({
    storage: {}, schedulerRepository: {}, providerService: { perform: async () => '0x1234' }, governance: {}, adminCommands: {}, sniperService: {},
    supportedChains: ['ethereum'], chains: { ethereum: { sym: 'ETH' } }, getState: () => state,
    contractValueResolver, seaDropDiscoveryService,
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

test('detectMintContract tries SeaDrop first and returns a SeaDrop-shaped result when a core is found', async () => {
  const { service } = commandServiceFixture({
    contractValueResolver: { resolve: async () => { throw new Error('should not be reached -- SeaDrop was found first'); } },
    seaDropDiscoveryService: { resolve: async () => ({ address: SEADROP, publicDrop: { mintPriceWei: '1000', maxTotalMintableByWallet: 5 }, feeRecipient: FEE_RECIPIENT }) },
  });
  const result = await service.detectMintContract('user-a', { contractAddress: CONTRACT, quantity: 2 });
  assert.equal(result.isSeaDrop, true);
  assert.equal(result.methodSignature, SEADROP_MINT_SIGNATURE);
  assert.equal(result.seaDropAddress, SEADROP);
  assert.equal(result.priceKnown, true);
  assert.equal(result.valueWei, '2000');
  assert.equal(result.maxPerWallet, 5);
});

test('detectMintContract falls back to the plain mint(uint256) assumption when no SeaDrop core is found', async () => {
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
});

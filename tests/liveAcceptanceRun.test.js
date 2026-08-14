const assert = require('node:assert/strict');
const test = require('node:test');
const { ValidationError } = require('../src/validation/domain');
const { TransactionSafetyError } = require('../src/transactions/transactionEngine');
const { createLiveAcceptanceRunService } = require('../src/acceptance/liveAcceptanceRunService');

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const WALLET = { id: 1, address: '0x00000000000000000000000000000000000000aa', chain: 'sepolia' };
const CHAINS = {
  ethereum: { isTestnet: false, ex: 'https://etherscan.io/tx/' },
  sepolia: { isTestnet: true, ex: 'https://sepolia.etherscan.io/tx/' },
};

function baseInput(overrides = {}) {
  return {
    operatorUserId: OPERATOR_ID,
    chain: 'sepolia',
    walletId: 1,
    contractAddress: '0x00000000000000000000000000000000000000bb',
    methodSignature: 'mint()',
    ...overrides,
  };
}

function fixture({
  isOwner = true,
  wallet = WALLET,
  prepareResult = { chain: 'sepolia', method: { signature: 'mint()' }, calldata: '0x', valueWei: 0n, preview: { contractAddress: WALLET.address } },
  previewResult = { simulationEnabled: true, simulationPerformed: true, simulationPassed: true, gasLimit: 21_000n, estimatedCostWei: 0n, feePerGasWei: 1n },
  previewError = null,
  executeResult = { intentId: 'intent-1', state: 'confirmed', txHash: '0xabc', blockNumber: 10, nonce: 0, requiredConfirmations: 1 },
  executeError = null,
} = {}) {
  const calls = { record: [], preview: 0, executePrepared: 0, prepare: 0 };
  const runRepository = {
    async record(run) { calls.record.push(run); return { runId: `run-${calls.record.length}`, ...run, evidence: run.evidence }; },
  };
  const mintService = {
    async prepare(input) { calls.prepare += 1; calls.prepareInput = input; return prepareResult; },
  };
  const mintExecutionService = {
    async preview() { calls.preview += 1; if (previewError) throw previewError; return previewResult; },
    async executePrepared() { calls.executePrepared += 1; if (executeError) throw executeError; return executeResult; },
  };
  const service = createLiveAcceptanceRunService({
    governanceRepository: { isOwner: async () => isOwner },
    loadWallet: async () => wallet,
    mintService,
    mintExecutionService,
    runRepository,
    chains: CHAINS,
    supportedChains: ['ethereum', 'sepolia'],
    now: () => 1_000,
  });
  return { service, calls };
}

test('refuses when the operator is not a governance owner', async () => {
  const { service, calls } = fixture({ isOwner: false });
  const run = await service.run(baseInput());
  assert.equal(run.outcome, 'failed');
  assert.equal(run.failureCode, 'OWNER_REQUIRED');
  assert.equal(calls.prepare, 0);
  assert.equal(calls.preview, 0);
});

test('refuses a non-testnet chain even if otherwise valid', async () => {
  const { service, calls } = fixture();
  const run = await service.run(baseInput({ chain: 'ethereum' }));
  assert.equal(run.outcome, 'failed');
  assert.equal(run.failureCode, 'NOT_TESTNET');
  assert.equal(calls.prepare, 0);
});

test('refuses when the wallet is not found for the operator', async () => {
  const { service } = fixture({ wallet: null });
  const run = await service.run(baseInput());
  assert.equal(run.outcome, 'failed');
  assert.equal(run.failureCode, 'WALLET_NOT_FOUND');
});

test('refuses when the wallet chain does not match the requested chain', async () => {
  const { service } = fixture({ wallet: { ...WALLET, chain: 'ethereum' } });
  const run = await service.run(baseInput());
  assert.equal(run.outcome, 'failed');
  assert.equal(run.failureCode, 'WALLET_CHAIN_MISMATCH');
});

test('always previews before executing, and records a passed run on confirmation', async () => {
  const { service, calls } = fixture();
  const run = await service.run(baseInput());
  assert.equal(calls.preview, 1, 'preview must run before execution');
  assert.equal(calls.executePrepared, 1);
  assert.equal(run.outcome, 'passed');
  assert.equal(run.evidence.intent.txHash, '0xabc');
  assert.equal(run.evidence.intent.explorerUrl, 'https://sepolia.etherscan.io/tx/0xabc');
});

test('classifies a transaction safety failure raised during preview and never broadcasts', async () => {
  const { service, calls } = fixture({ previewError: new TransactionSafetyError('GAS_CEILING_EXCEEDED', 'too high') });
  const run = await service.run(baseInput());
  assert.equal(run.outcome, 'failed');
  assert.equal(run.failureCode, 'GAS_CEILING_EXCEEDED');
  assert.equal(calls.executePrepared, 0);
});

test('records a failed run when the intent never confirms', async () => {
  const { service } = fixture({ executeResult: { intentId: 'intent-2', state: 'reverted', txHash: '0xdead', failureReason: 'transaction reverted on chain' } });
  const run = await service.run(baseInput());
  assert.equal(run.outcome, 'failed');
  assert.equal(run.failureCode, 'NOT_CONFIRMED');
  assert.equal(run.intentId, 'intent-2');
});

test('classifies an unexpected error raised while broadcasting', async () => {
  const { service } = fixture({ executeError: new Error('boom') });
  const run = await service.run(baseInput());
  assert.equal(run.outcome, 'failed');
  assert.equal(run.failureCode, 'UNEXPECTED_ERROR');
});

test('rejects a malformed request before touching governance or the wallet', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.run(baseInput({ contractAddress: 'not-an-address' })), ValidationError);
  assert.equal(calls.prepare, 0);
});

test('evidence never contains wallet key material', async () => {
  const { service } = fixture();
  const run = await service.run(baseInput());
  const serialized = JSON.stringify(run.evidence);
  assert.equal(serialized.includes('keyEnvelope'), false);
  assert.equal(serialized.includes('ciphertext'), false);
});

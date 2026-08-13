const assert = require('node:assert/strict');
const test = require('node:test');
const { Transaction, Wallet, keccak256, parseEther, parseUnits } = require('ethers');
const { createProviderService } = require('../src/transactions/providerService');
const { createTransactionEngine, TransactionSafetyError } = require('../src/transactions/transactionEngine');

const PRIVATE_KEY = `0x${'42'.repeat(32)}`;
const signer = new Wallet(PRIVATE_KEY);

class MemoryIntentRepository {
  constructor() {
    this.intents = [];
    this.transitions = [];
  }

  async createSubmitted(input) {
    const intent = { ...input, intentId: `intent-${this.intents.length + 1}`, state: 'submitted', txHash: null };
    this.intents.push(intent);
    this.transitions.push({ intentId: intent.intentId, toState: 'submitted' });
    return { ...intent };
  }

  async attachSignedHash(intentId, txHash) {
    const intent = this.intents.find(item => item.intentId === intentId);
    intent.txHash = txHash;
    return { ...intent };
  }

  async transition(intentId, state, details = {}) {
    const intent = this.intents.find(item => item.intentId === intentId);
    Object.assign(intent, details, { state });
    this.transitions.push({ intentId, toState: state });
    return { ...intent };
  }

  async listNonFinal() {
    return this.intents.filter(item => !['confirmed', 'reverted', 'replaced'].includes(item.state)).map(item => ({ ...item }));
  }

  async rollingSpendWei() { return 0n; }
}

function policy(overrides = {}) {
  return {
    simulationEnabled: true,
    gasCeilingGwei: 100,
    maxTransactionValueWei: parseEther('0.1'),
    dailySpendingBudgetWei: parseEther('0.25'),
    requiredConfirmations: 1,
    transactionTimeoutMs: 60_000,
    ...overrides,
  };
}

function fixture({ policyOverrides, notification, simulationError, feeData } = {}) {
  const repository = new MemoryIntentRepository();
  const calls = { broadcasts: [], simulations: 0 };
  let pendingNonce = 0;
  const receipts = new Map();
  const provider = {
    async getFeeData() { return feeData || { gasPrice: parseUnits('2', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
    async estimateGas() { return 21_000n; },
    async getBalance() { return parseEther('10'); },
    async call() {
      calls.simulations += 1;
      if (simulationError) throw simulationError;
      return '0x';
    },
    async getTransactionCount() { return pendingNonce; },
    async getNetwork() { return { chainId: 1n }; },
    async broadcastTransaction(raw) {
      const parsed = Transaction.from(raw);
      const intent = repository.intents.at(-1);
      assert.equal(intent.state, 'submitted', 'intent must exist before broadcast');
      assert.equal(intent.txHash, keccak256(raw), 'signed hash must exist before broadcast');
      calls.broadcasts.push(parsed.nonce);
      pendingNonce = Math.max(pendingNonce, parsed.nonce + 1);
      receipts.set(keccak256(raw), { status: 1, blockNumber: 100 });
      return { hash: keccak256(raw) };
    },
    async getTransactionReceipt(hash) { return receipts.get(hash) || null; },
    async getBlockNumber() { return 100; },
    async getTransaction() { return null; },
  };
  const engine = createTransactionEngine({
    providerService: { expectedChainId: () => 1, perform: (chain, name, operation) => operation(provider) },
    intentRepository: repository,
    policyRepository: { resolvePolicy: async () => policy(policyOverrides) },
    decryptPrivateKey: () => PRIVATE_KEY,
    notify: notification,
    pollIntervalMs: 1,
  });
  const request = {
    userId: '11111111-1111-4111-8111-111111111111',
    wallet: { id: 1, address: signer.address },
    chain: 'ethereum',
    to: '0x0000000000000000000000000000000000000001',
    data: '0x',
    valueWei: 0n,
  };
  return { calls, engine, provider, receipts, repository, request };
}

test('concurrent requests for one wallet serialize and use distinct nonces', async () => {
  const { calls, engine, request } = fixture();
  const results = await Promise.all([engine.submit(request), engine.submit(request)]);
  assert.deepEqual(calls.broadcasts, [0, 1]);
  assert.deepEqual(results.map(result => result.state), ['confirmed', 'confirmed']);
});

test('value and gas ceilings reject before broadcast', async t => {
  await t.test('value ceiling', async () => {
    const { calls, engine, request } = fixture({ policyOverrides: { maxTransactionValueWei: 1n } });
    await assert.rejects(engine.submit({ ...request, valueWei: 2n }), error => error instanceof TransactionSafetyError && error.code === 'VALUE_CEILING_EXCEEDED');
    assert.equal(calls.broadcasts.length, 0);
  });
  await t.test('gas ceiling', async () => {
    const { calls, engine, request } = fixture({ policyOverrides: { gasCeilingGwei: 1 } });
    await assert.rejects(engine.submit(request), error => error instanceof TransactionSafetyError && error.code === 'GAS_CEILING_EXCEEDED');
    assert.equal(calls.broadcasts.length, 0);
  });
});

test('an owner transaction is exempt from value, gas, and daily ceilings', async () => {
  const { calls, engine, request } = fixture({ policyOverrides: {
    ceilingExempt: true,
    maxTransactionValueWei: 1n,
    dailySpendingBudgetWei: 1n,
    gasCeilingGwei: 1,
  } });
  const result = await engine.submit({ ...request, valueWei: 2n });
  assert.equal(result.state, 'confirmed');
  assert.deepEqual(calls.broadcasts, [0]);
});

test('insufficient balance and wrong-chain RPC fail before broadcast', async t => {
  await t.test('balance precheck', async () => {
    const { calls, engine, provider, request } = fixture();
    provider.getBalance = async () => 1n;
    await assert.rejects(engine.submit(request), error => error instanceof TransactionSafetyError && error.code === 'INSUFFICIENT_BALANCE');
    assert.equal(calls.broadcasts.length, 0);
  });
  await t.test('chain identity check', async () => {
    const { calls, engine, provider, request } = fixture();
    provider.getNetwork = async () => ({ chainId: 8453n });
    await assert.rejects(engine.submit(request), error => error instanceof TransactionSafetyError && error.code === 'WRONG_CHAIN');
    assert.equal(calls.broadcasts.length, 0);
  });
});

test('wallet address must match the private key before an intent is persisted', async () => {
  const { calls, engine, repository, request } = fixture();
  await assert.rejects(
    engine.submit({ ...request, wallet: { ...request.wallet, address: '0x0000000000000000000000000000000000000009' } }),
    error => error instanceof TransactionSafetyError && error.code === 'WALLET_KEY_MISMATCH',
  );
  assert.equal(repository.intents.length, 0);
  assert.equal(calls.broadcasts.length, 0);
});

test('a submitted intent is reconciled from chain state after restart', async () => {
  const { engine, repository, request, receipts } = fixture();
  const intent = await repository.createSubmitted({
    ...request, walletId: request.wallet.id, from: request.wallet.address, nonce: 7,
    gasLimit: 21_000n, gasPriceWei: 1n, maxFeePerGasWei: null,
    maxPriorityFeePerGasWei: null, estimatedCostWei: 21_000n,
    simulationEnabled: true, requiredConfirmations: 1,
    transactionTimeoutMs: 60_000, timeoutAt: Date.now() + 60_000,
  });
  const hash = `0x${'ab'.repeat(32)}`;
  await repository.attachSignedHash(intent.intentId, hash);
  receipts.set(hash, { status: 1, blockNumber: 100 });
  const [reconciled] = await engine.reconcileNonFinal();
  assert.equal(reconciled.state, 'confirmed');
  assert.equal(repository.intents[0].state, 'confirmed');
});

test('notification failure cannot alter confirmed transaction status', async () => {
  const { engine, repository, request } = fixture({ notification: async () => { throw new Error('telegram offline'); } });
  const result = await engine.submit(request);
  assert.equal(result.state, 'confirmed');
  assert.equal(repository.intents[0].state, 'confirmed');
});

test('simulation setting independently skips or enforces dry-run', async t => {
  await t.test('disabled skips simulation', async () => {
    const { calls, engine, request } = fixture({ policyOverrides: { simulationEnabled: false } });
    await engine.submit(request);
    assert.equal(calls.simulations, 0);
  });
  await t.test('enabled blocks broadcast when simulation fails', async () => {
    const { calls, engine, request } = fixture({ simulationError: new Error('execution reverted') });
    await assert.rejects(engine.submit(request), /execution reverted/);
    assert.equal(calls.simulations, 1);
    assert.equal(calls.broadcasts.length, 0);
  });
});

test('provider service retries then falls back to the next configured RPC', async () => {
  const providers = new Map([
    ['https://first.invalid', { read: async () => { throw new Error('timeout'); } }],
    ['https://second.invalid', { read: async () => 'ok' }],
  ]);
  const service = createProviderService({
    chains: { ethereum: { rpcUrls: [...providers.keys()] } },
    retries: 1,
    timeoutMs: 100,
    providerFactory: url => providers.get(url),
  });
  assert.equal(await service.perform('ethereum', 'read', provider => provider.read()), 'ok');
});

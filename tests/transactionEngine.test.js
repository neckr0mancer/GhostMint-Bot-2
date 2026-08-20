const assert = require('node:assert/strict');
const test = require('node:test');
const { Transaction, Wallet, keccak256, parseEther, parseUnits } = require('ethers');
const { createProviderService } = require('../src/transactions/providerService');
const { createTransactionEngine, TransactionSafetyError } = require('../src/transactions/transactionEngine');
const { SEADROP_ERROR_INTERFACE } = require('../src/mint/seaDropErrors');

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

function fixture({ policyOverrides, notification, simulationError, feeData, feeDataCache, fastProviderService } = {}) {
  const repository = new MemoryIntentRepository();
  const calls = { broadcasts: [], simulations: 0, feeDataFetches: 0 };
  let pendingNonce = 0;
  const receipts = new Map();
  const provider = {
    async getFeeData() { calls.feeDataFetches += 1; return feeData || { gasPrice: parseUnits('2', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
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
    ...(feeDataCache ? { feeDataCache } : {}),
    ...(fastProviderService ? { fastProviderService } : {}),
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

// The guided batch-mint flow's gas-tolerance step (Section [gas tolerance]): a per-request cap
// distinct from policy.gasCeilingGwei -- the caller's own choice for this specific batch, not a
// governance-imposed limit.
test('a per-request maxGasGwei tolerance rejects before broadcast, independently of the governance gas ceiling', async t => {
  await t.test('tighter than the live fee: rejects even though the governance ceiling would allow it', async () => {
    const { calls, engine, request } = fixture({ policyOverrides: { gasCeilingGwei: 100 } });
    await assert.rejects(engine.submit({ ...request, maxGasGwei: 1 }), error => error instanceof TransactionSafetyError && error.code === 'GAS_TOLERANCE_EXCEEDED');
    assert.equal(calls.broadcasts.length, 0);
  });
  await t.test('looser than the live fee: has no effect, transaction proceeds normally', async () => {
    const { calls, engine, request } = fixture({ policyOverrides: { gasCeilingGwei: 100 } });
    const result = await engine.submit({ ...request, maxGasGwei: 10 });
    assert.equal(result.state, 'confirmed');
    assert.deepEqual(calls.broadcasts, [0]);
  });
  await t.test('not provided: no tolerance check at all, only the governance ceiling applies', async () => {
    const { calls, engine, request } = fixture({ policyOverrides: { gasCeilingGwei: 100 } });
    const result = await engine.submit(request);
    assert.equal(result.state, 'confirmed');
    assert.deepEqual(calls.broadcasts, [0]);
  });
  await t.test('applies even to a ceilingExempt (owner) request -- it is the caller\'s own choice for this batch, not something governance grants an exemption from', async () => {
    const { calls, engine, request } = fixture({ policyOverrides: { ceilingExempt: true, gasCeilingGwei: 1 } });
    await assert.rejects(engine.submit({ ...request, maxGasGwei: 1 }), error => error instanceof TransactionSafetyError && error.code === 'GAS_TOLERANCE_EXCEEDED');
    assert.equal(calls.broadcasts.length, 0);
  });
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
  receipts.set(hash, { status: 1, blockNumber: 100, gasUsed:21_000n, gasPrice:2n });
  const [reconciled] = await engine.reconcileNonFinal();
  assert.equal(reconciled.state, 'confirmed');
  assert.equal(reconciled.actualNetworkCostWei,42_000n);
  assert.equal(reconciled.gasUsed,21_000n);
  assert.equal(reconciled.effectiveGasPriceWei,2n);
  assert.equal(repository.intents[0].state, 'confirmed');
});

test('a reconciliation failure is reported through notify and does not stop the rest of the sweep, or throw', async () => {
  const notified = [];
  const { engine, provider, repository, request } = fixture({ notification: async event => notified.push(event) });
  const failing = await repository.createSubmitted({
    ...request, walletId: request.wallet.id, from: request.wallet.address, nonce: 7,
    gasLimit: 21_000n, gasPriceWei: 1n, maxFeePerGasWei: null,
    maxPriorityFeePerGasWei: null, estimatedCostWei: 21_000n,
    simulationEnabled: true, requiredConfirmations: 1,
    transactionTimeoutMs: 60_000, timeoutAt: Date.now() + 60_000,
  });
  const failingHash = `0x${'cd'.repeat(32)}`;
  await repository.attachSignedHash(failing.intentId, failingHash);
  const okay = await repository.createSubmitted({
    ...request, walletId: request.wallet.id, from: request.wallet.address, nonce: 8,
    gasLimit: 21_000n, gasPriceWei: 1n, maxFeePerGasWei: null,
    maxPriorityFeePerGasWei: null, estimatedCostWei: 21_000n,
    simulationEnabled: true, requiredConfirmations: 1,
    transactionTimeoutMs: 60_000, timeoutAt: Date.now() + 60_000,
  });
  const okayHash = `0x${'ef'.repeat(32)}`;
  await repository.attachSignedHash(okay.intentId, okayHash);

  const originalGetReceipt = provider.getTransactionReceipt.bind(provider);
  provider.getTransactionReceipt = async hash => {
    if (hash === failingHash) throw new Error('RPC unavailable');
    return originalGetReceipt(hash);
  };

  const results = await engine.reconcileNonFinal();
  assert.equal(results.length, 2, 'a reconciliation failure must not stop the rest of the sweep');
  assert.equal(results.find(item => item.intentId === failing.intentId).state, 'submitted',
    'the failing intent keeps its prior state rather than being silently marked as anything else');

  const failureEvent = notified.find(event => event.state === 'reconcile_failed');
  assert.ok(failureEvent, 'a reconciliation failure must be reported through notify, not swallowed silently');
  assert.equal(failureEvent.intent.intentId, failing.intentId);
  assert.match(failureEvent.error, /RPC unavailable/);
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
  await t.test('a SeaDrop custom-error revert surfaces its real plain-English reason, not a generic "would revert" message', async () => {
    // Mirrors the actual shape a bare provider.call() throws for a custom Solidity error (verified
    // against the installed ethers package's own AbiCoder.getBuiltinCallException): `data` carries
    // the raw revert bytes, `reason`/`shortMessage` do not decode a custom error on their own.
    const data = SEADROP_ERROR_INTERFACE.encodeErrorResult('MintQuantityExceedsMaxMintedPerWallet', [7, 5]);
    const simulationError = Object.assign(new Error('execution reverted (unknown custom error)'), { code: 'CALL_EXCEPTION', data });
    const { engine, request } = fixture({ simulationError });
    await assert.rejects(engine.submit(request), /would hold 7, exceeding the 5 allowed per wallet/);
  });
  await t.test('a zero-data revert explains itself instead of surfacing ethers\' cryptic "require(false)" text verbatim', async () => {
    // Reproduced live against a real reported failure: calling mint(uint256) on a contract that
    // implements neither that function nor a fallback reverts with zero bytes of data, which
    // ethers synthesizes into the literal reason string "require(false)" (confirmed against the
    // installed package's own AbiCoder.getBuiltinCallException) -- showing that raw text as if it
    // were an informative revert reason is misleading, not merely unhelpful.
    const simulationError = Object.assign(new Error('execution reverted (no data present; likely require(false) occurred'), { code: 'CALL_EXCEPTION', reason: 'require(false)', data: '0x' });
    const { engine, request } = fixture({ simulationError });
    await assert.rejects(engine.submit(request), /no reason given by the contract/);
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

test('perform() accepts a per-call timeout/retries override without changing the constructor defaults for other callers', async () => {
  const providers = new Map([
    // Never resolves or rejects -- the only way perform() moves off this candidate is its own
    // per-call timeout firing, not the provider ever answering.
    ['https://first.invalid', { read: () => new Promise(() => {}) }],
    ['https://second.invalid', { read: async () => 'ok' }],
  ]);
  const service = createProviderService({
    chains: { ethereum: { rpcUrls: [...providers.keys()] } },
    retries: 3,
    timeoutMs: 5_000,
    providerFactory: url => providers.get(url),
  });
  const start = Date.now();
  assert.equal(await service.perform('ethereum', 'read', provider => provider.read(), { timeoutMs: 50, retries: 0 }), 'ok');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1_000, `override should abandon the hung candidate after ~50ms, not the constructor's 5s default, took ${elapsed}ms`);
});

test('fee data is cached for scheduled and Degen-mode mints, but always fetched fresh for a manual mint', async t => {
  await t.test('a plain manual mint fetches fresh fee data every time', async () => {
    const { calls, engine, request } = fixture();
    await engine.submit({ ...request, triggerSource: 'manual' });
    await engine.submit({ ...request, triggerSource: 'manual' });
    assert.equal(calls.feeDataFetches, 2);
  });

  await t.test('two scheduled mints on the same chain within the TTL share one fee fetch', async () => {
    const { createFeeDataCache } = require('../src/transactions/feeDataCache');
    let clock = 1_000;
    const feeDataCache = createFeeDataCache({ ttlMs: 5_000, now: () => clock });
    const { calls, engine, request } = fixture({ feeDataCache });
    await engine.submit({ ...request, triggerSource: 'scheduled' });
    clock += 1_000;
    await engine.submit({ ...request, triggerSource: 'scheduled' });
    assert.equal(calls.feeDataFetches, 1, 'the second scheduled mint should reuse the first fetch, still within the TTL');
  });

  await t.test('a scheduled mint fetches fresh fee data again once the cache entry has aged out', async () => {
    const { createFeeDataCache } = require('../src/transactions/feeDataCache');
    let clock = 1_000;
    const feeDataCache = createFeeDataCache({ ttlMs: 5_000, now: () => clock });
    const { calls, engine, request } = fixture({ feeDataCache });
    await engine.submit({ ...request, triggerSource: 'scheduled' });
    clock += 5_001;
    await engine.submit({ ...request, triggerSource: 'scheduled' });
    assert.equal(calls.feeDataFetches, 2, 'a stale cache entry must not be reused past its TTL');
  });

  await t.test('a manual mint using Degen mode (gasPriceMultiplier > 1) also uses the cache', async () => {
    const { calls, engine, request } = fixture({ policyOverrides: { gasPriceMultiplier: 1.5 } });
    await engine.submit({ ...request, triggerSource: 'manual' });
    await engine.submit({ ...request, triggerSource: 'manual' });
    assert.equal(calls.feeDataFetches, 1, 'Degen mode is a caching trigger independently of triggerSource');
  });

  await t.test('a scheduled mint on a different chain does not reuse another chain\'s cached fee data', async () => {
    const { createFeeDataCache } = require('../src/transactions/feeDataCache');
    const feeDataCache = createFeeDataCache();
    const { calls, engine, request } = fixture({ feeDataCache });
    await engine.submit({ ...request, chain: 'ethereum', triggerSource: 'scheduled' });
    await engine.submit({ ...request, chain: 'base', triggerSource: 'scheduled' });
    assert.equal(calls.feeDataFetches, 2);
  });
});

test('a dedicated fastProviderService (Round 15) is used for scheduled/Degen pre-broadcast reads, never for a manual mint or the broadcast itself', async t => {
  function fastServiceFixture() {
    const fastCalls = [];
    const fastProvider = {
      async getFeeData() { return { gasPrice: parseUnits('3', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
      async estimateGas() { return 21_000n; },
      async getBalance() { return parseEther('10'); },
      async call() { return '0x'; },
      async getTransactionCount() { return 0; },
      async getNetwork() { return { chainId: 1n }; },
    };
    const fastProviderService = { expectedChainId: () => 1, perform: (chain, name, operation) => { fastCalls.push(name); return operation(fastProvider); } };
    return { fastCalls, fastProviderService };
  }

  await t.test('a scheduled mint routes its reads through the fast service, but still broadcasts via the general one', async () => {
    const { fastCalls, fastProviderService } = fastServiceFixture();
    const { calls, engine, request } = fixture({ fastProviderService });
    await engine.submit({ ...request, triggerSource: 'scheduled' });
    assert.ok(fastCalls.includes('getFeeData'), 'fee data should come from the fast service');
    assert.ok(fastCalls.includes('getBalance'), 'balance check should come from the fast service');
    assert.equal(calls.broadcasts.length, 1, 'the general service must still be the one that actually broadcasts');
    assert.ok(!fastCalls.includes('broadcastTransaction'), 'the fast service must never be asked to broadcast');
  });

  await t.test('a manual mint never touches the fast service, even when one is configured', async () => {
    const { fastCalls, fastProviderService } = fastServiceFixture();
    const { calls, engine, request } = fixture({ fastProviderService });
    await engine.submit({ ...request, triggerSource: 'manual' });
    assert.equal(fastCalls.length, 0, 'a manual mint should never reach the fast service at all');
    assert.equal(calls.feeDataFetches, 1, 'the general service handled every read instead');
  });

  await t.test('without a configured fastProviderService, a scheduled mint falls back to the general service unchanged', async () => {
    const { calls, engine, request } = fixture();
    await engine.submit({ ...request, triggerSource: 'scheduled' });
    assert.equal(calls.feeDataFetches, 1);
    assert.equal(calls.broadcasts.length, 1);
  });
});

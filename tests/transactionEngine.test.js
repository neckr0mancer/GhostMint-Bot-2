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

function fixture({ policyOverrides, notification, simulationError, feeData, feeDataCache, fastProviderService, sniperProviderService, receipts: receiptsOverride } = {}) {
  const repository = new MemoryIntentRepository();
  const calls = { broadcasts: [], simulations: 0, feeDataFetches: 0 };
  let pendingNonce = 0;
  const receipts = receiptsOverride || new Map();
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
    ...(sniperProviderService ? { sniperProviderService } : {}),
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

// The wallet queue must release at broadcast acceptance ('pending'), not hold through finality --
// otherwise a rapid-fire same-wallet mint waits out the previous transaction's entire confirmation
// window (up to the full timeout on slow-finality chains) before even starting its own
// pre-broadcast reads. Distinct nonces stay guaranteed by nextNonce()'s DB-side MAX+1 plus the
// unique-constraint retry, so overlap costs nothing.
test('a same-wallet mint broadcasts while the previous one is still awaiting finality', async () => {
  const { calls, engine, provider, request, repository } = fixture();
  // Keep both transactions visible-but-unconfirmed (mempool yes, receipts no) until released:
  // that is exactly the real-node state two overlapping same-wallet mints sit in, and it forces
  // finality polling to keep waiting rather than resolving early through the receipt path.
  let revealConfirmation = false;
  const realGetTransactionReceipt = provider.getTransactionReceipt.bind(provider);
  provider.getTransactionReceipt = async hash => (revealConfirmation ? realGetTransactionReceipt(hash) : null);
  provider.getTransaction = async () => (revealConfirmation ? null : { hash: '0xmempool' });

  const firstPromise = engine.submit(request);
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (repository.transitions.some(entry => entry.toState === 'pending')) resolve();
      else if (Date.now() - started > 2_000) reject(new Error('first mint never reached pending'));
      else setTimeout(check, 2);
    };
    check();
  });

  const secondPromise = engine.submit(request);
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (calls.broadcasts.length === 2) resolve();
      else if (Date.now() - started > 2_000) reject(new Error('second mint never broadcast'));
      else setTimeout(check, 2);
    };
    check();
  });

  assert.equal(repository.intents[0].state, 'pending', 'first mint had not finalized when the second broadcast');
  assert.deepEqual(calls.broadcasts, [0, 1], 'overlapping submissions still reserve distinct nonces');

  revealConfirmation = true;
  const results = await Promise.all([firstPromise, secondPromise]);
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

test('Round 16: submit() reports end-to-end timing checkpoints via notify(), without persisting them through intentRepository', async () => {
  const events = [];
  const { engine, repository, request } = fixture({ notification: async event => { events.push(event); } });
  await engine.submit({ ...request, triggerSource: 'scheduled' });
  const timingEvent = events.find(e => e.event === 'timing');
  assert.ok(timingEvent, 'a timing event must be emitted');
  assert.equal(timingEvent.triggerSource, 'scheduled');
  assert.equal(timingEvent.chain, request.chain);
  const { submitStartedAt, preparedAt, signedAt, broadcastAt } = timingEvent.timings;
  assert.ok(submitStartedAt <= preparedAt && preparedAt <= signedAt && signedAt <= broadcastAt,
    'checkpoints must be monotonically non-decreasing');
  assert.equal(repository.intents[0].timings, undefined, 'timing data must never be persisted onto the intent itself');
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

test('performAll() (Round 16) races every configured candidate concurrently instead of trying them one at a time', async t => {
  await t.test('resolves with whichever candidate finishes first, not whichever is listed first', async () => {
    const calls = [];
    const providers = new Map([
      ['https://slow.invalid', { broadcast: async () => { calls.push('slow'); await new Promise(r => setTimeout(r, 100)); return 'slow-result'; } }],
      ['https://fast.invalid', { broadcast: async () => { calls.push('fast'); return 'fast-result'; } }],
    ]);
    const service = createProviderService({ chains: { ethereum: { rpcUrls: [...providers.keys()] } }, providerFactory: url => providers.get(url) });
    const result = await service.performAll('ethereum', 'broadcast', provider => provider.broadcast());
    assert.equal(result, 'fast-result');
    assert.deepEqual(calls.sort(), ['fast', 'slow'], 'both candidates must actually be called, not just the winner');
  });

  await t.test('a losing candidate\'s failure is harmless as long as at least one succeeds', async () => {
    const providers = new Map([
      ['https://broken.invalid', { broadcast: async () => { throw new Error('already known'); } }],
      ['https://working.invalid', { broadcast: async () => 'ok' }],
    ]);
    const service = createProviderService({ chains: { ethereum: { rpcUrls: [...providers.keys()] } }, providerFactory: url => providers.get(url) });
    assert.equal(await service.performAll('ethereum', 'broadcast', provider => provider.broadcast()), 'ok');
  });

  await t.test('throws RpcUnavailableError only when every candidate fails', async () => {
    const { RpcUnavailableError } = require('../src/transactions/providerService');
    const providers = new Map([
      ['https://broken1.invalid', { broadcast: async () => { throw new Error('down'); } }],
      ['https://broken2.invalid', { broadcast: async () => { throw new Error('also down'); } }],
    ]);
    const service = createProviderService({ chains: { ethereum: { rpcUrls: [...providers.keys()] } }, providerFactory: url => providers.get(url) });
    await assert.rejects(service.performAll('ethereum', 'broadcast', provider => provider.broadcast()), RpcUnavailableError);
  });
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

// "Simulating this call failed: insufficient funds" used to be passed through verbatim. On a FREE
// drop that reads as the contract rejecting the mint -- the price says 0, so the app looks broken --
// when what actually happened is the wallet cannot pay gas. Reported from production, where every
// wallet held 0 on every chain and the mint page said only "Cannot mint · see above".
test('an insufficient-funds failure states the comparison instead of guessing which part was short', () => {
  const { explainCallFailure } = require('../src/transactions/transactionEngine');
  const byCode = Object.assign(new Error('whatever'), { code: 'INSUFFICIENT_FUNDS' });
  const byText = Object.assign(new Error('x'), { shortMessage: 'insufficient funds for gas * price + value' });

  for (const error of [byCode, byText]) {
    const message = explainCallFailure(error, { chain: 'robinhood', params: { from: '0xWALLET' } });
    // The node returns one generic INSUFFICIENT_FUNDS -- it never says WHICH part was short.
    // An earlier version of this message asserted "no funds to pay the network fee", which was
    // true for an empty wallet but false for one holding gas money and facing a priced mint.
    // It must state the check the node actually performs and let the numbers speak.
    assert.match(message, /cannot cover the mint price plus the network fee/i, 'states the real check');
    assert.match(message, /robinhood/, 'names the chain');
    assert.match(message, /0xWALLET/, 'names the wallet');
    assert.match(message, /added up/i, 'covers the case where only the SUM is too much');
    assert.match(message, /nothing was broadcast/i, 'and that no money moved');
    assert.equal(/no funds to pay the network fee/i.test(message), false,
      'must not name a single cause it cannot know');
    assert.equal(/Simulating this call failed: insufficient/.test(message), false,
      'the raw ethers text is not passed through');
  }
});

test('the insufficient-funds branch does not swallow real contract reverts', () => {
  // It must not become a catch-all: a genuine revert still has to report its own reason.
  const { explainCallFailure } = require('../src/transactions/transactionEngine');
  const revert = Object.assign(new Error('execution reverted'), { reason: 'MintQuantityExceedsMaxSupply' });
  const message = explainCallFailure(revert, { chain: 'ethereum', params: {} });
  assert.match(message, /MintQuantityExceedsMaxSupply/);
  assert.equal(/cannot cover the mint price/.test(message), false);
});

test('it still degrades gracefully with no chain or wallet context', () => {
  const { explainCallFailure } = require('../src/transactions/transactionEngine');
  const error = Object.assign(new Error('insufficient funds'), { code: 'INSUFFICIENT_FUNDS' });
  const message = explainCallFailure(error);
  assert.match(message, /cannot cover the mint price plus the network fee/i);
  assert.equal(/ on undefined/.test(message), false, 'no "on undefined" leaking into user-facing copy');
  assert.equal(/\(undefined\)/.test(message), false);
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
      async broadcastTransaction(raw) {
        // For scheduled broadcast race, reuse the same tracking as the general provider's broadcast
        // would have, but via the fast path. The test's `calls` object is not visible here, so we
        // just ensure the operation succeeds and push the name for the assertion.
        return { hash: `0x${'cc'.repeat(32)}` };
      },
    };
    const fastProviderService = {
      expectedChainId: () => 1,
      perform: (chain, name, operation) => { fastCalls.push(name); return operation(fastProvider); },
      performAll: (chain, name, operation) => { fastCalls.push(name); return operation(fastProvider); },
    };
    return { fastCalls, fastProviderService };
  }

  await t.test('a scheduled mint routes its reads and broadcast through the fast service race', async () => {
    const { fastCalls, fastProviderService } = fastServiceFixture();
    const { calls, engine, request } = fixture({ fastProviderService });
    await engine.submit({ ...request, triggerSource: 'scheduled' });
    assert.ok(fastCalls.includes('getFeeData'), 'fee data should come from the fast service');
    assert.ok(fastCalls.includes('getBalance'), 'balance check should come from the fast service');
    assert.ok(fastCalls.includes('broadcastTransaction'), 'broadcast should race via the fast service');
    assert.equal(calls.broadcasts.length, 0, 'the general service should not broadcast when the fast race is used');
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

test('a dedicated sniperProviderService (Round 16) is used for sniper reads and races the broadcast, gated on triggerSource === \'blockchain\' only', async t => {
  // The sniper mock's own broadcastTransaction writes into the SAME receipts map the general
  // fixture's getTransactionReceipt polls -- post-broadcast finality polling always goes through
  // providerService regardless of who actually broadcast, so without this the confirmation would
  // never be observed and waitForFinality would just time out.
  function sniperServiceFixture(receipts) {
    const sniperCalls = [];
    const sniperProvider = {
      async getFeeData() { return { gasPrice: parseUnits('4', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
      async estimateGas() { return 21_000n; },
      async getBalance() { return parseEther('10'); },
      async call() { return '0x'; },
      async getTransactionCount() { return 0; },
      async getNetwork() { return { chainId: 1n }; },
      async broadcastTransaction(raw) { receipts.set(keccak256(raw), { status: 1, blockNumber: 100 }); return { hash: keccak256(raw) }; },
    };
    const sniperProviderService = {
      expectedChainId: () => 1,
      perform: (chain, name, operation) => { sniperCalls.push(name); return operation(sniperProvider); },
      performAll: (chain, name, operation) => { sniperCalls.push(name); return operation(sniperProvider); },
    };
    return { sniperCalls, sniperProviderService };
  }

  await t.test('a sniper-triggered submit routes reads AND the broadcast through the sniper service, never the general one', async () => {
    const receipts = new Map();
    const { sniperCalls, sniperProviderService } = sniperServiceFixture(receipts);
    const { calls, engine, request } = fixture({ sniperProviderService, receipts });
    await engine.submit({ ...request, triggerSource: 'blockchain' });
    assert.ok(sniperCalls.includes('getFeeData'), 'fee data should come from the sniper service');
    assert.ok(sniperCalls.includes('broadcastTransaction'), 'the broadcast itself should be raced through the sniper service');
    assert.equal(calls.broadcasts.length, 0, 'the general service must never be asked to broadcast a sniper fire');
  });

  await t.test('a scheduled or manual mint never touches the sniper service, even when one is configured', async () => {
    const receipts = new Map();
    const { sniperCalls, sniperProviderService } = sniperServiceFixture(receipts);
    const { calls, engine, request } = fixture({ sniperProviderService });
    await engine.submit({ ...request, triggerSource: 'scheduled' });
    await engine.submit({ ...request, triggerSource: 'manual' });
    assert.equal(sniperCalls.length, 0, 'only triggerSource === \'blockchain\' should ever reach the sniper service');
    assert.equal(calls.broadcasts.length, 2);
  });

  await t.test('sniper\'s own pool takes priority over the scheduled/Degen fast pool when both are configured', async () => {
    const receipts = new Map();
    const { sniperCalls, sniperProviderService } = sniperServiceFixture(receipts);
    const fastCalls = [];
    const fastProvider = {
      async getFeeData() { return { gasPrice: parseUnits('3', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
      async estimateGas() { return 21_000n; }, async getBalance() { return parseEther('10'); },
      async call() { return '0x'; }, async getTransactionCount() { return 0; }, async getNetwork() { return { chainId: 1n }; },
    };
    const fastProviderService = { expectedChainId: () => 1, perform: (chain, name, operation) => { fastCalls.push(name); return operation(fastProvider); } };
    const { engine, request } = fixture({ sniperProviderService, fastProviderService, receipts });
    await engine.submit({ ...request, triggerSource: 'blockchain' });
    assert.ok(sniperCalls.includes('getFeeData'));
    assert.equal(fastCalls.length, 0, 'the fast pool must not be touched when a sniper fire has its own pool available');
  });

  await t.test('without a configured sniperProviderService, a sniper fire still gets the fast-path timeout treatment but broadcasts sequentially via the general pool', async () => {
    const { calls, engine, request } = fixture();
    await engine.submit({ ...request, triggerSource: 'blockchain' });
    assert.equal(calls.broadcasts.length, 1, 'falls back to the ordinary sequential broadcast, not performAll, when no sniper service is configured');
  });
});

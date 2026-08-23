/* global setImmediate */
// REVIEW REPRODUCTIONS for ox-alpha/competitive-speed. Each was run against BOTH this branch
// and main, because "fails here" only means "regression" if it passes there -- and for two of the
// three it did not. Control results:
//
//   gas-ceiling precedence  main PASS / ox-alpha FAIL  -> genuine regression from 38a4d97
//   replaced-misclassify    main FAIL / ox-alpha FAIL  -> PRE-EXISTING flaw, not introduced here,
//                                                         but d10b565 makes it reachable in normal
//                                                         operation instead of near-impossible
//   unhandled rejection     main PASS / ox-alpha PASS  -> did NOT reproduce; the handler wins the
//                                                         race. Latent risk in the code shape only
//
// Kept as assertions of correct behaviour, so fixing each underlying issue turns it green. The
// existing 806/806 misses all of them because every one needs two things to fail at once, and the
// suite exercises one at a time.

// (original note) these are expected to FAIL against ox-alpha/competitive-speed as it
// stands. Each one pins a behaviour that changed as a side effect of the two perf commits
// (38a4d97 "batch submit()'s independent reads", d10b565 "release the per-wallet nonce queue at
// broadcast acceptance"), and that the existing suite cannot catch. They are written as ordinary
// assertions of the CORRECT behaviour so that fixing the underlying issue turns them green --
// they are not tests of the bugs, they are the tests those changes were missing.
//
// Every one of these needs two things to go wrong at once, which is why 806/806 passes without
// them: the suite exercises one failure at a time, and these are interaction bugs.
const assert = require('node:assert/strict');
const test = require('node:test');
const { Wallet, parseEther, parseUnits } = require('ethers');
const { createTransactionEngine } = require('../src/transactions/transactionEngine');

const PRIVATE_KEY = `0x${'42'.repeat(32)}`;
const signer = new Wallet(PRIVATE_KEY);
const USER_ID = '11111111-1111-4111-8111-111111111111';

function policy(overrides = {}) {
  return {
    simulationEnabled: false,
    gasCeilingGwei: 100,
    maxTransactionValueWei: parseEther('0.1'),
    dailySpendingBudgetWei: parseEther('0.25'),
    requiredConfirmations: 1,
    transactionTimeoutMs: 60_000,
    ...overrides,
  };
}

// Deliberately minimal -- each test drives the provider directly so the exact two-failure
// combination is explicit rather than buried in shared fixture behaviour.
function harness({ provider, policyOverrides, repositoryOverrides = {} } = {}) {
  const intents = [];
  const repository = {
    async createSubmitted(input) {
      const intent = { ...input, intentId: `intent-${intents.length + 1}`, state: 'submitted', txHash: null };
      intents.push(intent);
      return { ...intent };
    },
    async attachSignedHash(intentId, txHash) {
      const intent = intents.find(item => item.intentId === intentId);
      intent.txHash = txHash;
      return { ...intent };
    },
    async transition(intentId, state, details = {}) {
      const intent = intents.find(item => item.intentId === intentId);
      Object.assign(intent, details, { state });
      return { ...intent };
    },
    async listNonFinal() {
      return intents.filter(item => !['confirmed', 'reverted', 'replaced'].includes(item.state)).map(item => ({ ...item }));
    },
    async rollingSpendWei() { return 0n; },
    async nextNonce() { return 0; },
    ...repositoryOverrides,
  };
  const engine = createTransactionEngine({
    providerService: { expectedChainId: () => 1, perform: (chain, name, operation) => operation(provider) },
    intentRepository: repository,
    policyRepository: { resolvePolicy: async () => policy(policyOverrides) },
    decryptPrivateKey: () => PRIVATE_KEY,
    pollIntervalMs: 1,
  });
  return { engine, intents, repository };
}

// FINDING 1 -- the per-wallet queue was not only allocating nonces, it was also guaranteeing that
// at most ONE transaction per wallet was ever non-final. inspectChain leans on exactly that: with
// no receipt and no mempool hit, it reads "pending nonce is ahead of mine" as proof that something
// else consumed the nonce, and marks the intent `replaced` -- a FINAL state, so reconciliation
// stops there.
//
// Releasing the queue at broadcast makes that inference unsound. The wallet's OWN next transaction
// pushes the pending count past this intent's nonce. A first transaction that is merely invisible
// for a moment -- routine when a pool rotates to a node that has not seen it -- is then declared
// replaced while it is still perfectly capable of confirming.
test('a still-live transaction is not declared replaced merely because the wallet sent a later one', async () => {
  const provider = {
    // No receipt yet, and this node has not seen the transaction -- it is in flight elsewhere.
    async getTransactionReceipt() { return null; },
    async getTransaction() { return null; },
    // The wallet's second transaction (nonce 1) is in flight, so the pending count is 2. Under the
    // old lock this was unreachable: nothing else from this wallet could be outstanding.
    async getTransactionCount() { return 2; },
    async getBlockNumber() { return 100; },
    async getNetwork() { return { chainId: 1n }; },
  };
  const { engine, repository } = harness({ provider });

  const created = await repository.createSubmitted({
    userId: USER_ID, chain: 'ethereum', from: signer.address, nonce: 0,
    requiredConfirmations: 1, timeoutAt: Date.now() + 60_000,
  });
  await repository.attachSignedHash(created.intentId, `0x${'ab'.repeat(32)}`);
  const inFlight = { ...created, txHash: `0x${'ab'.repeat(32)}`, state: 'pending' };

  const reconciled = await engine.reconcileIntent(inFlight);

  assert.notEqual(reconciled.state, 'replaced',
    'the wallet\'s own later transaction must not be read as evidence this one was replaced');
  assert.equal(reconciled.state, 'pending',
    'no receipt and no replacement proof means still pending, not settled');
});

// FINDING 3 -- submit() now issues getBalance and rollingSpendWei in a Promise.all at the top,
// ahead of six throw sites that used to run first (FEE_UNAVAILABLE, two fee-shape checks,
// GAS_CEILING_EXCEEDED, GAS_TOLERANCE_EXCEEDED, and the gas-limit check). Promise.all rejects on
// the first rejection, so a failing read now outruns a policy decision that should have settled
// the mint on its own.
//
// This matters beyond the message: GAS_CEILING_EXCEEDED is permanent and correctly never retried,
// while an RPC timeout IS in schedulerWorker's TRANSIENT_CODES. Swapping one for the other turns a
// mint that can never succeed into one the scheduler retries.
test('a fee over the gas ceiling is reported as such even when a balance read is failing too', async () => {
  const provider = {
    async getFeeData() { return { gasPrice: parseUnits('50', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
    // The read that used to happen only AFTER the ceiling check had already passed.
    async getBalance() { throw Object.assign(new Error('RPC timeout'), { code: 'TIMEOUT' }); },
    async estimateGas() { return 21_000n; },
    async getTransactionCount() { return 0; },
    async getNetwork() { return { chainId: 1n }; },
    async getBlockNumber() { return 100; },
    async getTransactionReceipt() { return null; },
    async getTransaction() { return null; },
  };
  // 50 gwei against a 1 gwei ceiling: the fee decision is unambiguous and owes nothing to balance.
  const { engine } = harness({ provider, policyOverrides: { gasCeilingGwei: 1 } });

  const error = await engine.submit({
    userId: USER_ID, wallet: { id: 1, address: signer.address }, chain: 'ethereum',
    to: '0x0000000000000000000000000000000000000001', data: '0x', valueWei: 0n,
  }).then(() => null, caught => caught);

  assert.ok(error, 'the mint must fail');
  assert.equal(error.code, 'GAS_CEILING_EXCEEDED',
    'the policy decision must win: reporting the RPC timeout instead makes this look retryable');
});

// FINDING 3's other leg -- the rolling-spend read is the third concurrent read and is consumed
// last, so its failure must resurface only where the serial version awaited it: after every
// permanent fee decision AND after INSUFFICIENT_BALANCE. Pinned in both directions: the ceiling
// decision still beats a failing spend read, and a passing ceiling lets the spend read's own
// error surface rather than being swallowed by the batching.
test('a failing daily-budget read never outranks the ceiling decision nor masks itself', async () => {
  const provider = {
    async getFeeData() { return { gasPrice: parseUnits('50', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
    async getBalance() { return parseEther('10'); },
    async estimateGas() { return 21_000n; },
    async getTransactionCount() { return 0; },
    async getNetwork() { return { chainId: 1n }; },
    async getBlockNumber() { return 100; },
    async getTransactionReceipt() { return null; },
    async getTransaction() { return null; },
  };
  // Async on purpose -- the real repository boundary is asynchronous (pg methods always return
  // promises). A synchronous throw here would detonate during Promise.all construction, before
  // settleRead could even wrap the leg, and would model a failure mode that cannot occur.
  const failingSpend = async () => { throw Object.assign(new Error('database unavailable'), { code: 'TIMEOUT' }); };
  const request = {
    userId: USER_ID, wallet: { id: 1, address: signer.address }, chain: 'ethereum',
    to: '0x0000000000000000000000000000000000000001', data: '0x', valueWei: 0n,
  };

  const overCeiling = await harness({
    provider, policyOverrides: { gasCeilingGwei: 1 }, repositoryOverrides: { rollingSpendWei: failingSpend },
  }).engine.submit(request).then(() => null, caught => caught);
  assert.equal(overCeiling.code, 'GAS_CEILING_EXCEEDED',
    'the permanent ceiling decision precedes the spend read exactly as in the serial version');

  const underCeiling = await harness({
    provider, policyOverrides: { gasCeilingGwei: 100 }, repositoryOverrides: { rollingSpendWei: failingSpend },
  }).engine.submit(request).then(() => null, caught => caught);
  assert.ok(underCeiling, 'a genuinely failing spend read must not be swallowed once it is reached');
  assert.equal(underCeiling.code, 'TIMEOUT',
    'with no permanent decision to report, the spend read surfaces its own error where it used to be awaited');
});

// FINDING 2 -- finalityPromise is created inside the queue callback but nothing handles it until
// submit() returns it, several microtasks later. waitForFinality reaches providerCall and
// transition, both of which reject on RPC failure. A rejection inside that window is unhandled,
// and Node's default for an unhandled rejection is to terminate -- which for a single-process bot
// is the whole thing, precisely when RPCs are already misbehaving.
//
// Timing-sensitive by nature: this asserts submit() surfaces the failure through its own promise
// rather than leaking it to the process. If the window is narrow enough that the handler always
// wins the race, this passes and the finding is a latent risk rather than a live defect -- worth
// the one-line `.catch()` at creation either way.
test('a finality failure surfaces through submit(), never as an unhandled process rejection', async () => {
  let broadcast = false;
  const provider = {
    async getFeeData() { return { gasPrice: parseUnits('2', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
    async getBalance() { return parseEther('10'); },
    async estimateGas() { return 21_000n; },
    async getTransactionCount() { return 0; },
    async getNetwork() { return { chainId: 1n }; },
    async broadcastTransaction() { broadcast = true; return { hash: `0x${'cd'.repeat(32)}` }; },
    // Finality tracking starts the moment the queue callback returns, and immediately fails.
    async getTransactionReceipt() { throw Object.assign(new Error('RPC unavailable'), { code: 'RPC_UNAVAILABLE' }); },
    async getTransaction() { throw Object.assign(new Error('RPC unavailable'), { code: 'RPC_UNAVAILABLE' }); },
    async getBlockNumber() { return 100; },
  };
  const { engine } = harness({ provider });

  const leaked = [];
  const capture = reason => leaked.push(reason);
  process.on('unhandledRejection', capture);
  try {
    await engine.submit({
      userId: USER_ID, wallet: { id: 1, address: signer.address }, chain: 'ethereum',
      to: '0x0000000000000000000000000000000000000001', data: '0x', valueWei: 0n,
    }).catch(() => {});
    // Let any orphaned rejection be reported before the assertion runs.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', capture);
  }

  assert.ok(broadcast, 'the transaction must actually have been broadcast for this to be meaningful');
  assert.deepEqual(leaked, [],
    'a finality failure must not escape as an unhandled rejection -- Node terminates the process on those');
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBumpSweeper } = require('../src/transactions/bumper');

// In-memory intent store + scripted provider/wallet fakes. The point is ladder semantics:
// staleness window, fee math (legacy and 1559), ceiling caps, nonce-consumed skips, attempt
// ceilings, and raced broadcasts.
function fixture({ intents, balances = {}, freshFee = { gasPrice: 20n * 10n ** 9n, maxFeePerGas: null } } = {}) {
  const calls = [];
  const repo = {
    async listBumpCandidates({ sources, cutoffMs, maxBumpCount }) {
      calls.push(['candidates', sources, cutoffMs, maxBumpCount]);
      return intents.filter(i => i.state === 'pending' && (i.bumpCount || 0) < maxBumpCount);
    },
    bumps: [],
    async attachBump(intentId, fields) {
      calls.push(['attachBump', intentId, fields]);
      this.bumps.push({ intentId, ...fields });
      const intent = intents.find(i => i.intentId === intentId);
      Object.assign(intent, fields);
      intent.bumpCount = (intent.bumpCount || 0) + 1;
      return intent;
    },
  };
  const signed = [];
  const sweeper = createBumpSweeper({
    intentRepository: repo,
    findWalletById: (userId, walletId) => ({ id: walletId, userId, address: `0x${walletId}`, keyEnvelope: 'env' }),
    decryptPrivateKey: () => '0x' + '11'.repeat(32),
    providerService: {
      perform: async (chain, purpose) => {
        calls.push([purpose]);
        if (/NonceCheck/.test(purpose)) return balances.consumed ? 5 : 0;
        if (/FeeData/.test(purpose)) return freshFee;
        throw new Error('unexpected perform');
      },
      expectedChainId: () => 8453,
    },
    fastProviderService: {
      performAll: async (chain, op, fn) => { calls.push(['performAll', chain]); await fn({ broadcastTransaction: async () => {} }); },
    },
    resolveFeeCapGwei: null,
    log: () => {},
    now: () => Date.now(),
  });
  return { sweeper, repo, calls, signed, bumps: repo.bumps };
}

function intent(overrides = {}) {
  return {
    intentId: 'i-1', userId: 'u1', walletId: 7, triggerSource: 'launch', state: 'pending',
    chain: 'base', to: '0x' + 'ab'.repeat(20), data: '0xdeadbeef', valueWei: 100n, nonce: 3, gasLimit: 200000n,
    gasPriceWei: 10n * 10n ** 9n, maxFeePerGasWei: null, maxPriorityFeePerGasWei: null,
    txHash: '0xoriginal', bumpCount: 0,
    ...overrides,
  };
}

test('a stale launch intent gets re-bid at +15% on the same nonce, raced via performAll', async () => {
  const { sweeper, calls, bumps } = fixture({ intents: [intent()], freshFee: { gasPrice: 5n * 10n ** 9n, maxFeePerGas: null } });
  await sweeper.scan();
  const attach = calls.find(c => c[0] === 'attachBump');
  assert.ok(attach, 'a bump must be persisted');
  // legacy path: bumped-old wins when above the fresh floor (10 x 1.15 = 11.5 vs floor 5)
  assert.equal(attach[2].gasPriceWei, 11500000000n);
  assert.equal(attach[2].bumpedFromTxHash, '0xoriginal');
  assert.equal(bumps[0].txHash.startsWith('0x'), true);
});

test('1559 intents bump maxFeePerGas with priority preserved', async () => {
  const base = intent({
    gasPriceWei: null, maxFeePerGasWei: 30n * 10n ** 9n, maxPriorityFeePerGasWei: 2n * 10n ** 9n,
  });
  const { sweeper, calls } = fixture({ intents: [base], freshFee: { gasPrice: null, maxFeePerGas: 40n * 10n ** 9n } });
  await sweeper.scan();
  const attach = calls.find(c => c[0] === 'attachBump');
  // floor-wins branch: fresh 40 gwei exceeds bumped 34.5, so 40 it is
  assert.equal(attach[2].maxFeePerGasWei, 40000000000n);
  // replacement rule: priority must ALSO rise or nodes reject the re-bid
  assert.equal(attach[2].maxPriorityFeePerGasWei, 2300000000n); // 2 x 1.15
});

test('a consumed nonce is skipped -- reconciliation owns that story, not the ladder', async () => {
  const { sweeper, calls } = fixture({ intents: [intent()], balances: { consumed: true } });
  await sweeper.scan();
  assert.ok(!calls.some(c => c[0] === 'attachBump'), 'no bump may be persisted over a consumed nonce');
});

test('the ceiling caps the rung: an exceeded next step refuses to bid rather than bidding under', async () => {
  const base = intent();
  const { sweeper, calls } = fixture({ intents: [base] });
  // rebuild with a cap of 11 gwei: +15% of 10 = 11.5 > cap -> capped, no bump persisted
  const cappedSweeper = createBumpSweeper({
    intentRepository: { listBumpCandidates: async () => [base], attachBump: async (...a) => calls.push(['attachBump', ...a]) },
    findWalletById: () => ({ address: '0xw', keyEnvelope: 'e' }),
    decryptPrivateKey: () => '0x' + '22'.repeat(32),
    providerService: {
      perform: async (chain, purpose) => purpose.includes('NonceCheck') ? 0 : { gasPrice: 20n * 10n ** 9n, maxFeePerGas: null },
      expectedChainId: () => 8453,
    },
    fastProviderService: { performAll: async () => {} },
    resolveFeeCapGwei: () => 11,
    log: () => {},
  });
  await cappedSweeper.scan();
  assert.ok(!calls.some(c => c[0] === 'attachBump'), 'capped rung must not persist a bid');
});

test('maxAttempts stops the ladder after its final rung', async () => {
  const base = intent({ bumpCount: 3 });
  const { sweeper, calls } = fixture({ intents: [base] });
  await sweeper.scan();
  assert.ok(!calls.some(c => c[0] === 'attachBump'));
});





const assert = require('node:assert/strict');
const test = require('node:test');
const { createLaunchStager } = require('../src/launch/stager');

function fixture({ seaDrop = true, priceWei = 0n, balances = {} } = {}) {
  const calls = [];
  return {
    calls,
    stager: createLaunchStager({
      checkAccountStatus: async userId => { calls.push(['account', userId]); },
      findWallet: (userId, label) => ({ address: `0x${label}`, chain: 'base' }),
      seaDropDiscoveryService: { resolve: async () => seaDrop
        ? { address: '0xseadrop', feeRecipient: '0xfeerecipient' }
        : { address: null, feeRecipient: null } },
      seaDropPublicDropResolver: { getPublicDrop: async () => seaDrop ? { mintPriceWei: priceWei, startTime: 1, endTime: 2 } : null },
      providerService: {
        perform: async (chain, purpose, fn) => {
          calls.push([purpose]);
          if (/Balance/.test(purpose)) {
            const label = purpose.split(':')[1];
            return BigInt(balances[label] ?? 0);
          }
          return { maxFeePerGas: 1_000_000_000n }; // 1 gwei -> 400k gas buffer = 4e14 wei
        },
      },
      log: () => {},
    }),
  };
}

test('staging a SeaDrop squad captures plan and marks funded wallets staged', async () => {
  const { stager, calls } = fixture({ priceWei: 1_000_000_000_000n, balances: { main: (5n * 10n**18n).toString(), alt: (2n * 10n**18n).toString() } });
  const { plan, results } = await stager.stageSquad({ userId: 'u1', chain: 'base',
    contractAddress: '0xnft', quantity: 2, members: [{ label: 'main' }, { label: 'alt' }] });
  assert.equal(plan.methodSignature, 'mint(address,uint256)');
  assert.equal(plan.seaDropAddress, '0xseadrop');
  assert.equal(plan.feeRecipient, '0xfeerecipient');
  assert.equal(plan.priceWei, 1_000_000_000_000n);
  assert.deepEqual(results.map(r => r.status), ['staged', 'staged']);
  assert.ok(calls.some(c => c[0] === 'account'));
});

test('an underfunded wallet is skipped with a reason instead of failing the squad', async () => {
  // value per wallet = 1000 wei x qty 1; gas buffer at 1 gwei x 400k gas = 4e14 wei.
  const { stager } = fixture({ priceWei: 1000n, balances: { rich: (10n ** 18n).toString(), poor: '100' } });
  const { results } = await stager.stageSquad({ userId: 'u1', chain: 'base', contractAddress: '0xnft',
    quantity: 1, members: [{ label: 'rich' }, { label: 'poor' }] });
  assert.deepEqual(results.map(r => r.status), ['staged', 'skipped']);
  assert.match(results[1].error, /balance too low/);
});

test('a non-SeaDrop contract requires an explicit price and stages the plain mint method', async () => {
  const { stager } = fixture({ seaDrop: false, balances: { main: (10n ** 18n).toString() } });
  await assert.rejects(
    stager.stageSquad({ userId: 'u1', chain: 'base', contractAddress: '0xnft', quantity: 1, members: [{ label: 'main' }] }),
    /explicit price/,
  );
  const { plan, results } = await stager.stageSquad({ userId: 'u1', chain: 'base', contractAddress: '0xnft',
    quantity: 3, manualPriceWei: '7', members: [{ label: 'main' }] });
  assert.equal(plan.methodSignature, 'mint(uint256)');
  assert.equal(plan.seaDropAddress, null);
  assert.equal(plan.priceWei, 7n);
  assert.deepEqual(results.map(r => r.status), ['staged']);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterDetails, afterQuantity, afterWalletSelection, afterPriceResolved, afterGasToleranceResolved, schedulableStages, afterScheduleViaOpenSeaTap } = require('../src/mint/mintFlowDecision');

test('afterDetails asks quantity when maxPerWallet > 1', () => {
  const result = afterDetails({ data: { maxPerWallet: 3 }, wallets: [{ label: 'a' }] });
  assert.equal(result.step, 'awaiting_quantity');
  assert.equal(result.data.maxPerWallet, 3);
});

test('afterDetails defaults quantity to 1 and cascades onward when maxPerWallet is 1 or unknown', () => {
  const single = afterDetails({ data: { maxPerWallet: 1, multi: false, priceUnknown: false }, wallets: [{ label: 'only' }] });
  assert.equal(single.step, 'awaiting_confirm');
  assert.equal(single.data.quantity, 1);
  assert.deepEqual(single.data.selectedWallets, ['only']);

  const unknownMax = afterDetails({ data: { maxPerWallet: undefined, multi: false, priceUnknown: true }, wallets: [{ label: 'only' }] });
  assert.equal(unknownMax.step, 'awaiting_price');
  assert.equal(unknownMax.data.quantity, 1);
});

test('afterQuantity auto-selects the sole wallet for a non-batch mint, but never for /batch', () => {
  const singleWallet = afterQuantity({ data: { quantity: 2, multi: false, priceUnknown: false }, wallets: [{ label: 'solo' }] });
  assert.equal(singleWallet.step, 'awaiting_confirm');
  assert.deepEqual(singleWallet.data.selectedWallets, ['solo']);

  const batchWithOneWallet = afterQuantity({ data: { quantity: 2, multi: true, priceUnknown: false }, wallets: [{ label: 'solo' }] });
  assert.equal(batchWithOneWallet.step, 'awaiting_wallet');
  assert.equal(batchWithOneWallet.data.selectedWallets, undefined);
});

test('afterQuantity asks for a wallet pick when the caller owns more than one', () => {
  const result = afterQuantity({ data: { quantity: 1, multi: false }, wallets: [{ label: 'a' }, { label: 'b' }] });
  assert.equal(result.step, 'awaiting_wallet');
});

test('afterWalletSelection asks for price when unknown, otherwise confirms unless skipConfirm executes outright', () => {
  const unknownPrice = afterWalletSelection({ data: { priceUnknown: true, skipConfirm: false, selectedWallets: ['a'] } });
  assert.equal(unknownPrice.step, 'awaiting_price');

  const confirmScreen = afterWalletSelection({ data: { priceUnknown: false, skipConfirm: false, selectedWallets: ['a'] } });
  assert.equal(confirmScreen.step, 'awaiting_confirm');

  const bypassed = afterWalletSelection({ data: { priceUnknown: false, skipConfirm: true, selectedWallets: ['a'] } });
  assert.equal(bypassed.step, 'execute');
});

test('afterPriceResolved forces priceUnknown back to true for the confirm screen\'s "user-supplied" display, and still respects skipConfirm', () => {
  const confirmScreen = afterPriceResolved({ data: { skipConfirm: false }, priceETH: 0.05 });
  assert.equal(confirmScreen.step, 'awaiting_confirm');
  assert.equal(confirmScreen.data.priceETH, 0.05);
  assert.equal(confirmScreen.data.priceUnknown, true);

  const bypassed = afterPriceResolved({ data: { skipConfirm: true }, priceETH: 0.05 });
  assert.equal(bypassed.step, 'execute');
  assert.equal(bypassed.data.priceETH, 0.05);
});

test('a batch (multi) mint asks for a gas tolerance once the price is known, instead of going straight to confirm -- a single mint never does', () => {
  const batchViaWalletSelection = afterWalletSelection({ data: { multi: true, priceUnknown: false, skipConfirm: false, selectedWallets: ['a', 'b'] } });
  assert.equal(batchViaWalletSelection.step, 'awaiting_gastolerance');

  const batchViaPriceResolved = afterPriceResolved({ data: { multi: true, skipConfirm: false }, priceETH: 0.05 });
  assert.equal(batchViaPriceResolved.step, 'awaiting_gastolerance');

  const singleMint = afterWalletSelection({ data: { multi: false, priceUnknown: false, skipConfirm: false, selectedWallets: ['a'] } });
  assert.equal(singleMint.step, 'awaiting_confirm');
});

test('a batch still asks for price first when it\'s unknown -- gas tolerance only comes after the price is settled', () => {
  const result = afterWalletSelection({ data: { multi: true, priceUnknown: true, selectedWallets: ['a', 'b'] } });
  assert.equal(result.step, 'awaiting_price');
});

test('afterGasToleranceResolved always lands on confirm and carries the chosen (or unset) tolerance into flow data', () => {
  const withLimit = afterGasToleranceResolved({ data: { multi: true, selectedWallets: ['a', 'b'] }, maxGasGwei: 40 });
  assert.equal(withLimit.step, 'awaiting_confirm');
  assert.equal(withLimit.data.maxGasGwei, 40);

  const noLimit = afterGasToleranceResolved({ data: { multi: true, selectedWallets: ['a', 'b'] }, maxGasGwei: null });
  assert.equal(noLimit.step, 'awaiting_confirm');
  assert.equal(noLimit.data.maxGasGwei, null);
});

const NOW = 1_800_000_000_000; // fixed instant so past/future is deterministic regardless of when the suite runs

function stage(startTime, overrides = {}) {
  return { uuid: `s${startTime}`, label: null, startTime, endTime: startTime + 3600, priceETH: 0.05, maxPerWallet: 1, stageType: 'public_sale', ...overrides };
}

test('schedulableStages returns only future-starting stages, chronological, each carrying its original index into drop.stages', () => {
  const now = NOW / 1000;
  const drop = { stages: [stage(now - 100), stage(now + 200), stage(now - 50), stage(now + 100)] };
  const result = schedulableStages({ drop, now: NOW });
  assert.deepEqual(result.map(s => s.index), [3, 1], 'index 3 (now+100) sorts before index 1 (now+200), original positions preserved');
});

test('schedulableStages treats a stage with no startTime at all as unschedulable, and a missing/null drop as empty', () => {
  const now = NOW / 1000;
  const drop = { stages: [stage(now + 100, { startTime: null }), stage(now + 200)] };
  assert.deepEqual(schedulableStages({ drop, now: NOW }).map(s => s.uuid), [`s${now + 200}`]);
  assert.deepEqual(schedulableStages({ drop: null, now: NOW }), []);
  assert.deepEqual(schedulableStages({ drop: { stages: [] }, now: NOW }), []);
});

test('afterScheduleViaOpenSeaTap goes direct with zero or one schedulable stage, and asks the caller to pick with more than one', () => {
  const now = NOW / 1000;
  const none = afterScheduleViaOpenSeaTap({ drop: { stages: [] }, now: NOW });
  assert.equal(none.type, 'direct');
  assert.equal(none.stage, null);

  const single = stage(now + 100);
  const one = afterScheduleViaOpenSeaTap({ drop: { stages: [single] }, now: NOW });
  assert.equal(one.type, 'direct');
  assert.equal(one.stage.uuid, single.uuid);

  const two = afterScheduleViaOpenSeaTap({ drop: { stages: [stage(now + 100), stage(now + 200)] }, now: NOW });
  assert.equal(two.type, 'pick');
  assert.equal(two.stages.length, 2);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterDetails, afterQuantity, afterWalletSelection, afterPriceResolved } = require('../src/mint/mintFlowDecision');

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

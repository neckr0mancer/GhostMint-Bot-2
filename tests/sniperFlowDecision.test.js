const assert = require('node:assert/strict');
const test = require('node:test');
const { afterLabel, afterTarget, afterChain, afterWalletSelection, afterTolerance } = require('../src/sniper/sniperFlowDecision');

test('afterLabel moves straight to asking for the target wallet, carrying the label through', () => {
  const result = afterLabel({ data: { label: 'Copy whale' } });
  assert.equal(result.step, 'awaiting_target');
  assert.equal(result.data.label, 'Copy whale');
});

test('afterTarget moves straight to asking for the chain, carrying the target address through', () => {
  const result = afterTarget({ data: { label: 'Copy whale', targetAddress: '0xabc' } });
  assert.equal(result.step, 'awaiting_chain');
  assert.equal(result.data.targetAddress, '0xabc');
});

test('afterChain auto-selects the sole owned wallet instead of asking', () => {
  const result = afterChain({ data: { chain: 'ethereum' }, wallets: [{ label: 'main' }] });
  assert.equal(result.step, 'awaiting_tolerance');
  assert.equal(result.data.walletLabel, 'main');
});

test('afterChain asks for a wallet pick when the caller owns more than one', () => {
  const result = afterChain({ data: { chain: 'ethereum' }, wallets: [{ label: 'a' }, { label: 'b' }] });
  assert.equal(result.step, 'awaiting_wallet');
  assert.equal(result.data.walletLabel, undefined);
});

test('afterChain never auto-selects when the caller owns no wallets at all', () => {
  const result = afterChain({ data: { chain: 'ethereum' }, wallets: [] });
  assert.equal(result.step, 'awaiting_wallet');
});

test('afterWalletSelection always moves to the fee-tolerance/caps step -- there is no price/skipConfirm branch here, unlike mint', () => {
  const result = afterWalletSelection({ data: { walletLabel: 'main' } });
  assert.equal(result.step, 'awaiting_tolerance');
  assert.equal(result.data.walletLabel, 'main');
});

test('afterTolerance always lands on confirm and carries the chosen (or default) tolerance/caps into flow data', () => {
  const custom = afterTolerance({ data: { label: 'x' }, maxGasGwei: 80, maxValueETH: 0.5, dailySpendingCapETH: 1 });
  assert.equal(custom.step, 'awaiting_confirm');
  assert.equal(custom.data.maxGasGwei, 80);
  assert.equal(custom.data.maxValueETH, 0.5);
  assert.equal(custom.data.dailySpendingCapETH, 1);

  const defaults = afterTolerance({ data: { label: 'x' }, maxGasGwei: undefined, maxValueETH: undefined, dailySpendingCapETH: undefined });
  assert.equal(defaults.step, 'awaiting_confirm');
  assert.equal(defaults.data.maxGasGwei, undefined);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseEther } = require('ethers');
const { SEADROP_ERROR_INTERFACE, describeSeaDropError } = require('../src/mint/seaDropErrors');

// Every test below encodes the error exactly the way a real SeaDrop revert would (via the same
// Interface the decoder itself uses), rather than hand-typing selector hex -- proving the
// encode/decode round-trip actually works, not just that the switch statement compiles.
function encode(name, values) {
  return SEADROP_ERROR_INTERFACE.encodeErrorResult(name, values);
}

test('returns null for no data, empty data, or data that matches no known SeaDrop error', () => {
  assert.equal(describeSeaDropError(undefined), null);
  assert.equal(describeSeaDropError(null), null);
  assert.equal(describeSeaDropError('0x'), null);
  assert.equal(describeSeaDropError('0xdeadbeef'), null, 'a 4-byte selector that matches nothing known');
  assert.equal(describeSeaDropError('0x1234'), null, 'malformed/too-short data must not throw');
});

test('NotActive distinguishes "not open yet" from "already closed" using the contract\'s own reported timestamps', () => {
  const notYet = encode('NotActive', [100, 200, 300]);
  assert.match(describeSeaDropError(notYet), /has not opened yet/);
  const alreadyClosed = encode('NotActive', [400, 200, 300]);
  assert.match(describeSeaDropError(alreadyClosed), /already closed/);
});

test('MintQuantityCannotBeZero', () => {
  assert.match(describeSeaDropError(encode('MintQuantityCannotBeZero', [])), /cannot be zero/);
});

test('MintQuantityExceedsMaxMintedPerWallet reports both figures the contract gave', () => {
  const message = describeSeaDropError(encode('MintQuantityExceedsMaxMintedPerWallet', [7, 5]));
  assert.match(message, /would hold 7/);
  assert.match(message, /5 allowed per wallet/);
});

test('MintQuantityExceedsMaxSupply and MintQuantityExceedsMaxTokenSupplyForStage are both "sold out" but distinguish collection-wide from this-stage', () => {
  const wholeCollection = describeSeaDropError(encode('MintQuantityExceedsMaxSupply', [10001, 10000]));
  assert.match(wholeCollection, /sold out/);
  assert.match(wholeCollection, /10000 total supply/);
  const stageOnly = describeSeaDropError(encode('MintQuantityExceedsMaxTokenSupplyForStage', [51, 50]));
  assert.match(stageOnly, /sold out/);
  assert.match(stageOnly, /50 allotted to this stage/);
});

test('FeeRecipientNotAllowed', () => {
  assert.match(describeSeaDropError(encode('FeeRecipientNotAllowed', [])), /fee recipient/);
});

test('IncorrectPayment reports both amounts in ETH, not raw wei', () => {
  const message = describeSeaDropError(encode('IncorrectPayment', [parseEther('0.05'), parseEther('0.08')]));
  assert.match(message, /sent 0\.05 ETH/);
  assert.match(message, /requires exactly 0\.08 ETH/);
});

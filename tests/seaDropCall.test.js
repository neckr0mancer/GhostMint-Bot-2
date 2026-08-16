const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSeaDropMintCall, computeSeaDropValueWei, decodeSeaDropMintCall } = require('../src/mint/seaDropCall');
const { formatMintPreview } = require('../src/mint/mintCall');
const { SEADROP_CORE_INTERFACE, SEADROP_MINT_SIGNATURE } = require('../src/mint/seaDropRegistry');
const { ValidationError } = require('../src/validation/domain');

const WALLET = '0x00000000000000000000000000000000000000A1';
const FEE_RECIPIENT = '0x00000000000000000000000000000000000000B2';
const CONTRACT = '0x00000000000000000000000000000000000000C3';
const SEADROP = '0x00000000000000000000000000000000000000D4';

test('encodes mintPublic with the reserved SeaDrop signature and a distinct call target', () => {
  const call = buildSeaDropMintCall({
    contractAddress: CONTRACT, seaDropAddress: SEADROP, arguments: [FEE_RECIPIENT, '$wallet', 3],
    walletAddress: WALLET, valueWei: 300n,
  });
  assert.equal(call.method.signature, SEADROP_MINT_SIGNATURE);
  assert.equal(call.preview.contractAddress, CONTRACT);
  assert.equal(call.preview.callTarget, SEADROP);
  assert.notEqual(call.preview.callTarget, call.preview.contractAddress);
  const decoded = SEADROP_CORE_INTERFACE.decodeFunctionData('mintPublic', call.calldata);
  assert.equal(decoded[0].toLowerCase(), CONTRACT.toLowerCase());
  assert.equal(decoded[1].toLowerCase(), FEE_RECIPIENT.toLowerCase());
  assert.equal(decoded[2].toLowerCase(), WALLET.toLowerCase());
  assert.equal(decoded[3], 3n);
});

test('the $wallet sentinel resolves minter to the connected wallet address', () => {
  const call = buildSeaDropMintCall({
    contractAddress: CONTRACT, seaDropAddress: SEADROP, arguments: [FEE_RECIPIENT, '$wallet', 1],
    walletAddress: WALLET, valueWei: 0n,
  });
  assert.equal(call.arguments[2].toLowerCase(), WALLET.toLowerCase());
});

test('an explicit minter overrides the wallet address', () => {
  const other = '0x00000000000000000000000000000000000000E5';
  const call = buildSeaDropMintCall({
    contractAddress: CONTRACT, seaDropAddress: SEADROP, arguments: [FEE_RECIPIENT, other, 1],
    walletAddress: WALLET, valueWei: 0n,
  });
  assert.equal(call.arguments[2], other);
});

test('bad addresses, wrong argument count, and out-of-range quantity are rejected before encoding', () => {
  const base = { contractAddress: CONTRACT, seaDropAddress: SEADROP, walletAddress: WALLET, valueWei: 0n };
  assert.throws(() => buildSeaDropMintCall({ ...base, contractAddress: 'not-an-address', arguments: [FEE_RECIPIENT, '$wallet', 1] }), ValidationError);
  assert.throws(() => buildSeaDropMintCall({ ...base, seaDropAddress: 'not-an-address', arguments: [FEE_RECIPIENT, '$wallet', 1] }), ValidationError);
  assert.throws(() => buildSeaDropMintCall({ ...base, arguments: ['not-an-address', '$wallet', 1] }), ValidationError);
  assert.throws(() => buildSeaDropMintCall({ ...base, arguments: [FEE_RECIPIENT, '$wallet'] }), ValidationError);
  assert.throws(() => buildSeaDropMintCall({ ...base, arguments: [FEE_RECIPIENT, '$wallet', 0] }), ValidationError);
  assert.throws(() => buildSeaDropMintCall({ ...base, arguments: [FEE_RECIPIENT, '$wallet', 101] }), ValidationError);
  assert.throws(() => buildSeaDropMintCall({ ...base, arguments: [FEE_RECIPIENT, '$wallet', -1] }), ValidationError);
});

test('computeSeaDropValueWei is exactly quantity * mintPrice, matching SeaDrop\'s own payment check', () => {
  assert.equal(computeSeaDropValueWei({ mintPriceWei: '1000000000000000', quantity: 3 }), 3_000_000_000_000_000n);
  assert.equal(computeSeaDropValueWei({ mintPriceWei: 0n, quantity: 5 }), 0n);
});

test('decodeSeaDropMintCall round-trips a previously built call and rejects non-mintPublic calldata', () => {
  const encoded = buildSeaDropMintCall({
    contractAddress: CONTRACT, seaDropAddress: SEADROP, arguments: [FEE_RECIPIENT, '$wallet', 2],
    walletAddress: WALLET, valueWei: 200n,
  });
  const decoded = decodeSeaDropMintCall({ contractAddress: CONTRACT, seaDropAddress: SEADROP, calldata: encoded.calldata, valueWei: 200n });
  assert.equal(decoded.contractAddress, CONTRACT);
  assert.equal(decoded.callTarget, SEADROP);
  assert.equal(decoded.arguments[3].value, '2');
  assert.throws(() => decodeSeaDropMintCall({ contractAddress: CONTRACT, seaDropAddress: SEADROP, calldata: '0x12345678', valueWei: 0n }), ValidationError);
});

test('formatMintPreview shows a distinct call-target line for SeaDrop previews and stays unchanged otherwise', () => {
  const seaDropPreview = buildSeaDropMintCall({
    contractAddress: CONTRACT, seaDropAddress: SEADROP, arguments: [FEE_RECIPIENT, '$wallet', 1],
    walletAddress: WALLET, valueWei: 0n,
  }).preview;
  assert.match(formatMintPreview(seaDropPreview), /Call target: 0x.*D4/i);
  const plainPreview = { contractAddress: CONTRACT, methodSignature: 'mint(uint256)', standard: 'ERC-721', arguments: [], nativeValue: '0.0' };
  assert.doesNotMatch(formatMintPreview(plainPreview), /Call target/);
});

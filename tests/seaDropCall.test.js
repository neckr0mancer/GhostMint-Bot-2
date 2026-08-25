const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSeaDropMintCall, computeSeaDropValueWei, decodeSeaDropMintCall,
  SEADROP_GATED_INTERFACE, validateOpenSeaMintCall } = require('../src/mint/seaDropCall');
const { formatMintPreview } = require('../src/mint/mintCall');
const { SEADROP_CORE_INTERFACE, SEADROP_MINT_SIGNATURE } = require('../src/mint/seaDropRegistry');
const { ValidationError } = require('../src/validation/domain');

const WALLET = '0x00000000000000000000000000000000000000A1';
const FEE_RECIPIENT = '0x00000000000000000000000000000000000000B2';
const CONTRACT = '0x00000000000000000000000000000000000000C3';
const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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

// Round 21 (Item U): OpenSea's own POST /drops/{slug}/mint calldata was being signed and broadcast
// entirely as-is -- no check it actually targets the requested contract/quantity. These simulate
// OpenSea's response shape ({to, data, valueWei}) using calldata this app itself can build/decode,
// since the real thing requires a live OpenSea call.
function fakeOpenSeaResponse({ contractAddress = CONTRACT, quantity = 2 } = {}) {
  const built = buildSeaDropMintCall({ contractAddress, seaDropAddress: SEADROP,
    arguments: [FEE_RECIPIENT, '$wallet', quantity], walletAddress: WALLET, valueWei: 0n });
  return { to: SEADROP, data: built.calldata, valueWei: '0' };
}

test('validateOpenSeaMintCall accepts calldata matching the requested contract and quantity', () => {
  const decoded = validateOpenSeaMintCall({ built: fakeOpenSeaResponse({ quantity: 2 }),
    contractAddress: CONTRACT, quantity: 2, minterAddress:WALLET });
  assert.equal(decoded.contractAddress.toLowerCase(), CONTRACT.toLowerCase());
  assert.equal(decoded.arguments.find(a => a.name === 'quantity').value, '2');
});

test('validateOpenSeaMintCall refuses calldata that targets a different contract than requested', () => {
  const otherContract = '0x00000000000000000000000000000000000000F6';
  assert.throws(() => validateOpenSeaMintCall({ built: fakeOpenSeaResponse({ contractAddress: otherContract, quantity: 1 }),
    contractAddress: CONTRACT, quantity: 1, minterAddress:WALLET }), ValidationError);
});

test('validateOpenSeaMintCall refuses calldata that mints a different quantity than requested', () => {
  assert.throws(() => validateOpenSeaMintCall({ built: fakeOpenSeaResponse({ quantity: 5 }),
    contractAddress: CONTRACT, quantity: 3, minterAddress:WALLET }), ValidationError);
});

test('validateOpenSeaMintCall refuses calldata that is not a mintPublic call at all', () => {
  assert.throws(() => validateOpenSeaMintCall({ built: { to: SEADROP, data: '0x12345678', valueWei: '0' },
    contractAddress: CONTRACT, quantity: 1, minterAddress:WALLET }), ValidationError);
});

const MINT_PARAMS = Object.freeze({
  mintPrice:1n, maxTotalMintableByWallet:5n, startTime:1n, endTime:9_999_999_999n,
  dropStageIndex:2n, maxTokenSupplyForStage:500n, feeBps:250n, restrictFeeRecipients:true,
});

function gatedResponse(method, args) {
  return { to:SEADROP, data:SEADROP_GATED_INTERFACE.encodeFunctionData(method, args), valueWei:'2' };
}

test('OpenSea SeaDrop allowlist and signed calldata are decoded through explicit canonical ABIs', () => {
  const proof = [`0x${'11'.repeat(32)}`];
  const allowlist = validateOpenSeaMintCall({
    built:gatedResponse('mintAllowList', [CONTRACT, FEE_RECIPIENT, ZERO_ADDRESS, 2, MINT_PARAMS, proof]),
    contractAddress:CONTRACT, quantity:2, minterAddress:WALLET,
  });
  assert.equal(allowlist.methodSignature,
    'mintAllowList(address,address,address,uint256,(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool),bytes32[])');
  assert.equal(allowlist.standard, 'SeaDrop allowlist');
  assert.equal(allowlist.arguments.find(arg => arg.name === 'minter').value, WALLET);
  assert.match(allowlist.arguments.find(arg => arg.name === 'proof').value, /proof present/);

  const signed = validateOpenSeaMintCall({
    built:gatedResponse('mintSigned', [CONTRACT, FEE_RECIPIENT, WALLET, 3, MINT_PARAMS, 17, '0x1234']),
    contractAddress:CONTRACT, quantity:3, minterAddress:WALLET,
  });
  assert.equal(signed.standard, 'SeaDrop signed mint');
  assert.equal(signed.arguments.find(arg => arg.name === 'quantity').value, '3');
  assert.equal(signed.arguments.find(arg => arg.name === 'signature').value, 'signature present');
});

test('OpenSea SeaDrop token-gated calldata derives quantity from the redeemed token IDs', () => {
  const allowedToken = '0x00000000000000000000000000000000000000E5';
  const decoded = validateOpenSeaMintCall({
    built:gatedResponse('mintAllowedTokenHolder', [CONTRACT, FEE_RECIPIENT, ZERO_ADDRESS,
      { allowedNftToken:allowedToken, allowedNftTokenIds:[41, 42] }]),
    contractAddress:CONTRACT, quantity:2, minterAddress:WALLET,
  });
  assert.equal(decoded.standard, 'SeaDrop token-gated mint');
  assert.equal(decoded.arguments.find(arg => arg.name === 'quantity').value, '2');
  assert.match(decoded.arguments.find(arg => arg.name === 'allowedTokenIds').value, /2 token IDs/);
});

test('gated SeaDrop validation rejects a changed token, recipient, or derived quantity', () => {
  const other = '0x00000000000000000000000000000000000000F6';
  const base = [CONTRACT, FEE_RECIPIENT, ZERO_ADDRESS, 2, MINT_PARAMS, []];
  assert.throws(() => validateOpenSeaMintCall({
    built:gatedResponse('mintAllowList', [other, ...base.slice(1)]), contractAddress:CONTRACT,
    quantity:2, minterAddress:WALLET,
  }), ValidationError);
  assert.throws(() => validateOpenSeaMintCall({
    built:gatedResponse('mintAllowList', [CONTRACT, FEE_RECIPIENT, other, 2, MINT_PARAMS, []]),
    contractAddress:CONTRACT, quantity:2, minterAddress:WALLET,
  }), ValidationError);
  assert.throws(() => validateOpenSeaMintCall({
    built:gatedResponse('mintAllowList', base), contractAddress:CONTRACT,
    quantity:1, minterAddress:WALLET,
  }), ValidationError);
});

test('public SeaDrop validation rejects a mint recipient other than the signing wallet', () => {
  const other = '0x00000000000000000000000000000000000000F6';
  const built = buildSeaDropMintCall({ contractAddress:CONTRACT, seaDropAddress:SEADROP,
    arguments:[FEE_RECIPIENT, other, 1], walletAddress:WALLET, valueWei:0n });
  assert.throws(() => validateOpenSeaMintCall({ built:{ to:SEADROP, data:built.calldata, valueWei:'0' },
    contractAddress:CONTRACT, quantity:1, minterAddress:WALLET }), ValidationError);
});

test('formatMintPreview shows a distinct call-target line for SeaDrop previews and stays unchanged otherwise', () => {
  const seaDropPreview = buildSeaDropMintCall({
    contractAddress: CONTRACT, seaDropAddress: SEADROP, arguments: [FEE_RECIPIENT, '$wallet', 1],
    walletAddress: WALLET, valueWei: 0n,
  }).preview;
  assert.match(formatMintPreview(seaDropPreview), /Call target: 0x00005EA00/i);
  const plainPreview = { contractAddress: CONTRACT, methodSignature: 'mint(uint256)', standard: 'ERC-721', arguments: [], nativeValue: '0.0' };
  assert.doesNotMatch(formatMintPreview(plainPreview), /Call target/);
});

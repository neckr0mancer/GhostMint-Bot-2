const { formatEther, isAddress } = require('ethers');
const { ValidationError } = require('../validation/domain');
const { buildMintCall } = require('./mintCall');
const { MINT_METHODS } = require('./mintRegistry');
const {
  ARCHETYPE_PUBLIC_KEY,
  ARCHETYPE_INTERFACE,
  SEADROP_GATED_INTERFACE,
  buildSeaDropMintCall,
  validateOpenSeaMintCall,
} = require('./seaDropCall');
const { CANONICAL_SEADROP_CORE_ADDRESS, SEADROP_CORE_INTERFACE } = require('./seaDropRegistry');

const HEX_CALLDATA = /^0x(?:[0-9a-fA-F]{2})+$/;

function invalid(message) {
  throw new ValidationError({ field:'calldata', message }, 'UNSAFE_COPY_CALL', message);
}

function normalizeValue(value) {
  try {
    const parsed = BigInt(value ?? 0);
    if (parsed < 0n) invalid('source transaction value must be non-negative');
    return parsed;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    invalid('source transaction value is invalid');
  }
}

// Copy-mint is deliberately an ABI allowlist, not arbitrary transaction mirroring. Every accepted
// selector is decoded and re-encoded before it reaches the transaction engine. Recipient-bearing
// calls are rewritten to the firing wallet so GhostMint never pays to mint into the watched wallet.
function prepareCopyMintCall({ callTarget, data, valueWei = 0n, walletAddress }) {
  if (!isAddress(callTarget)) invalid('source transaction has no valid call target');
  if (!isAddress(walletAddress)) invalid('firing wallet address is invalid');
  if (typeof data !== 'string' || !HEX_CALLDATA.test(data) || data.length < 10) {
    invalid('source transaction does not contain valid function calldata');
  }
  const value = normalizeValue(valueWei);
  const selector = data.slice(0, 10).toLowerCase();

  const standard = Object.values(MINT_METHODS).find(method => (
    method.iface.getFunction('mint').selector.toLowerCase() === selector
  ));
  if (standard) {
    if (standard.inputs.some(input => input.authorization)) {
      invalid(`${standard.signature} authorization belongs to the watched wallet and cannot be copied safely`);
    }
    let decoded;
    try { decoded = standard.iface.decodeFunctionData('mint', data); }
    catch { invalid(`source calldata cannot be decoded as ${standard.signature}`); }
    const values = standard.inputs.map((input, index) => (
      input.type === 'address' && input.name === 'recipient' ? walletAddress : decoded[index]
    ));
    const built = buildMintCall({ contractAddress:callTarget, methodSignature:standard.signature,
      arguments:values, walletAddress, valueWei:value });
    return { contractAddress:callTarget, callTarget, calldata:built.calldata, valueWei:value,
      methodSignature:standard.signature, preview:built.preview };
  }

  const publicSelector = SEADROP_CORE_INTERFACE.getFunction('mintPublic').selector.toLowerCase();
  if (selector === publicSelector) {
    if (callTarget.toLowerCase() !== CANONICAL_SEADROP_CORE_ADDRESS.toLowerCase()) {
      invalid('SeaDrop mintPublic must target the canonical SeaDrop core');
    }
    let decoded;
    try { decoded = SEADROP_CORE_INTERFACE.decodeFunctionData('mintPublic', data); }
    catch { invalid('source calldata cannot be decoded as SeaDrop mintPublic'); }
    const [nftContract, feeRecipient, , quantity] = decoded;
    const built = buildSeaDropMintCall({ contractAddress:nftContract, seaDropAddress:callTarget,
      arguments:[feeRecipient, walletAddress, quantity], walletAddress, valueWei:value });
    return { contractAddress:nftContract, callTarget, calldata:built.calldata, valueWei:value,
      methodSignature:built.method.signature, preview:built.preview };
  }

  const gatedMethod = ['mintAllowList', 'mintSigned', 'mintAllowedTokenHolder'].find(name => (
    SEADROP_GATED_INTERFACE.getFunction(name).selector.toLowerCase() === selector
  ));
  if (gatedMethod) {
    invalid(`SeaDrop ${gatedMethod} authorization belongs to the watched wallet and cannot be copied safely`);
  }

  const archetypeMethod = ['mint', 'mintTo'].find(name => (
    ARCHETYPE_INTERFACE.getFunction(name).selector.toLowerCase() === selector
  ));
  if (archetypeMethod) {
    let decoded;
    try { decoded = ARCHETYPE_INTERFACE.decodeFunctionData(archetypeMethod, data); }
    catch { invalid(`source calldata cannot be decoded as Archetype ${archetypeMethod}`); }
    const values = Array.from(decoded);
    const [auth] = values;
    const signature = values[archetypeMethod === 'mintTo' ? 4 : 3];
    if (String(auth.key).toLowerCase() !== ARCHETYPE_PUBLIC_KEY || auth.proof.length || signature !== '0x') {
      invalid(`Archetype ${archetypeMethod} authorization belongs to the watched wallet and cannot be copied safely`);
    }
    if (archetypeMethod === 'mintTo') values[2] = walletAddress;
    let calldata;
    try { calldata = ARCHETYPE_INTERFACE.encodeFunctionData(archetypeMethod, values); }
    catch { invalid(`source calldata cannot be safely re-encoded as Archetype ${archetypeMethod}`); }
    const quantity = BigInt(values[1]);
    if (quantity < 1n || quantity > 100n) invalid('source mint quantity must be between 1 and 100');
    const preview = validateOpenSeaMintCall({ built:{to:callTarget,data:calldata,valueWei:value},
      contractAddress:callTarget, quantity, minterAddress:walletAddress });
    return { contractAddress:callTarget, callTarget, calldata, valueWei:value,
      methodSignature:preview.methodSignature, preview };
  }

  invalid('source call is not one of GhostMint\'s recognized mint methods');
}

function formatCopyMintPreview(preview) {
  return {
    ...preview,
    nativeValueWei:String(preview.nativeValueWei ?? 0),
    nativeValue:preview.nativeValue ?? formatEther(preview.nativeValueWei ?? 0),
  };
}

module.exports = { formatCopyMintPreview, prepareCopyMintCall };

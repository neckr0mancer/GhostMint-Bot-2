const { formatEther, Interface, isAddress } = require('ethers');
const { ValidationError } = require('../validation/domain');
const { MINT_PUBLIC_FRAGMENT, SEADROP_CORE_INTERFACE, SEADROP_MINT_SIGNATURE } = require('./seaDropRegistry');

// OpenSea's drop builder is not SeaDrop-only. Archetype ERC-721A collections (including the
// verified Raised Fist contract on Robinhood Chain) return calldata for one of these two known
// functions. Keep this as a small, explicit ABI allowlist: it is not arbitrary-calldata support.
const ARCHETYPE_INTERFACE = new Interface([
  'function mint((bytes32 key,bytes32[] proof) auth,uint256 quantity,address affiliate,bytes signature) payable',
  'function mintTo((bytes32 key,bytes32[] proof) auth,uint256 quantity,address to,address affiliate,bytes signature) payable',
  'function computePrice(bytes32 key,uint256 quantity,bool affiliateUsed) view returns (uint256)',
]);

const ARCHETYPE_PUBLIC_KEY = `0x${'00'.repeat(32)}`;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function invalid(field, message) { throw new ValidationError({ field, message }); }

function resolveAddress(value, field, walletAddress) {
  const resolved = value === '$wallet' ? walletAddress : value;
  if (!isAddress(resolved)) invalid(field, 'must be a valid Ethereum address');
  return resolved;
}

function quantity(value, field) {
  if (typeof value === 'boolean' || !/^(0|[1-9]\d*)$/.test(String(value))) invalid(field, 'must be an unsigned integer');
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > 100n) invalid(field, 'must be between 1 and 100');
  return parsed;
}

function nativeValue(valueWei) {
  let parsed;
  try { parsed = BigInt(valueWei); } catch { invalid('valueWei', 'must be a non-negative integer amount in wei'); }
  if (parsed < 0n || parsed > 10n ** 78n - 1n) invalid('valueWei', 'must be a non-negative database-safe integer amount in wei');
  return parsed;
}

// quantity * mintPrice, per SeaDrop's own _checkCorrectPayment -- msg.value must equal this
// exactly; feeBps is split out of it at payout time, never added on top.
function computeSeaDropValueWei({ mintPriceWei, quantity: qty }) {
  return BigInt(mintPriceWei) * BigInt(qty);
}

// Archetype's public invite uses the zero key, no proof, no affiliate and no signature. This is a
// finite, audited call shape (selector 0x4a21a2df), not arbitrary calldata. OpenSea normally
// supplies the same bytes, but some indexed collections return 404 from its mint-builder even
// while the public on-chain invite is live. In that case callers may read computePrice() and build
// this exact public call locally; the transaction engine still estimates, balance-checks and
// simulates it before anything can be broadcast.
function buildPublicArchetypeMintCall({ contractAddress, quantity: rawQuantity, valueWei }) {
  if (!isAddress(contractAddress)) invalid('contractAddress', 'must be a valid Ethereum address');
  const qty = quantity(rawQuantity, 'quantity');
  const value = nativeValue(valueWei);
  const auth = { key: ARCHETYPE_PUBLIC_KEY, proof: [] };
  const calldata = ARCHETYPE_INTERFACE.encodeFunctionData('mint', [auth, qty, ZERO_ADDRESS, '0x']);
  return { to: contractAddress, data: calldata, valueWei: value.toString() };
}

// `arguments` holds the 3 mintPublic parameters other than the NFT contract itself
// (feeRecipient, minterIfNotPayer, quantity) -- contractAddress is the single source of truth for
// the NFT address, mirroring how buildMintCall keeps it separate from `arguments` rather than
// duplicating it inside the array.
function buildSeaDropMintCall({ contractAddress, seaDropAddress, arguments: values = [], walletAddress, valueWei = 0n }) {
  if (!isAddress(contractAddress)) invalid('contractAddress', 'must be a valid Ethereum address');
  if (!isAddress(seaDropAddress)) invalid('seaDropAddress', 'must be a valid Ethereum address');
  if (!Array.isArray(values) || values.length !== 3) invalid('arguments', 'must contain exactly 3 values: feeRecipient, minter, quantity');
  const [feeRecipient, minter = '$wallet', rawQuantity] = values;
  const resolvedFeeRecipient = resolveAddress(feeRecipient, 'arguments[0]', walletAddress);
  const resolvedMinter = resolveAddress(minter, 'arguments[1]', walletAddress);
  const qty = quantity(rawQuantity, 'arguments[2]');
  const value = nativeValue(valueWei);
  const args = [contractAddress, resolvedFeeRecipient, resolvedMinter, qty];
  let calldata;
  try { calldata = SEADROP_CORE_INTERFACE.encodeFunctionData('mintPublic', args); }
  catch { invalid('arguments', 'could not be encoded for mintPublic'); }
  const preview = {
    contractAddress,
    callTarget: seaDropAddress,
    methodSignature: SEADROP_MINT_SIGNATURE,
    standard: 'SeaDrop',
    arguments: [
      { name: 'nftContract', type: 'address', value: contractAddress },
      { name: 'feeRecipient', type: 'address', value: resolvedFeeRecipient },
      { name: 'minterIfNotPayer', type: 'address', value: resolvedMinter },
      { name: 'quantity', type: 'uint256', value: qty.toString() },
    ],
    nativeValueWei: value.toString(),
    nativeValue: formatEther(value),
  };
  return { abiFragment: MINT_PUBLIC_FRAGMENT, arguments: args, calldata,
    method: { signature: SEADROP_MINT_SIGNATURE, standard: 'SeaDrop' }, preview, valueWei: value };
}

function decodeSeaDropMintCall({ contractAddress, seaDropAddress, calldata, valueWei = 0n }) {
  if (!isAddress(contractAddress)) invalid('contractAddress', 'must be a valid Ethereum address');
  if (!isAddress(seaDropAddress)) invalid('seaDropAddress', 'must be a valid Ethereum address');
  if (typeof calldata !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(calldata) || calldata.length < 10) invalid('calldata', 'must be encoded hexadecimal function calldata');
  if (calldata.slice(0, 10).toLowerCase() !== SEADROP_CORE_INTERFACE.getFunction('mintPublic').selector.toLowerCase()) {
    invalid('calldata', 'does not match the SeaDrop mintPublic signature');
  }
  const value = nativeValue(valueWei);
  let decoded;
  try { decoded = SEADROP_CORE_INTERFACE.decodeFunctionData('mintPublic', calldata); }
  catch { invalid('calldata', 'could not be decoded as mintPublic'); }
  const [nftContract, feeRecipient, minterIfNotPayer, qty] = decoded;
  return {
    contractAddress: nftContract,
    callTarget: seaDropAddress,
    methodSignature: SEADROP_MINT_SIGNATURE,
    standard: 'SeaDrop',
    arguments: [
      { name: 'nftContract', type: 'address', value: nftContract },
      { name: 'feeRecipient', type: 'address', value: feeRecipient },
      { name: 'minterIfNotPayer', type: 'address', value: minterIfNotPayer },
      { name: 'quantity', type: 'uint256', value: qty.toString() },
    ],
    nativeValueWei: value.toString(),
    nativeValue: formatEther(value),
  };
}

// OpenSea's own POST /drops/{slug}/mint resolves stage eligibility server-side (allowlist/GTD/FCFS
// proofs this app has no independent way to construct) and hands back ready-to-sign calldata --
// but that trust only ever covered the eligibility DECISION, not the mechanical shape of what came
// back. Before this, `to`/`data` were signed and broadcast entirely as OpenSea supplied them, with
// nothing decoded or compared against what was actually requested. Verifies the two facts that are
// unambiguous either way -- the NFT contract actually being minted, and the quantity -- reusing
// decodeSeaDropMintCall rather than a second decoder. Deliberately does NOT check
// minterIfNotPayer/feeRecipient: OpenSea's exact encoding for "payer is minter" (zero address vs.
// an explicit wallet address) isn't confirmed against a real live response yet, and a wrong guess
// there would reject legitimate mints, not just catch bad ones -- narrower but certain beats wider
// but guessed on a path that signs and spends real funds.
function decodeArchetypeMintCall({ built, contractAddress, minterAddress }) {
  if (!isAddress(built?.to) || built.to.toLowerCase() !== contractAddress.toLowerCase()) {
    invalid('contractAddress', "OpenSea's calldata targets a different contract than requested -- refusing to sign");
  }
  const selector = String(built.data || '').slice(0, 10).toLowerCase();
  const method = ['mint', 'mintTo'].find(name => ARCHETYPE_INTERFACE.getFunction(name).selector.toLowerCase() === selector);
  if (!method) invalid('calldata', 'does not match a supported OpenSea mint signature');
  let decoded;
  try { decoded = ARCHETYPE_INTERFACE.decodeFunctionData(method, built.data); }
  catch { invalid('calldata', `could not be decoded as Archetype ${method}`); }
  const [auth, qty] = decoded;
  const recipient = method === 'mintTo' ? decoded[2] : minterAddress;
  if (method === 'mintTo' && (!isAddress(minterAddress) || recipient.toLowerCase() !== minterAddress.toLowerCase())) {
    invalid('walletAddress', "OpenSea's calldata sends the mint to a different wallet -- refusing to sign");
  }
  const value = nativeValue(built.valueWei);
  return {
    contractAddress,
    callTarget: built.to,
    methodSignature: ARCHETYPE_INTERFACE.getFunction(method).format('sighash'),
    standard: 'Archetype ERC-721A',
    arguments: [
      { name: 'inviteKey', type: 'bytes32', value: auth.key },
      { name: 'proof', type: 'bytes32[]', value: auth.proof.length ? `proof present (${auth.proof.length} item${auth.proof.length === 1 ? '' : 's'})` : 'no proof' },
      { name: 'quantity', type: 'uint256', value: qty.toString() },
      { name: 'recipient', type: 'address', value: recipient || 'sender wallet' },
      { name: 'signature', type: 'bytes', value: decoded[method === 'mintTo' ? 4 : 3] === '0x' ? 'no signature' : 'signature present' },
    ],
    nativeValueWei: value.toString(),
    nativeValue: formatEther(value),
  };
}

function validateOpenSeaMintCall({ built, contractAddress, quantity: expectedQuantity, minterAddress }) {
  const selector = String(built?.data || '').slice(0, 10).toLowerCase();
  const seaDropSelector = SEADROP_CORE_INTERFACE.getFunction('mintPublic').selector.toLowerCase();
  const decoded = selector === seaDropSelector
    ? decodeSeaDropMintCall({ contractAddress: built.to, seaDropAddress: built.to, calldata: built.data, valueWei: built.valueWei })
    : decodeArchetypeMintCall({ built, contractAddress, minterAddress });
  if (decoded.contractAddress.toLowerCase() !== contractAddress.toLowerCase()) {
    invalid('contractAddress', "OpenSea's calldata targets a different contract than requested -- refusing to sign");
  }
  const decodedQuantity = decoded.arguments.find(arg => arg.name === 'quantity')?.value;
  if (decodedQuantity !== String(expectedQuantity)) {
    invalid('quantity', "OpenSea's calldata mints a different quantity than requested -- refusing to sign");
  }
  return decoded;
}

module.exports = { ARCHETYPE_INTERFACE, ARCHETYPE_PUBLIC_KEY, buildPublicArchetypeMintCall,
  buildSeaDropMintCall, computeSeaDropValueWei, decodeSeaDropMintCall, validateOpenSeaMintCall };

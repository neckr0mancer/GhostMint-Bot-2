const { Interface, formatEther } = require('ethers');
const { ValidationError } = require('../validation/domain');

// GLRTCH Genesis on Robinhood — custom contract, not SeaDrop.
// From live site source: contract 0xda719be13af43757cede32d82f021c13ce29d991
// Public: publicMint(uint256 amount) payable @ 0.0016, max 2
// Glrtchlist: whitelistMint(uint256 amount, uint256 maxAllowance, uint256 price, bytes32[] proof) payable @ 0.0016, max 1, proof from /api/whitelist-proof?address=0x...
const GLRTCH_CONTRACT = '0xda719be13af43757cede32d82f021c13ce29d991';
const GLRTCH_COLLECTION_ABI = [
  'function publicMint(uint256 amount) payable',
  'function whitelistMint(uint256 amount, uint256 maxAllowance, uint256 price, bytes32[] proof) payable',
  'function totalMinted(address) view returns (uint256)',
  'function whitelistMinted(address) view returns (uint256)',
  'function publicMinted(address) view returns (uint256)',
  'function salePhase() view returns (uint8)',
  'function publicMintPrice() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function totalMinted() view returns (uint256)',
  'function maxPublicPerWallet() view returns (uint256)',
];
const GLRTCH_INTERFACE = new Interface(GLRTCH_COLLECTION_ABI);

async function fetchWhitelistProof(walletAddress, fetchFn = fetch) {
  const url = `https://www.glrtch.xyz/api/whitelist-proof?address=${walletAddress}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new ValidationError({ field: 'proof', message: `whitelist proof fetch failed: ${res.status}` });
  const data = await res.json();
  if (!data.eligible) throw new ValidationError({ field: 'proof', message: 'wallet is not on the Glrtchlist allowlist' });
  if (!Array.isArray(data.proof) || data.proof.length === 0) throw new ValidationError({ field: 'proof', message: 'empty proof from Glrtchlist API' });
  return { proof: data.proof, maxAllowance: BigInt(data.maxAllowance), priceWei: BigInt(data.price) };
}

function buildGlrtchPublicCall({ quantity, valueWei }) {
  const qty = BigInt(quantity);
  if (qty < 1n || qty > 100n) throw new ValidationError({ field: 'quantity', message: 'must be between 1 and 100' });
  const calldata = GLRTCH_INTERFACE.encodeFunctionData('publicMint', [qty]);
  return { to: GLRTCH_CONTRACT, data: calldata, valueWei: BigInt(valueWei).toString() };
}

function buildGlrtchWhitelistCall({ quantity, maxAllowance, priceWei, proof }) {
  const qty = BigInt(quantity);
  const allowance = BigInt(maxAllowance);
  const price = BigInt(priceWei);
  if (qty < 1n || qty > 100n) throw new ValidationError({ field: 'quantity', message: 'must be between 1 and 100' });
  if (!Array.isArray(proof) || proof.length === 0 || proof.some(p => typeof p !== 'string' || !p.startsWith('0x'))) {
    throw new ValidationError({ field: 'proof', message: 'must be a non-empty array of bytes32' });
  }
  const calldata = GLRTCH_INTERFACE.encodeFunctionData('whitelistMint', [qty, allowance, price, proof]);
  const valueWei = price * qty;
  return { to: GLRTCH_CONTRACT, data: calldata, valueWei: valueWei.toString() };
}

module.exports = { GLRTCH_CONTRACT, GLRTCH_INTERFACE, GLRTCH_COLLECTION_ABI, fetchWhitelistProof, buildGlrtchPublicCall, buildGlrtchWhitelistCall };

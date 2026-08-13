const { Interface } = require('ethers');

const DEFINITIONS = [
  { signature: 'mint()', inputs: [], standard: 'ERC-721' },
  { signature: 'mint(uint256)', inputs: [{ name: 'quantity', type: 'uint256', role: 'amount' }], standard: 'ERC-721' },
  { signature: 'mint(address,uint256)', inputs: [{ name: 'recipient', type: 'address' }, { name: 'quantity', type: 'uint256', role: 'amount' }], standard: 'ERC-721' },
  { signature: 'mint(uint256,uint256,bytes)', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'amount', type: 'uint256', role: 'amount' }, { name: 'data', type: 'bytes', emptyAllowed: true }], standard: 'ERC-1155' },
  { signature: 'mint(address,uint256,uint256,bytes)', inputs: [{ name: 'recipient', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'amount', type: 'uint256', role: 'amount' }, { name: 'data', type: 'bytes', emptyAllowed: true }], standard: 'ERC-1155' },
  { signature: 'mint(uint256,bytes32[])', inputs: [{ name: 'quantity', type: 'uint256', role: 'amount' }, { name: 'proof', type: 'bytes32[]', authorization: 'proof' }], standard: 'allowlist' },
  { signature: 'mint(address,uint256,bytes32[])', inputs: [{ name: 'recipient', type: 'address' }, { name: 'quantity', type: 'uint256', role: 'amount' }, { name: 'proof', type: 'bytes32[]', authorization: 'proof' }], standard: 'allowlist' },
  { signature: 'mint(uint256,bytes)', inputs: [{ name: 'quantity', type: 'uint256', role: 'amount' }, { name: 'signature', type: 'bytes', authorization: 'signature' }], standard: 'allowlist' },
  { signature: 'mint(address,uint256,bytes)', inputs: [{ name: 'recipient', type: 'address' }, { name: 'quantity', type: 'uint256', role: 'amount' }, { name: 'signature', type: 'bytes', authorization: 'signature' }], standard: 'allowlist' },
];

const MINT_METHODS = Object.freeze(Object.fromEntries(DEFINITIONS.map(definition => {
  const fragment = {
    type: 'function', name: 'mint', stateMutability: 'payable', outputs: [],
    inputs: definition.inputs.map(({ name, type }) => ({ name, type })),
  };
  const iface = new Interface([fragment]);
  const normalized = iface.getFunction('mint').format('sighash');
  if (normalized !== definition.signature) throw new Error(`Invalid built-in mint ABI fragment: ${definition.signature}`);
  return [definition.signature, Object.freeze({ ...definition, fragment: Object.freeze(fragment), iface })];
})));

function getMintMethod(signature) {
  return MINT_METHODS[String(signature || '').replace(/\s+/g, '')] || null;
}

module.exports = { MINT_METHODS, getMintMethod };

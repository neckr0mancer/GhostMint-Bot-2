const assert = require('node:assert/strict');
const test = require('node:test');
const { Interface } = require('ethers');
const { createMintExecutionService } = require('../src/mint/mintExecutionService');
const { buildMintCall, formatMintPreview } = require('../src/mint/mintCall');
const { MINT_METHODS } = require('../src/mint/mintRegistry');
const { createMintService } = require('../src/mint/mintService');
const { createProofResolver } = require('../src/mint/proofResolver');
const { ValidationError } = require('../src/validation/domain');

const WALLET = '0x00000000000000000000000000000000000000A1';
const RECIPIENT = '0x00000000000000000000000000000000000000B2';
const CONTRACT = '0x00000000000000000000000000000000000000C3';
const NODE = `0x${'ab'.repeat(32)}`;

const CASES = [
  ['mint()', []],
  ['mint(uint256)', [2]],
  ['mint(address,uint256)', [RECIPIENT, 2]],
  ['mint(uint256,uint256,bytes)', [7, 3, '0x']],
  ['mint(address,uint256,uint256,bytes)', [RECIPIENT, 7, 3, '0x1234']],
  ['mint(uint256,bytes32[])', [2, [NODE]]],
  ['mint(address,uint256,bytes32[])', [RECIPIENT, 2, [NODE]]],
  ['mint(uint256,bytes)', [2, '0x1234']],
  ['mint(address,uint256,bytes)', [RECIPIENT, 2, '0x1234']],
];

test('every supported mint signature encodes and decodes its validated arguments', () => {
  assert.deepEqual(Object.keys(MINT_METHODS), CASES.map(([signature]) => signature));
  for (const [methodSignature, args] of CASES) {
    const call = buildMintCall({ contractAddress: CONTRACT, methodSignature, arguments: args, walletAddress: WALLET, valueWei: 5n });
    const iface = new Interface([call.abiFragment]);
    assert.equal(iface.getFunction('mint').format('sighash'), methodSignature);
    assert.equal(iface.parseTransaction({ data: call.calldata }).signature, methodSignature);
    assert.equal(call.preview.arguments.length, args.length);
  }
});

test('incorrect argument types and counts fail before transaction simulation', async () => {
  let submitCalls = 0;
  const mintService = createMintService({
    presetRepository: {}, proofResolver: createProofResolver({ fetchJson: async () => { throw new Error('unused'); } }),
    supportedChains: ['ethereum'],
  });
  const execution = createMintExecutionService({ mintService, transactionEngine: { submit: async () => { submitCalls += 1; } } });
  const base = { userId: 'user', wallet: { address: WALLET }, input: {
    contractAddress: CONTRACT, methodSignature: 'mint(address,uint256)', arguments: [RECIPIENT],
    valueWei: 0n, chain: 'ethereum',
  } };
  await assert.rejects(execution.execute(base), ValidationError);
  await assert.rejects(execution.execute({ ...base, input: { ...base.input, arguments: ['not-an-address', 2] } }), ValidationError);
  assert.equal(submitCalls, 0);
});

test('manually entered malformed proof is rejected', () => {
  assert.throws(() => buildMintCall({ contractAddress: CONTRACT, methodSignature: 'mint(uint256,bytes32[])',
    arguments: [1, ['0x1234']], walletAddress: WALLET, valueWei: 0n }), ValidationError);
  assert.throws(() => buildMintCall({ contractAddress: CONTRACT, methodSignature: 'mint(uint256,bytes32[])',
    arguments: [1, []], walletAddress: WALLET, valueWei: 0n }), ValidationError);
});

test('decoded previews are human-readable for ERC-721 and ERC-1155 calls', () => {
  const erc721 = buildMintCall({ contractAddress: CONTRACT, methodSignature: 'mint(address,uint256)',
    arguments: [RECIPIENT, 2], walletAddress: WALLET, valueWei: 10n });
  const erc1155 = buildMintCall({ contractAddress: CONTRACT, methodSignature: 'mint(address,uint256,uint256,bytes)',
    arguments: [RECIPIENT, 77, 3, '0x'], walletAddress: WALLET, valueWei: 20n });
  assert.match(formatMintPreview(erc721.preview), /recipient: 0x.*B2/i);
  assert.match(formatMintPreview(erc721.preview), /quantity: 2/);
  assert.match(formatMintPreview(erc1155.preview), /tokenId: 77/);
  assert.match(formatMintPreview(erc1155.preview), /amount: 3/);
  assert.match(formatMintPreview(erc1155.preview), /data: empty bytes/);
});

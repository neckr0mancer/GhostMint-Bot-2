const assert = require('node:assert/strict');
const test = require('node:test');
const { Interface, ZeroAddress } = require('ethers');
const { extractMintedTokenIds } = require('../src/transactions/mintReceiptTokens');

const CONTRACT = '0x00000000000000000000000000000000000000C3';
const OTHER_CONTRACT = '0x00000000000000000000000000000000000000F6';
const MINTER = '0x00000000000000000000000000000000000000A1';
const OTHER_ADDRESS = '0x00000000000000000000000000000000000000B2';

const ERC721_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
const ERC1155_IFACE = new Interface([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
]);

function transferLog({ address = CONTRACT, from = ZeroAddress, to = MINTER, tokenId = 1 }) {
  const { data, topics } = ERC721_IFACE.encodeEventLog('Transfer', [from, to, tokenId]);
  return { address, data, topics };
}

function transferSingleLog({ address = CONTRACT, from = ZeroAddress, to = MINTER, id = 1, value = 1 }) {
  const { data, topics } = ERC1155_IFACE.encodeEventLog('TransferSingle', [MINTER, from, to, id, value]);
  return { address, data, topics };
}

function transferBatchLog({ address = CONTRACT, from = ZeroAddress, to = MINTER, ids = [1, 2], values = [1, 1] }) {
  const { data, topics } = ERC1155_IFACE.encodeEventLog('TransferBatch', [MINTER, from, to, ids, values]);
  return { address, data, topics };
}

test('extracts a single ERC-721 token ID minted to the wallet', () => {
  const receipt = { logs: [transferLog({ tokenId: 42 })] };
  assert.deepEqual(extractMintedTokenIds(receipt, { contractAddress: CONTRACT, minterAddress: MINTER }), ['42']);
});

test('extracts multiple ERC-721 token IDs from a batch mint (several Transfer logs in one receipt)', () => {
  const receipt = { logs: [transferLog({ tokenId: 1 }), transferLog({ tokenId: 2 }), transferLog({ tokenId: 3 })] };
  assert.deepEqual(extractMintedTokenIds(receipt, { contractAddress: CONTRACT, minterAddress: MINTER }), ['1', '2', '3']);
});

test('extracts a single ERC-1155 token ID via TransferSingle', () => {
  const receipt = { logs: [transferSingleLog({ id: 7 })] };
  assert.deepEqual(extractMintedTokenIds(receipt, { contractAddress: CONTRACT, minterAddress: MINTER }), ['7']);
});

test('extracts every ERC-1155 token ID via TransferBatch', () => {
  const receipt = { logs: [transferBatchLog({ ids: [10, 11, 12] })] };
  assert.deepEqual(extractMintedTokenIds(receipt, { contractAddress: CONTRACT, minterAddress: MINTER }), ['10', '11', '12']);
});

test('ignores a Transfer that is not a genuine mint (from is not the zero address)', () => {
  const receipt = { logs: [transferLog({ from: OTHER_ADDRESS, tokenId: 5 })] };
  assert.deepEqual(extractMintedTokenIds(receipt, { contractAddress: CONTRACT, minterAddress: MINTER }), []);
});

test('ignores a mint that landed on a different wallet than the one that submitted the transaction', () => {
  const receipt = { logs: [transferLog({ to: OTHER_ADDRESS, tokenId: 5 })] };
  assert.deepEqual(extractMintedTokenIds(receipt, { contractAddress: CONTRACT, minterAddress: MINTER }), []);
});

test('ignores a Transfer log from a different contract -- never trusts the transaction target (e.g. a SeaDrop core), only the NFT contract itself', () => {
  const receipt = { logs: [transferLog({ address: OTHER_CONTRACT, tokenId: 5 })] };
  assert.deepEqual(extractMintedTokenIds(receipt, { contractAddress: CONTRACT, minterAddress: MINTER }), []);
});

test('skips a malformed/unrelated log on the same contract instead of throwing', () => {
  const receipt = { logs: [{ address: CONTRACT, data: '0xdead', topics: ['0x' + '11'.repeat(32)] }, transferLog({ tokenId: 9 })] };
  assert.deepEqual(extractMintedTokenIds(receipt, { contractAddress: CONTRACT, minterAddress: MINTER }), ['9']);
});

test('deduplicates a token ID that somehow appears twice in the same receipt', () => {
  const receipt = { logs: [transferLog({ tokenId: 1 }), transferLog({ tokenId: 1 })] };
  assert.deepEqual(extractMintedTokenIds(receipt, { contractAddress: CONTRACT, minterAddress: MINTER }), ['1']);
});

test('returns an empty array, never throws, when the receipt has no logs, or contractAddress/minterAddress is missing', () => {
  assert.deepEqual(extractMintedTokenIds({ logs: [] }, { contractAddress: CONTRACT, minterAddress: MINTER }), []);
  assert.deepEqual(extractMintedTokenIds({ logs: [transferLog({})] }, { contractAddress: null, minterAddress: MINTER }), []);
  assert.deepEqual(extractMintedTokenIds({ logs: [transferLog({})] }, { contractAddress: CONTRACT, minterAddress: null }), []);
  assert.deepEqual(extractMintedTokenIds(null, { contractAddress: CONTRACT, minterAddress: MINTER }), []);
});

test('a plain ETH send (no logs at all) never produces a token ID', () => {
  assert.deepEqual(extractMintedTokenIds({ logs: [] }, { contractAddress: undefined, minterAddress: MINTER }), []);
});

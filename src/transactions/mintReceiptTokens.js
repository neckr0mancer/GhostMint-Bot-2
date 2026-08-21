const { Interface, ZeroAddress } = require('ethers');

// ERC-721 doesn't standardize a batch-mint event, and ERC-1155 splits single vs. batch transfers
// into two distinct events -- probing for all three covers every shape a real mint receipt uses.
const TRANSFER_EVENTS_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
];
const TRANSFER_INTERFACE = new Interface(TRANSFER_EVENTS_ABI);

// Section T (docs/WORKLIST.md): extracts which token ID(s) a mint receipt actually received, by
// reading the ERC-721 `Transfer` or ERC-1155 `TransferSingle`/`TransferBatch` event(s) the NFT
// contract itself emits -- filtered to a genuine mint (from the zero address) landing on the
// minting wallet, on the contract that was actually minted. Deliberately NOT the transaction's own
// `to` -- for a SeaDrop mint that's the SeaDrop core, a router, never the NFT contract itself,
// which is the only thing that ever emits Transfer for its own tokens. A log from an unrelated
// contract, a malformed/non-Transfer-shaped log, or a contract that isn't ERC-721/1155 at all is
// silently skipped -- this augments a receipt that has already confirmed, never fails one.
function extractMintedTokenIds(receipt, { contractAddress, minterAddress }) {
  if (!receipt?.logs?.length || !contractAddress || !minterAddress) return [];
  const target = contractAddress.toLowerCase();
  const minter = minterAddress.toLowerCase();
  const tokenIds = [];
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== target) continue;
    let parsed;
    try { parsed = TRANSFER_INTERFACE.parseLog({ topics: log.topics, data: log.data }); }
    catch { continue; }
    if (!parsed) continue;
    const { from, to } = parsed.args;
    if (from !== ZeroAddress || String(to).toLowerCase() !== minter) continue;
    if (parsed.name === 'Transfer') tokenIds.push(parsed.args.tokenId.toString());
    else if (parsed.name === 'TransferSingle') tokenIds.push(parsed.args.id.toString());
    else if (parsed.name === 'TransferBatch') { for (const id of parsed.args.ids) tokenIds.push(id.toString()); }
  }
  return [...new Set(tokenIds)];
}

module.exports = { extractMintedTokenIds };

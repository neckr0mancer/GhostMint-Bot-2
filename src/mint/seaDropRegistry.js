const { Interface } = require('ethers');

// OpenSea's SeaDrop protocol (https://github.com/ProjectOpenSea/seadrop, MIT licensed). A SeaDrop
// NFT contract never exposes a callable public mint function itself -- minting happens on a
// separate, OpenSea-operated "SeaDrop core" contract via mintPublic(nftContract, ...), passing the
// NFT contract's address as an argument rather than as the call target. Confirmed against the real
// ISeaDrop.sol/SeaDrop.sol source: msg.value must equal exactly quantity * mintPrice (feeBps is
// split out of that payment at payout time, never added on top).
const SEADROP_MINT_SIGNATURE = 'mintPublic(address,address,address,uint256)';

const MINT_PUBLIC_FRAGMENT = Object.freeze({
  type: 'function', name: 'mintPublic', stateMutability: 'payable', outputs: [],
  inputs: [
    { name: 'nftContract', type: 'address' },
    { name: 'feeRecipient', type: 'address' },
    { name: 'minterIfNotPayer', type: 'address' },
    { name: 'quantity', type: 'uint256' },
  ],
});

const PUBLIC_DROP_TUPLE = 'tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)';

// The SeaDrop core contract -- everything a wallet actually calls or reads to mint/price a drop.
const SEADROP_CORE_INTERFACE = new Interface([
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  `function getPublicDrop(address nftContract) view returns (${PUBLIC_DROP_TUPLE})`,
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function getFeeRecipientIsAllowed(address nftContract, address feeRecipient) view returns (bool)',
]);

if (SEADROP_CORE_INTERFACE.getFunction('mintPublic').format('sighash') !== SEADROP_MINT_SIGNATURE) {
  throw new Error(`Invalid SeaDrop mintPublic ABI fragment: expected ${SEADROP_MINT_SIGNATURE}`);
}

// The NFT token contract's own event, emitted whenever it (re)configures which SeaDrop core
// contract(s) are allowed to call its gated mintSeaDrop() -- the mechanism used to discover a
// drop's SeaDrop core address when Etherscan's Logs API isn't usable.
const TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE = new Interface([
  'event AllowedSeaDropUpdated(address[] allowedSeaDrop)',
]);

module.exports = {
  SEADROP_MINT_SIGNATURE,
  MINT_PUBLIC_FRAGMENT,
  PUBLIC_DROP_TUPLE,
  SEADROP_CORE_INTERFACE,
  TOKEN_ALLOWED_SEADROP_EVENT_INTERFACE,
};

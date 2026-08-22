const { Interface, formatEther } = require('ethers');

// SeaDrop's own custom Solidity errors (https://github.com/ProjectOpenSea/seadrop, MIT licensed),
// confirmed against the real source -- src/lib/SeaDropErrorsAndEvents.sol -- rather than assumed
// from memory: a wrong selector here would silently misattribute one failure reason as a
// different one, the same discipline seaDropRegistry.js already applies to the mint function
// itself. Limited to the errors actually reachable through mintPublic()
// (SEADROP_MINT_SIGNATURE in seaDropRegistry.js) -- SeaDrop also defines allowlist/signed-mint/
// admin-configuration errors this app's mint call can never trigger, since it only ever calls
// mintPublic, which has no allowlist of its own (that's a different function, mintAllowList,
// this app doesn't use). MintQuantityExceedsMaxSupply is duplicated verbatim on the token
// contract itself (ERC721SeaDropStructsErrorsAndEvents.sol) -- same signature, same selector,
// one entry covers both.
const SEADROP_ERROR_INTERFACE = new Interface([
  'error NotActive(uint256 currentTimestamp, uint256 startTimestamp, uint256 endTimestamp)',
  'error MintQuantityCannotBeZero()',
  'error MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 allowed)',
  'error MintQuantityExceedsMaxSupply(uint256 total, uint256 maxSupply)',
  'error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total, uint256 maxTokenSupplyForStage)',
  'error FeeRecipientNotAllowed()',
  'error IncorrectPayment(uint256 got, uint256 want)',
]);

// Given the raw revert data from a failed call (error.data on an ethers CALL_EXCEPTION -- see
// transactionEngine.js's explainCallFailure, the only caller), returns a specific plain-English
// reason if it matches one of SeaDrop's own errors, or null for anything else (a non-SeaDrop
// contract, an unrecognized SeaDrop error, or no data at all) so the caller can fall through to
// its existing generic handling. Purely selector-based -- safe to try unconditionally against any
// failed call, SeaDrop or not, since a non-matching selector just returns null.
function describeSeaDropError(data) {
  if (!data || data === '0x') return null;
  let parsed;
  try { parsed = SEADROP_ERROR_INTERFACE.parseError(data); }
  catch { return null; }
  if (!parsed) return null;
  const [a, b, c] = parsed.args;
  switch (parsed.name) {
    case 'NotActive': {
      const [currentTimestamp, startTimestamp, endTimestamp] = [a, b, c];
      return currentTimestamp < startTimestamp
        ? `This mint has not opened yet (opens ${new Date(Number(startTimestamp) * 1000).toISOString()}).`
        : `This mint stage has already closed (ended ${new Date(Number(endTimestamp) * 1000).toISOString()}).`;
    }
    case 'MintQuantityCannotBeZero':
      return 'The mint quantity cannot be zero.';
    case 'MintQuantityExceedsMaxMintedPerWallet':
      return `This wallet would hold ${a}, exceeding the ${b} allowed per wallet.`;
    case 'MintQuantityExceedsMaxSupply':
      return `This mint is sold out (would need ${a} of a ${b} total supply).`;
    case 'MintQuantityExceedsMaxTokenSupplyForStage':
      return `This mint stage is sold out (would need ${a} of the ${b} allotted to this stage).`;
    case 'FeeRecipientNotAllowed':
      return 'This contract rejected the configured fee recipient.';
    case 'IncorrectPayment':
      return `Incorrect payment: sent ${formatEther(a)} ETH, this contract requires exactly ${formatEther(b)} ETH.`;
    default:
      return `SeaDrop rejected this mint (${parsed.name}).`;
  }
}

module.exports = { SEADROP_ERROR_INTERFACE, describeSeaDropError };

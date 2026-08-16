const { SEADROP_CORE_INTERFACE } = require('./seaDropRegistry');

// Pure on-chain reads against a SeaDrop core contract whose address is already known (discovery
// lives in seaDropDiscoveryService.js). Mirrors contractValueResolver.js's probe() philosophy:
// any revert, missing function, or decode failure means "unknown", never a thrown error.
function createSeaDropPublicDropResolver({ providerService }) {
  async function getPublicDrop(chain, seaDropAddress, contractAddress) {
    try {
      const data = SEADROP_CORE_INTERFACE.encodeFunctionData('getPublicDrop', [contractAddress]);
      const result = await providerService.perform(chain, 'seaDropPublicDrop', provider =>
        provider.call({ to: seaDropAddress, data }));
      const [drop] = SEADROP_CORE_INTERFACE.decodeFunctionResult('getPublicDrop', result);
      return {
        mintPriceWei: drop.mintPrice.toString(),
        startTime: Number(drop.startTime),
        endTime: Number(drop.endTime),
        maxTotalMintableByWallet: Number(drop.maxTotalMintableByWallet),
        feeBps: Number(drop.feeBps),
        restrictFeeRecipients: Boolean(drop.restrictFeeRecipients),
      };
    } catch {
      return null;
    }
  }

  async function getAllowedFeeRecipients(chain, seaDropAddress, contractAddress) {
    try {
      const data = SEADROP_CORE_INTERFACE.encodeFunctionData('getAllowedFeeRecipients', [contractAddress]);
      const result = await providerService.perform(chain, 'seaDropAllowedFeeRecipients', provider =>
        provider.call({ to: seaDropAddress, data }));
      const [addresses] = SEADROP_CORE_INTERFACE.decodeFunctionResult('getAllowedFeeRecipients', result);
      return [...addresses];
    } catch {
      return [];
    }
  }

  return { getPublicDrop, getAllowedFeeRecipients };
}

module.exports = { createSeaDropPublicDropResolver };

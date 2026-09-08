const { SEADROP_CORE_INTERFACE, SEADROP_TOKEN_INTERFACE } = require('./seaDropRegistry');

// Pure on-chain reads against a SeaDrop core contract whose address is already known (discovery
// lives in seaDropDiscoveryService.js). The get* methods preserve the UI/discovery convention that
// an unreadable value is "unknown"; the read* variants retain the RPC error for safety-critical
// scheduled execution, where "contract absent" and "node temporarily unavailable" must differ.
function createSeaDropPublicDropResolver({ providerService }) {
  async function readPublicDrop(chain, seaDropAddress, contractAddress) {
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
  }

  async function getPublicDrop(chain, seaDropAddress, contractAddress) {
    try { return await readPublicDrop(chain, seaDropAddress, contractAddress); }
    catch { return null; }
  }

  async function readAllowedFeeRecipients(chain, seaDropAddress, contractAddress) {
    const data = SEADROP_CORE_INTERFACE.encodeFunctionData('getAllowedFeeRecipients', [contractAddress]);
    const result = await providerService.perform(chain, 'seaDropAllowedFeeRecipients', provider =>
      provider.call({ to: seaDropAddress, data }));
    const [addresses] = SEADROP_CORE_INTERFACE.decodeFunctionResult('getAllowedFeeRecipients', result);
    return [...addresses];
  }

  async function getAllowedFeeRecipients(chain, seaDropAddress, contractAddress) {
    try { return await readAllowedFeeRecipients(chain, seaDropAddress, contractAddress); }
    catch { return []; }
  }

  async function readMintStats(chain, contractAddress, walletAddress) {
    const data = SEADROP_TOKEN_INTERFACE.encodeFunctionData('getMintStats', [walletAddress]);
    const result = await providerService.perform(chain, 'seaDropMintStats', provider =>
      provider.call({ to: contractAddress, data }));
    const [minterNumMinted, currentTotalSupply, maxSupply] =
      SEADROP_TOKEN_INTERFACE.decodeFunctionResult('getMintStats', result);
    return {
      minterNumMinted:minterNumMinted.toString(),
      currentTotalSupply:currentTotalSupply.toString(),
      maxSupply:maxSupply.toString(),
    };
  }

  async function getMintStats(chain, contractAddress, walletAddress) {
    try { return await readMintStats(chain, contractAddress, walletAddress); }
    catch { return null; }
  }

  return { getPublicDrop, getAllowedFeeRecipients, getMintStats,
    readPublicDrop, readAllowedFeeRecipients, readMintStats };
}

module.exports = { createSeaDropPublicDropResolver };

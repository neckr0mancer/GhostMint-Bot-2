const { formatUnits } = require('ethers');
const { GasLookupError } = require('./etherscanGasService');

// Etherscan's V2 gas oracle doesn't cover every chain this app supports -- confirmed live against
// https://api.etherscan.io/v2/chainlist that Robinhood Chain (chainId 4663) isn't listed at all,
// while every other configured chain is. Rather than hardcode a list of "chains Etherscan doesn't
// support" (which Etherscan could change either direction over time), this always tries Etherscan
// first and falls back to reading fee data directly from the chain's own configured RPC only when
// Etherscan itself reports it can't help -- so a chain gaining or losing Etherscan support just
// works without a code change here.
//
// The RPC fallback can't reproduce Etherscan's three real fee tiers (safe/propose/fast are
// Etherscan's own estimation, not something eth_feeHistory/eth_gasPrice exposes directly) --
// safeGasPriceGwei and gasPriceGwei both report the same RPC-suggested price, and
// maxFeePerGasGwei uses the RPC's own EIP-1559 maxFeePerGas when the chain provides one, or the
// same figure again on a legacy chain. Less differentiated than Etherscan's real tiers, but a real
// number beats "unavailable" for a chain Etherscan has no data for at all.
function createGasService({ etherscanService, providerService, chains }) {
  async function rpcFallback(chain) {
    const definition = chains[chain];
    if (!definition) throw new GasLookupError('UNSUPPORTED_CHAIN', 'Gas lookup is unavailable for that chain');
    let feeData;
    try {
      feeData = await providerService.perform(chain, 'gasFallback', provider => provider.getFeeData());
    } catch {
      throw new GasLookupError('UNAVAILABLE', 'Gas lookup is temporarily unavailable');
    }
    const baseWei = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (baseWei === null || baseWei === undefined) {
      throw new GasLookupError('PROVIDER_ERROR', 'RPC provider did not return usable fee data');
    }
    const maxWei = feeData.maxFeePerGas ?? baseWei;
    const baseGwei = Number(formatUnits(baseWei, 'gwei'));
    return {
      chain, chainId: definition.chainId,
      safeGasPriceGwei: baseGwei,
      gasPriceGwei: baseGwei,
      maxFeePerGasGwei: Number(formatUnits(maxWei, 'gwei')),
      source: 'rpc-fallback',
    };
  }

  return {
    async lookup(chain) {
      try {
        return await etherscanService.lookup(chain);
      } catch (error) {
        if (!(error instanceof GasLookupError) || !providerService) throw error;
        return rpcFallback(chain);
      }
    },
  };
}

module.exports = { createGasService };

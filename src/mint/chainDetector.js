// Wallets no longer carry a specific EVM chain the way a mint target must; this derives which
// configured chain a contract actually lives on by checking for deployed bytecode. Read-only
// (eth_getCode), never sends a transaction, never guesses -- "no code found on any configured
// chain" is reported as null, not defaulted to anything.
async function detectContractChain({ providerService, supportedChains, contractAddress }) {
  for (const chain of supportedChains) {
    try {
      const code = await providerService.perform(chain, 'detectChain', provider => provider.getCode(contractAddress));
      if (code && code !== '0x') return chain;
    } catch {
      // Unreachable RPC or a chain with no configured provider -- try the next chain rather than fail.
    }
  }
  return null;
}

module.exports = { detectContractChain };

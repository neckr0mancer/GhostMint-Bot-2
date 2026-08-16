const { Interface } = require('ethers');

// ERC-721 does not standardize price, supply cap, or per-wallet limit -- most contracts expose
// them (if at all) under one of these conventional zero-argument view function names. Only
// well-known, read-only, no-argument getters are probed here; this never touches the mint-call
// whitelist in mintRegistry.js and never sends a transaction.
const CANDIDATES = Object.freeze({
  price: ['mintPrice', 'price', 'cost', 'PUBLIC_PRICE', 'publicPrice'],
  maxSupply: ['maxSupply', 'MAX_SUPPLY', 'totalSupply', 'collectionSize'],
  maxPerWallet: ['maxPerWallet', 'maxMintsPerWallet', 'maxPerTx'],
});

function createContractValueResolver({ providerService, repository }) {
  async function probe(chain, contractAddress, functionName) {
    const iface = new Interface([`function ${functionName}() view returns (uint256)`]);
    try {
      const data = await providerService.perform(chain, `resolve:${functionName}`, provider =>
        provider.call({ to: contractAddress, data: iface.encodeFunctionData(functionName, []) }));
      const [value] = iface.decodeFunctionResult(functionName, data);
      return value;
    } catch {
      // Missing function (no fallback -> revert), reverting function, or a non-uint256 return
      // that fails to decode -- all of these mean "unknown", not a resolver failure.
      return undefined;
    }
  }

  async function resolveOne(chain, contractAddress, kind) {
    for (const functionName of CANDIDATES[kind]) {
      const value = await probe(chain, contractAddress, functionName);
      if (value !== undefined) return { value: value.toString(), source: functionName };
    }
    return null;
  }

  async function resolve(chain, contractAddress) {
    const cached = await repository.get(chain, contractAddress);
    if (cached) return cached;
    const [price, maxSupply, maxPerWallet] = await Promise.all([
      resolveOne(chain, contractAddress, 'price'),
      resolveOne(chain, contractAddress, 'maxSupply'),
      resolveOne(chain, contractAddress, 'maxPerWallet'),
    ]);
    return repository.save(chain, contractAddress, { price, maxSupply, maxPerWallet });
  }

  return { resolve };
}

module.exports = { createContractValueResolver, CANDIDATES };

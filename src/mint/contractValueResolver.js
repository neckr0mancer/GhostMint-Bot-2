const { Interface } = require('ethers');

// ERC-721 does not standardize price, supply cap, or per-wallet limit -- most contracts expose
// them (if at all) under one of these conventional zero-argument view function names. Only
// well-known, read-only, no-argument getters are probed here; this never touches the mint-call
// whitelist in mintRegistry.js and never sends a transaction.
const CANDIDATES = Object.freeze({
  price: ['mintPrice', 'price', 'cost', 'PUBLIC_PRICE', 'publicPrice'],
  maxSupply: ['maxSupply', 'MAX_SUPPLY', 'totalSupply', 'collectionSize'],
  maxPerWallet: ['maxPerWallet', 'maxMintsPerWallet', 'maxPerTx'],
  // Deliberately probed separately from maxSupply (whose own candidate list falls back to
  // totalSupply() as a stand-in for a fixed cap on collections with no dedicated max-supply
  // getter) -- this one is read as *current* minted count, so it can be compared against maxSupply
  // to tell "sold out" apart from "still minting" for the contract-details display.
  totalMinted: ['totalSupply', 'totalMinted', '_totalMinted', 'totalMintedSupply'],
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
    const [price, maxSupply, maxPerWallet, totalMinted] = await Promise.all([
      resolveOne(chain, contractAddress, 'price'),
      resolveOne(chain, contractAddress, 'maxSupply'),
      resolveOne(chain, contractAddress, 'maxPerWallet'),
      resolveOne(chain, contractAddress, 'totalMinted'),
    ]);
    return repository.save(chain, contractAddress, { price, maxSupply, maxPerWallet, totalMinted });
  }

  // Section AD Tier 1 (collection info card): current minted supply needs to be live on every
  // card view/Refresh tap, unlike price/maxSupply which this app treats as effectively static and
  // caches forever via resolve() above. Deliberately bypasses repository.get()/save() entirely --
  // reusing resolve()'s cache would be actively wrong here, not just stale: contract_value_cache
  // is one shared row per (chain, contractAddress), and a SeaDrop or OpenSea-only save may have
  // already created that row with total_minted left NULL, which would make repository.get() return
  // that row as "cached" forever and resolve() would never probe totalMinted for it at all.
  async function probeTotalMinted(chain, contractAddress) {
    return resolveOne(chain, contractAddress, 'totalMinted');
  }

  // For a SeaDrop-detected contract, called instead of resolve() -- SeaDrop's own PublicDrop struct
  // has no supply-cap field (confirmed against the real ABI: mintPrice/startTime/endTime/
  // maxTotalMintableByWallet/feeBps/restrictFeeRecipients only), so a SeaDrop contract's maxSupply
  // was previously hardcoded null everywhere, silently dropping the "Max supply" line and the
  // Minted stat's "/maxSupply" denominator from every SeaDrop collection card on both platforms.
  // The cap, if the token exposes one at all, still lives on the NFT token contract itself under
  // one of the same conventional getters non-SeaDrop contracts use -- but reusing resolve()'s full
  // probe (and its cache) here would also probe price/maxPerWallet against a SeaDrop token contract
  // that never exposes its real public mint price on itself, same cache-collision risk
  // probeTotalMinted above already avoids by bypassing repository.get()/save() entirely.
  async function probeMaxSupply(chain, contractAddress) {
    return resolveOne(chain, contractAddress, 'maxSupply');
  }

  return { resolve, probeTotalMinted, probeMaxSupply };
}

module.exports = { createContractValueResolver, CANDIDATES };

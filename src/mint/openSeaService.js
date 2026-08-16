const axios = require('axios');

// This app's internal chain names -> OpenSea's own chain identifiers. Chains with no entry here
// (e.g. a custom/obscure chain OpenSea has never indexed) are simply "not looked up" -- same
// "unknown is a valid outcome, never a thrown error" philosophy as seaDropDiscoveryService.js.
const OPENSEA_CHAIN_SLUGS = Object.freeze({
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  polygon: 'matic',
  sepolia: 'sepolia',
});

// Collection metadata only (name/description/image/floor price) for the "what is this contract"
// display -- never consulted for price resolution, spend/gas ceilings, or mint execution, so a
// missing API key, an unsupported chain, or an OpenSea outage degrades to "no metadata available"
// rather than blocking anything. Two API calls are needed because OpenSea's contract lookup only
// returns a collection slug, not the collection's own name/image/stats.
function createOpenSeaService({ apiKey, repository, baseUrl = 'https://api.opensea.io/api/v2',
  http = axios, timeoutMs = 8_000 }) {
  async function fetchCollectionSlug(openSeaChain, contractAddress) {
    const response = await http.get(`${baseUrl}/chain/${openSeaChain}/contract/${contractAddress}`,
      { timeout: timeoutMs, headers: { 'x-api-key': apiKey } });
    return response.data?.collection || null;
  }

  async function fetchCollectionDetails(slug) {
    const [collection, stats] = await Promise.allSettled([
      http.get(`${baseUrl}/collections/${slug}`, { timeout: timeoutMs, headers: { 'x-api-key': apiKey } }),
      http.get(`${baseUrl}/collections/${slug}/stats`, { timeout: timeoutMs, headers: { 'x-api-key': apiKey } }),
    ]);
    return {
      collection: collection.status === 'fulfilled' ? collection.value.data : null,
      stats: stats.status === 'fulfilled' ? stats.value.data : null,
    };
  }

  async function getCollectionMetadata(chain, contractAddress) {
    const cached = await repository.getOpenSea(chain, contractAddress);
    if (cached) return cached;

    const openSeaChain = OPENSEA_CHAIN_SLUGS[chain];
    let metadata = { name: null, description: null, imageUrl: null, floorPrice: null, floorPriceSymbol: null };
    if (apiKey && openSeaChain) {
      try {
        const slug = await fetchCollectionSlug(openSeaChain, contractAddress);
        if (slug) {
          const { collection, stats } = await fetchCollectionDetails(slug);
          if (collection) {
            metadata = {
              name: collection.name || null,
              description: collection.description || null,
              imageUrl: collection.image_url || null,
              floorPrice: stats?.total?.floor_price ?? null,
              floorPriceSymbol: stats?.total?.floor_price_symbol ?? null,
            };
          }
        }
      } catch {
        // Network failure, timeout, 404 (contract not on OpenSea), rate limit -- all the same
        // "nothing to show" outcome as an unconfigured key or unsupported chain.
      }
    }
    return repository.saveOpenSea(chain, contractAddress, metadata);
  }

  return { getCollectionMetadata };
}

module.exports = { OPENSEA_CHAIN_SLUGS, createOpenSeaService };

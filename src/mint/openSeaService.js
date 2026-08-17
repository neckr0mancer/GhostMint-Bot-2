const axios = require('axios');

// This app's internal chain names -> OpenSea's own chain identifiers. Chains with no entry here
// (e.g. a custom/obscure chain OpenSea has never indexed) are simply "not looked up" -- same
// "unknown is a valid outcome, never a thrown error" philosophy as seaDropDiscoveryService.js.
const OPENSEA_CHAIN_SLUGS = Object.freeze({
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  polygon: 'matic',
  robinhood: 'robinhood',
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

  // Section Q: resolves an opensea.io collection link (parsed to a slug by the caller) to its
  // on-chain contract, so pasting a link behaves exactly like pasting the contract it refers to.
  // Reverses fetchCollectionSlug's direction using the same /collections/{slug} endpoint
  // fetchCollectionDetails already calls, since OpenSea's v2 response for a collection includes
  // every chain it's deployed to -- no new endpoint, just reading a field this file didn't need
  // before. supportedChains scopes the match to a chain this app can actually mint on; a
  // multi-chain collection deployed on several of GhostMint's supported chains resolves to
  // whichever one appears first in OpenSea's own contracts list.
  async function resolveCollectionContract(slug, supportedChains) {
    if (!apiKey) return null;
    let response;
    try {
      response = await http.get(`${baseUrl}/collections/${slug}`, { timeout: timeoutMs, headers: { 'x-api-key': apiKey } });
    } catch {
      return null;
    }
    const contracts = Array.isArray(response.data?.contracts) ? response.data.contracts : [];
    const reverseChainSlugs = Object.fromEntries(
      Object.entries(OPENSEA_CHAIN_SLUGS).map(([internalChain, openSeaChain]) => [openSeaChain, internalChain]),
    );
    for (const entry of contracts) {
      const internalChain = reverseChainSlugs[entry?.chain];
      if (internalChain && supportedChains.includes(internalChain) && typeof entry?.address === 'string') {
        return { chain: internalChain, contractAddress: entry.address };
      }
    }
    return null;
  }

  // Section AD Tier 1 (collection info card): live market stats, deliberately never cached via
  // repository the way getCollectionMetadata's name/description/floor are -- volume is a rolling
  // window (1d/7d/30d) that goes stale within minutes, so every card view/Refresh tap calls this
  // fresh rather than serving a resolvedAt-stamped row that would quickly lie. Reuses the same
  // /collections/{slug}/stats response getCollectionMetadata already fetches via
  // fetchCollectionDetails, just called directly here (only stats are needed, not the paired
  // /collections/{slug} metadata call) and reading fields that response always had but nothing
  // parsed before now: total.volume/sales/num_owners and the one_day/seven_day/thirty_day entries
  // in intervals[] (confirmed present in a real response, live-checked against the actual API).
  const EMPTY_STATS = Object.freeze({
    floorPrice: null, floorPriceSymbol: null, numOwners: null,
    volume: Object.freeze({ oneDay: null, sevenDay: null, thirtyDay: null, allTime: null }),
    sales: Object.freeze({ oneDay: null, sevenDay: null, thirtyDay: null, allTime: null }),
  });

  function intervalValue(intervals, name, field) {
    const entry = Array.isArray(intervals) ? intervals.find(item => item?.interval === name) : null;
    return entry && typeof entry[field] === 'number' ? entry[field] : null;
  }

  async function getCollectionStats(chain, contractAddress) {
    const openSeaChain = OPENSEA_CHAIN_SLUGS[chain];
    if (!apiKey || !openSeaChain) return EMPTY_STATS;
    try {
      const slug = await fetchCollectionSlug(openSeaChain, contractAddress);
      if (!slug) return EMPTY_STATS;
      const response = await http.get(`${baseUrl}/collections/${slug}/stats`, { timeout: timeoutMs, headers: { 'x-api-key': apiKey } });
      const total = response.data?.total;
      const intervals = response.data?.intervals;
      return {
        floorPrice: total?.floor_price ?? null,
        floorPriceSymbol: total?.floor_price_symbol ?? null,
        numOwners: typeof total?.num_owners === 'number' ? total.num_owners : null,
        volume: {
          oneDay: intervalValue(intervals, 'one_day', 'volume'),
          sevenDay: intervalValue(intervals, 'seven_day', 'volume'),
          thirtyDay: intervalValue(intervals, 'thirty_day', 'volume'),
          allTime: typeof total?.volume === 'number' ? total.volume : null,
        },
        sales: {
          oneDay: intervalValue(intervals, 'one_day', 'sales'),
          sevenDay: intervalValue(intervals, 'seven_day', 'sales'),
          thirtyDay: intervalValue(intervals, 'thirty_day', 'sales'),
          allTime: typeof total?.sales === 'number' ? total.sales : null,
        },
      };
    } catch {
      // Network failure, timeout, 404, rate limit -- same "nothing to show" outcome as an
      // unconfigured key or unsupported chain, never a thrown error into the card renderer.
      return EMPTY_STATS;
    }
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

  return { getCollectionMetadata, resolveCollectionContract, getCollectionStats };
}

module.exports = { OPENSEA_CHAIN_SLUGS, createOpenSeaService };

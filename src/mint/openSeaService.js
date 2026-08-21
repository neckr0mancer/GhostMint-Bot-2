const axios = require('axios');
const { ValidationError } = require('../validation/domain');

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
  http = axios, timeoutMs = 8_000, log = () => {} }) {
  // Every catch block below was silently swallowing whatever actually went wrong (a bad/expired
  // API key, a network failure, a genuine OpenSea outage) -- correct for the card renderer, which
  // must never see a thrown error, but it meant a real, ongoing failure (e.g. an invalid key) left
  // no trace anywhere. This logs the failure's shape without ever leaking the key itself.
  function logFailure(operation, chain, contractAddress, error) {
    const status = error?.response?.status;
    const detail = status ? `HTTP ${status}` : (error?.code || error?.message || 'unknown error');
    log(`OpenSea ${operation} failed for ${chain}:${contractAddress}: ${detail}`);
  }
  async function fetchCollectionSlug(openSeaChain, contractAddress) {
    const response = await http.get(`${baseUrl}/chain/${openSeaChain}/contract/${contractAddress}`,
      { timeout: timeoutMs, maxContentLength: 1_000_000, headers: { 'x-api-key': apiKey } });
    return response.data?.collection || null;
  }

  async function fetchCollectionDetails(slug) {
    const [collection, stats] = await Promise.allSettled([
      http.get(`${baseUrl}/collections/${slug}`, { timeout: timeoutMs, maxContentLength: 1_000_000, headers: { 'x-api-key': apiKey } }),
      http.get(`${baseUrl}/collections/${slug}/stats`, { timeout: timeoutMs, maxContentLength: 1_000_000, headers: { 'x-api-key': apiKey } }),
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
      response = await http.get(`${baseUrl}/collections/${slug}`, { timeout: timeoutMs, maxContentLength: 1_000_000, headers: { 'x-api-key': apiKey } });
    } catch (error) {
      logFailure('resolveCollectionContract', 'n/a', slug, error);
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
      const response = await http.get(`${baseUrl}/collections/${slug}/stats`, { timeout: timeoutMs, maxContentLength: 1_000_000, headers: { 'x-api-key': apiKey } });
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
    } catch (error) {
      // Network failure, timeout, 404, rate limit -- same "nothing to show" outcome as an
      // unconfigured key or unsupported chain, never a thrown error into the card renderer.
      logFailure('getCollectionStats', chain, contractAddress, error);
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
      } catch (error) {
        // Network failure, timeout, 404 (contract not on OpenSea), rate limit -- all the same
        // "nothing to show" outcome as an unconfigured key or unsupported chain.
        logFailure('getCollectionMetadata', chain, contractAddress, error);
      }
    }
    return repository.saveOpenSea(chain, contractAddress, metadata);
  }

  // Section AF -- "can't you read the phases from OpenSea and the contract?" On-chain SeaDrop only
  // ever exposes ONE mutable PublicDrop struct (whatever stage is currently configured), so it can
  // never show what's coming next. OpenSea's own Drops API is the real, non-guessed source for that:
  // GET /drops/{slug} (live-verified against docs.opensea.io/reference/get_drop_by_slug) returns the
  // full stage list plus which one (if any) is active right now and which is next by start_time.
  // Same "unknown is a valid outcome" shape as everything else here -- a 404 (not an OpenSea-tracked
  // drop), no API key, an unsupported chain, or a network failure all just mean "no phase data",
  // never a thrown error into the card renderer.
  function normalizeStage(stage) {
    if (!stage) return null;
    return {
      uuid: stage.uuid || null,
      label: stage.label || null,
      // The API returns ISO 8601 strings; every other timestamp this app already threads through
      // menus (SeaDrop's own on-chain startTime/endTime) is unix seconds, so this converts once here
      // rather than making every caller/renderer handle two different time representations.
      startTime: stage.start_time ? Math.floor(Date.parse(stage.start_time) / 1000) : null,
      endTime: stage.end_time ? Math.floor(Date.parse(stage.end_time) / 1000) : null,
      // Decimal wei string per the docs -- left as a string here (this module has no ethers
      // dependency and stays presentation-agnostic); botCommandService converts to an ETH number
      // the same way it already does for every other on-chain/API price it resolves.
      priceWei: stage.price ?? null,
      maxPerWallet: stage.max_per_wallet !== undefined && stage.max_per_wallet !== null ? Number(stage.max_per_wallet) : null,
      stageType: stage.stage_type || null,
    };
  }

  async function getDrop(chain, contractAddress) {
    const openSeaChain = OPENSEA_CHAIN_SLUGS[chain];
    if (!apiKey || !openSeaChain) return null;
    try {
      const slug = await fetchCollectionSlug(openSeaChain, contractAddress);
      if (!slug) return null;
      const response = await http.get(`${baseUrl}/drops/${slug}`, { timeout: timeoutMs, maxContentLength: 1_000_000, headers: { 'x-api-key': apiKey } });
      const data = response.data;
      if (!data) return null;
      return {
        isMinting: Boolean(data.is_minting),
        dropType: data.drop_type || null,
        maxSupply: data.max_supply !== undefined && data.max_supply !== null ? Number(data.max_supply) : null,
        openSeaUrl: data.opensea_url || null,
        activeStage: normalizeStage(data.active_stage),
        nextStage: normalizeStage(data.next_stage),
        stages: Array.isArray(data.stages) ? data.stages.map(normalizeStage) : [],
      };
    } catch (error) {
      // A plain (non-OpenSea-drop) contract 404s here -- same "nothing to show" outcome as every
      // other failure mode, not an error worth surfacing to the card renderer. Not logged: it's the
      // overwhelmingly common case (most contracts simply aren't OpenSea-tracked drops) and would
      // just be noise. Everything else (a bad API key, a network failure, a real OpenSea outage) is
      // genuinely unexpected and worth a trace.
      if (error?.response?.status !== 404) logFailure('getDrop', chain, contractAddress, error);
      return null;
    }
  }

  // Section AF -- the point of all of this: an allowlist/GTD/FCFS SeaDrop stage has no on-chain way
  // for this app to prove eligibility (no merkle proof, no signature this app can produce), because
  // that verification lives entirely in OpenSea's own backend. POST /drops/{slug}/mint (live-verified
  // against docs.opensea.io/reference/build_drop_mint_transaction) is OpenSea doing that verification
  // itself and handing back ready-to-sign calldata -- "no wallet authentication is required, only an
  // API key... stage selection is handled automatically by the backend." This app still signs and
  // broadcasts it through its own wallet/transactionEngine exactly like every other mint (governance
  // ceilings, simulation, gas ceiling all still apply); OpenSea only ever supplies to/data/value.
  //
  // Unlike every other function here, a failure is NOT always "nothing to show" -- 409/422 are
  // OpenSea telling us definitively that this wallet cannot mint right now (not active yet, sold
  // out, not on the allowlist, already at its limit), which is real information a mint attempt must
  // surface honestly, not swallow. Everything else (no key, unsupported chain, not a drop, network
  // failure, 5xx) is genuine unavailability, not ineligibility, and returns null so the caller can
  // fall back to this app's own on-chain calldata path instead.
  async function buildMintTransaction(chain, contractAddress, minterAddress, quantity) {
    const openSeaChain = OPENSEA_CHAIN_SLUGS[chain];
    if (!apiKey || !openSeaChain) return null;
    let slug;
    try { slug = await fetchCollectionSlug(openSeaChain, contractAddress); }
    catch (error) { logFailure('buildMintTransaction (slug lookup)', chain, contractAddress, error); return null; }
    if (!slug) return null;
    let response;
    try {
      response = await http.post(`${baseUrl}/drops/${slug}/mint`, { minter: minterAddress, quantity },
        { timeout: timeoutMs, maxContentLength: 1_000_000, headers: { 'x-api-key': apiKey } });
    } catch (error) {
      const status = error?.response?.status;
      const reasons = error?.response?.data?.errors;
      const detail = Array.isArray(reasons) && reasons.length ? reasons.join('; ') : null;
      if (status === 409) {
        throw new ValidationError({ field: 'contractAddress', message: detail || 'this drop is not currently active for minting (not started, ended, or paused)' });
      }
      if (status === 422) {
        throw new ValidationError({ field: 'contractAddress', message: detail || "this wallet can't mint right now (insufficient balance, not on the allowlist, limit reached, or sold out)" });
      }
      // A real mint attempt got no calldata at all -- unlike the read-only functions above, this is
      // always worth a trace, not just the non-404 subset (there is no "expected" failure shape here).
      logFailure('buildMintTransaction', chain, contractAddress, error);
      return null;
    }
    const data = response.data;
    if (!data?.to || !data?.data) return null;
    return { to: data.to, data: data.data, valueWei: BigInt(data.value ?? '0x0').toString(), chain: data.chain };
  }

  return { getCollectionMetadata, resolveCollectionContract, getCollectionStats, getDrop, buildMintTransaction };
}

module.exports = { OPENSEA_CHAIN_SLUGS, createOpenSeaService };

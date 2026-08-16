const axios = require('axios');

// Every chain this app supports pays gas/mint value in one of exactly two native tokens (see
// src/config/index.js's CHAIN_DEFINITIONS) -- ETH everywhere except Polygon (MATIC). Display-only,
// same "unknown is fine" philosophy as openSeaService.js: a missing/unmapped symbol or a failed
// fetch just means no USD figure is shown, never a thrown error.
const COINGECKO_IDS = Object.freeze({ ETH: 'ethereum', MATIC: 'matic-network' });

function createPriceFeedService({ http = axios, baseUrl = 'https://api.coingecko.com/api/v3',
  ttlMs = 5 * 60_000, now = () => Date.now() } = {}) {
  const cache = new Map();

  async function getUsdPrice(symbol) {
    const upper = String(symbol || '').toUpperCase();
    const coingeckoId = COINGECKO_IDS[upper];
    if (!coingeckoId) return null;
    const cached = cache.get(upper);
    if (cached && now() - cached.at < ttlMs) return cached.usd;
    try {
      const response = await http.get(`${baseUrl}/simple/price`,
        { timeout: 8_000, params: { ids: coingeckoId, vs_currencies: 'usd' } });
      const usd = response.data?.[coingeckoId]?.usd;
      if (typeof usd !== 'number') return cached?.usd ?? null;
      cache.set(upper, { usd, at: now() });
      return usd;
    } catch {
      // A stale cached rate is still more useful than nothing; only truly cold (never-fetched)
      // symbols fall all the way through to null.
      return cached?.usd ?? null;
    }
  }

  return { getUsdPrice };
}

module.exports = { COINGECKO_IDS, createPriceFeedService };

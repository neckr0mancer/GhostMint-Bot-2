const axios = require('axios');

// Display-only native-token quotes for every currently supported EVM gas token. A missing mapping
// or provider failure means no fiat annotation is shown; it never becomes a guessed zero and can
// never affect a transaction amount.
const COINGECKO_IDS = Object.freeze({
  ETH: 'ethereum',
  POL: 'polygon-ecosystem-token',
  HYPE: 'hyperliquid',
});
const DISPLAY_CURRENCIES = Object.freeze(['USD','NGN','EUR','GBP','CAD','AUD']);
const DISPLAY_CURRENCY_SET = new Set(DISPLAY_CURRENCIES);

function createPriceFeedService({ http = axios, baseUrl = 'https://api.coingecko.com/api/v3',
  ttlMs = 5 * 60_000, maxProviderAgeMs = 10 * 60_000, failureBackoffMs = 30_000,
  futureClockSkewToleranceMs = 60_000,
  now = () => Date.now() } = {}) {
  const cache = new Map();
  const providerQuotedAt = new Map();
  const inFlight = new Map();
  const retryAfter = new Map();

  function providerQuoteIsStale(providerTimestamp, currentTime) {
    if (!Number.isFinite(providerTimestamp)) return true;
    if (providerTimestamp > currentTime + futureClockSkewToleranceMs) return true;
    return currentTime - providerTimestamp > maxProviderAgeMs;
  }

  function cachedQuote(cacheKey, quote, currentTime, forceStale = false) {
    return { ...quote,
      stale: forceStale || providerQuoteIsStale(providerQuotedAt.get(cacheKey), currentTime) };
  }

  async function getFiatQuote(symbol, currency = 'USD') {
    const upper = String(symbol || '').toUpperCase();
    const fiat = String(currency || '').toUpperCase();
    const coingeckoId = COINGECKO_IDS[upper];
    if (!coingeckoId || !DISPLAY_CURRENCY_SET.has(fiat)) return null;
    const cacheKey = `${upper}:${fiat}`;
    const cached = cache.get(cacheKey);
    const currentTime=now();
    if (cached && currentTime - cached.receivedAt < ttlMs) {
      return cachedQuote(cacheKey, cached, currentTime);
    }
    if ((retryAfter.get(cacheKey)||0)>currentTime) {
      return cached ? cachedQuote(cacheKey, cached, currentTime, true) : null;
    }
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
    const request=(async()=>{
      try {
        const response = await http.get(`${baseUrl}/simple/price`,
          { timeout: 8_000, maxContentLength: 1_000_000,
            params: { ids: coingeckoId, vs_currencies: fiat.toLowerCase(),
              include_last_updated_at: 'true' } });
        const payload=response.data?.[coingeckoId];
        const rate = payload?.[fiat.toLowerCase()];
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
          retryAfter.set(cacheKey,now()+failureBackoffMs);
          return cached ? cachedQuote(cacheKey, cached, now(), true) : null;
        }
        const providerSeconds=Number(payload?.last_updated_at);
        const providerTimestamp=Number.isFinite(providerSeconds)&&providerSeconds>0
          ?providerSeconds*1000:null;
        const receivedAt=now();
        const quote = { symbol:upper,currency:fiat,rate,
          quotedAt:providerTimestamp??receivedAt,receivedAt,
          stale:providerQuoteIsStale(providerTimestamp,receivedAt),source:'coingecko' };
        cache.set(cacheKey, quote);
        providerQuotedAt.set(cacheKey, providerTimestamp);
        retryAfter.delete(cacheKey);
        return { ...quote };
      } catch {
        // A stale cached rate remains useful for display, but it is explicitly labelled stale by
        // the caller. A cold symbol stays unavailable; GhostMint never invents a zero or a rate.
        retryAfter.set(cacheKey,now()+failureBackoffMs);
        return cached ? cachedQuote(cacheKey, cached, now(), true) : null;
      } finally { inFlight.delete(cacheKey); }
    })();
    inFlight.set(cacheKey,request);
    return request;
  }

  async function getUsdPrice(symbol) {
    const quote = await getFiatQuote(symbol, 'USD');
    return quote?.rate ?? null;
  }

  return { getFiatQuote,getUsdPrice };
}

module.exports = { COINGECKO_IDS, DISPLAY_CURRENCIES, createPriceFeedService };

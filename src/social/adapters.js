const { createHash } = require('node:crypto');
const net = require('node:net');
const { URL } = require('node:url');
const axios = require('axios');
const { WATCH_TYPE_PLATFORMS } = require('../validation/domain');

class AdapterError extends Error {
  constructor(method, message, { retryAfterMs = null } = {}) {
    super(message); this.name = 'AdapterError'; this.code = 'SOCIAL_ADAPTER_FAILED';
    this.method = method; this.retryAfterMs = retryAfterMs;
  }
}

function normalizeContent(item, platform) {
  return { id: String(item.id), text: String(item.text || ''), platform,
    url: item.url ? String(item.url) : null, publishedAt: item.publishedAt ? new Date(item.publishedAt).getTime() : Date.now() };
}

function scrapedItems(data, sourceUrl) {
  if (typeof data !== 'string') return null;
  const text = data.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
  return [{ id:`scrape:${sourceUrl}:${createHash('sha256').update(data).digest('hex')}`, text, url:sourceUrl }];
}

function metric(response, header, field) {
  const value = response?.headers?.[header] ?? response?.data?.usage?.[field];
  const parsed = value === undefined || value === null ? null : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isPrivateScraperHostname(hostname) {
  const raw = String(hostname || '').toLowerCase();
  let h = raw;
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      h = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
  } else if (/^0x[0-9a-f]+$/i.test(h)) {
    const n = Number.parseInt(h, 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      h = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
  }
  if (h.includes('.') && h.split('.').some(part => /^0x[0-9a-f]+$/i.test(part))) {
    h = h.split('.').map(part => /^0x[0-9a-f]+$/i.test(part) ? String(Number.parseInt(part, 16)) : part).join('.');
  }
  const ipVersion = net.isIP(h);
  if (ipVersion === 4) {
    if (h === '0.0.0.0' || h === '127.0.0.1') return true;
    if (/^127\./.test(h)) return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    if (/^0\./.test(h)) return true;
    if (h === '169.254.169.254') return true;
    return false;
  }
  if (ipVersion === 6) {
    const lower = h.toLowerCase();
    if (lower === '::1' || lower === '::ffff:127.0.0.1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:') || lower.startsWith('::ffff:10.') || lower.startsWith('::ffff:192.168.') || lower.startsWith('::ffff:172.')) return true;
    return false;
  }
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return true;
  if (h === '169.254.169.254' || h === 'metadata.google.internal' || h.endsWith('.internal')) return true;
  if (h.endsWith('.localhost')) return true;
  return false;
}

function createHttpAdapter(method, { request, endpoint, token, recordUsage = async () => {},
  now = () => Date.now(), defaultPlatform = null }) {
  return {
    method,
    async poll(rule) {
      if (method !== 'scraper' && !endpoint) throw new AdapterError(method, `${method} endpoint is not configured`);
      if (!token && method !== 'scraper') throw new AdapterError(method, `${method} credential is not configured`);
      if (method === 'scraper' && rule.config?.sourceUrl) {
        try {
          const parsed = new URL(rule.config.sourceUrl);
          if (isPrivateScraperHostname(parsed.hostname)) {
            throw new AdapterError(method, 'scraper sourceUrl must not target a private or internal address');
          }
        } catch (error) {
          if (error instanceof AdapterError) throw error;
          throw new AdapterError(method, 'scraper sourceUrl must be a valid HTTP or HTTPS URL');
        }
      }
      const platform = defaultPlatform || WATCH_TYPE_PLATFORMS[rule.type];
      if (!platform) throw new AdapterError(method, `no platform is registered for watch type ${rule.type}`);
      let response;
      let succeeded = false;
      try {
        response = await request({ method: 'get', url: method === 'scraper' ? rule.config.sourceUrl : endpoint,
          headers: token ? { authorization: `Bearer ${token}` } : {}, timeout: 10_000, maxContentLength: 1_000_000, maxRedirects: method === 'scraper' ? 0 : 5,
          params: method === 'scraper' ? undefined : { type: rule.type, config: JSON.stringify(rule.config), cursor:JSON.stringify(rule.cursor) } });
        const raw = method === 'scraper' && typeof response.data === 'string'
          ? scrapedItems(response.data, rule.config.sourceUrl)
          : (Array.isArray(response.data) ? response.data : response.data?.items);
        if (!Array.isArray(raw)) throw new Error('response must contain an items array');
        succeeded = true;
        return { items: raw.map(item => normalizeContent(item, platform)), cursor: response.data?.cursor ?? rule.cursor };
      } catch (error) {
        const retryAfter = Number(error.response?.headers?.['retry-after']);
        throw new AdapterError(method, `${method} request failed`, {
          retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
        });
      } finally {
        await recordUsage({ userId:rule.userId, ruleId:rule.id, ruleName:rule.name, method,
          requestType:'read', providerCostUsd:metric(response, 'x-request-cost-usd', 'costUsd'),
          providerCredits:metric(response, 'x-credits-used', 'credits'), succeeded, requestedAt:now() });
      }
    },
  };
}

function createSocialAdapters({ request = axios.request, officialApi = {}, managedService = {},
  recordUsage, now } = {}) {
  return new Map([
    ['official_api', createHttpAdapter('official_api', { request, endpoint:officialApi.endpoint,
      token:officialApi.token, recordUsage, now })],
    ['managed_service', createHttpAdapter('managed_service', { request, endpoint:managedService.endpoint,
      token:managedService.token, recordUsage, now })],
    ['scraper', createHttpAdapter('scraper', { request, recordUsage, now })],
  ]);
}

module.exports = { AdapterError, createHttpAdapter, createSocialAdapters };

'use strict';

// Production-safe, read-only provider contract probe. This script deliberately imports neither
// server.js nor any database module: it cannot start workers, queue history, run migrations, or
// submit blockchain transactions. The real Railway entrypoint may run it only when the explicit
// one-shot startup flag is enabled; merely configuring the API key must never create recurring
// provider traffic on every deployment.

const { createGoldRushWalletHistoryAdapter, GOLDRUSH_CHAIN_SLUGS } = require('../src/walletHistory/goldRushAdapter');
const { createWalletHistoryProviderRegistry } = require('../src/walletHistory/provider');

const PROBE_ADDRESS = '0x0000000000000000000000000000000000000001';
const MAX_CONCURRENCY = 2;
const STARTUP_PROBE_FLAG = 'GOLDRUSH_HISTORY_PROBE_ON_STARTUP';

function startupProbeEnabled(env = process.env) {
  return String(env[STARTUP_PROBE_FLAG] || '').trim().toLowerCase() === 'true';
}

function configuredChains(raw = process.env.SUPPORTED_CHAINS) {
  return [...new Set(String(raw || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean))];
}

function safeFailure(chain, error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code : 'GOLDRUSH_CHECK_FAILED';
  const status = Number.isInteger(error?.status) ? error.status : null;
  return { chain, ok:false, code, status };
}

async function mapWithConcurrency(values, limit, operation) {
  const results = new Array(values.length);
  let next = 0;
  async function consume() {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from({ length:Math.min(limit, values.length) }, consume));
  return results;
}

async function checkGoldRushWalletHistory({
  apiKey = process.env.GOLDRUSH_API_KEY,
  chains = configuredChains(),
  address = PROBE_ADDRESS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return { skipped:true, reason:'GOLDRUSH_API_KEY is not configured', results:[] };
  }
  const supported = chains.filter(chain => Object.hasOwn(GOLDRUSH_CHAIN_SLUGS, chain));
  const unsupported = chains.filter(chain => !Object.hasOwn(GOLDRUSH_CHAIN_SLUGS, chain))
    .map(chain => ({ chain, ok:false, code:'GOLDRUSH_CHAIN_UNSUPPORTED', status:null }));
  if (!supported.length) return { skipped:false, results:unsupported };

  const adapter = createGoldRushWalletHistoryAdapter({ apiKey, chains:supported, fetchImpl,
    timeoutMs:10_000 });
  const registry = createWalletHistoryProviderRegistry({ adapters:[adapter] });
  const checked = await mapWithConcurrency(supported, MAX_CONCURRENCY, async chain => {
    try {
      const page = await registry.fetchPage({
        chain, providerKey:'goldrush', walletAddress:address, cursor:null, limit:100,
        fromBlock:null, throughBlock:null,
      });
      return { chain, ok:true, transactions:page.transactions.length,
        hasMore:page.hasMore, observedHeadBlock:page.observedHeadBlock };
    } catch (error) {
      return safeFailure(chain, error);
    }
  });
  return { skipped:false, results:[...checked, ...unsupported] };
}

function printResult(result, write = console.log) {
  if (result.skipped) {
    write(`GoldRush wallet-history check skipped: ${result.reason}.`);
    return;
  }
  for (const item of result.results) {
    if (item.ok) {
      write(`GoldRush wallet-history check ${item.chain}: OK (${item.transactions} transaction(s), next=${item.hasMore ? 'yes' : 'no'}, head=${item.observedHeadBlock}).`);
    } else {
      write(`GoldRush wallet-history check ${item.chain}: FAILED (${item.code}${item.status === null ? '' : `, HTTP ${item.status}`}).`);
    }
  }
  const passed = result.results.filter(item => item.ok).length;
  write(`GoldRush wallet-history check complete: ${passed}/${result.results.length} chain(s) passed. No database or blockchain write was performed.`);
}

async function main() {
  try { printResult(await checkGoldRushWalletHistory()); }
  catch { console.log('GoldRush wallet-history check failed safely before a chain response. No database or blockchain write was performed.'); }
}

if (require.main === module) void main();

module.exports = {
  MAX_CONCURRENCY,
  PROBE_ADDRESS,
  STARTUP_PROBE_FLAG,
  checkGoldRushWalletHistory,
  configuredChains,
  mapWithConcurrency,
  printResult,
  safeFailure,
  startupProbeEnabled,
};

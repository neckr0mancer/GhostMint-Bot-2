'use strict';

const { URL } = require('node:url');

const DEFAULT_BASE_URL = 'https://api.covalenthq.com/v1';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

const GOLDRUSH_CHAIN_SLUGS = Object.freeze({
  ethereum:'eth-mainnet',
  base:'base-mainnet',
  arbitrum:'arbitrum-mainnet',
  polygon:'matic-mainnet',
  ink:'ink-mainnet',
  robinhood:'robinhood-mainnet',
  hyperevm:'hyperevm-mainnet',
});

// GoldRush documents `with-internal` on the paginated v3 wallet endpoint only for the chains in
// its current Traces Support matrix. Keep this list explicit: Ink and HyperEVM can return ordinary
// wallet transactions, but GoldRush does not currently document trace coverage for either chain.
const GOLDRUSH_INTERNAL_TRANSFER_CHAINS = new Set([
  'ethereum',
  'base',
  'arbitrum',
  'polygon',
  'robinhood',
]);

class GoldRushWalletHistoryError extends Error {
  constructor(code, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'GoldRushWalletHistoryError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function fail(code, message, details) {
  throw new GoldRushWalletHistoryError(code, message, details);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('GOLDRUSH_RESPONSE_INVALID', 'GoldRush returned an invalid wallet-history response.');
  }
  return value;
}

function decimalString(value, field, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('GOLDRUSH_RESPONSE_INVALID', `GoldRush returned an unsafe ${field}.`);
    }
    return String(value);
  }
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    fail('GOLDRUSH_RESPONSE_INVALID', `GoldRush returned an invalid ${field}.`);
  }
  return value;
}

function address(value, field, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    fail('GOLDRUSH_RESPONSE_INVALID', `GoldRush returned an invalid ${field}.`);
  }
  return value.toLowerCase();
}

function hash(value, field, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail('GOLDRUSH_RESPONSE_INVALID', `GoldRush returned an invalid ${field}.`);
  }
  return value.toLowerCase();
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('GOLDRUSH_RESPONSE_INVALID', 'GoldRush returned an invalid transaction timestamp.');
  }
  return new Date(value).toISOString();
}

function direction(walletAddress, fromAddress, toAddress) {
  const from = fromAddress === walletAddress;
  const to = toAddress === walletAddress;
  if (from && to) return 'self';
  if (from) return 'out';
  if (to) return 'in';
  return 'unknown';
}

function paramValue(decoded, names, fallbackIndex) {
  const params = Array.isArray(decoded?.params) ? decoded.params : [];
  for (const param of params) {
    const name = String(param?.name || '').replace(/^_+/, '').toLowerCase();
    if (names.includes(name)) return param?.value;
  }
  return params[fallbackIndex]?.value ?? null;
}

function standardForLog(log, eventName) {
  const standards = new Set((Array.isArray(log?.supports_erc) ? log.supports_erc : [])
    .map(value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (standards.has('erc1155') || /^transfer(single|batch)$/i.test(eventName)) return 'erc1155';
  if (standards.has('erc721')) return 'erc721';
  if (standards.has('erc20')) return 'erc20';
  return 'unknown';
}

function eventTypeForTransfer(standard, fromAddress, toAddress) {
  if (fromAddress === ZERO_ADDRESS) return 'mint';
  if (toAddress === ZERO_ADDRESS) return 'burn';
  return standard === 'unknown' ? 'other' : `${standard}_transfer`;
}

function movementDetails(log, eventName, batchIndex = null) {
  const details = {
    provider:'goldrush',
    eventName,
    signature:typeof log?.decoded?.signature === 'string' ? log.decoded.signature : null,
    logOffset:log?.log_offset === undefined || log?.log_offset === null
      ? null : decimalString(log.log_offset, 'log offset'),
    contractName:typeof log?.sender_name === 'string' ? log.sender_name : null,
    symbol:typeof log?.sender_contract_ticker_symbol === 'string'
      ? log.sender_contract_ticker_symbol : null,
    decimals:Number.isSafeInteger(log?.sender_contract_decimals)
      ? log.sender_contract_decimals : null,
  };
  if (batchIndex !== null) details.batchIndex = batchIndex;
  return details;
}

function transferMovements(log, index, walletAddress) {
  const eventName = String(log?.decoded?.name || '');
  if (!['Transfer', 'TransferSingle', 'TransferBatch'].includes(eventName)) return [];
  const standard = standardForLog(log, eventName);
  // A custom event called Transfer is not enough evidence that it follows an ERC transfer ABI.
  if (standard === 'unknown') return [];
  const is1155 = eventName === 'TransferSingle' || eventName === 'TransferBatch';
  const fromAddress = address(paramValue(log.decoded, ['from', 'src'], is1155 ? 1 : 0),
    'transfer from address', { nullable:true });
  const toAddress = address(paramValue(log.decoded, ['to', 'dst'], is1155 ? 2 : 1),
    'transfer to address', { nullable:true });
  if (direction(walletAddress, fromAddress, toAddress) === 'unknown') return [];
  const assetAddress = address(log?.sender_address, 'transfer asset address');
  const offset = log?.log_offset === undefined || log?.log_offset === null ? index : log.log_offset;
  const base = {
    eventType:eventTypeForTransfer(standard, fromAddress, toAddress),
    direction:direction(walletAddress, fromAddress, toAddress),
    assetStandard:standard,
    assetAddress,
    fromAddress,
    toAddress,
  };
  if (eventName === 'TransferBatch') {
    const ids = paramValue(log.decoded, ['ids'], 3);
    const values = paramValue(log.decoded, ['values'], 4);
    if (!Array.isArray(ids) || !Array.isArray(values) || ids.length !== values.length) return [];
    return ids.map((tokenId, batchIndex) => ({
      eventLocator:`log:${offset}:${batchIndex}`,
      ...base,
      tokenId:decimalString(tokenId, 'ERC-1155 token id'),
      amountRaw:decimalString(values[batchIndex], 'ERC-1155 amount'),
      details:movementDetails(log, eventName, batchIndex),
    }));
  }
  const rawTokenId = paramValue(log.decoded, ['tokenid', 'id'], is1155 ? 3 : 2);
  const rawAmount = paramValue(log.decoded, ['value', 'amount', 'wad'], is1155 ? 4 : 2);
  return [{
    eventLocator:`log:${offset}`,
    ...base,
    tokenId:standard === 'erc721' || standard === 'erc1155'
      ? decimalString(rawTokenId, 'token id') : null,
    amountRaw:standard === 'erc721' ? '1'
      : decimalString(rawAmount, 'transfer amount', { nullable:true }),
    details:movementDetails(log, eventName),
  }];
}

function approvalMovement(log, index, walletAddress) {
  const eventName = String(log?.decoded?.name || '');
  if (!['Approval', 'ApprovalForAll'].includes(eventName)) return [];
  const standard = standardForLog(log, eventName);
  if (standard === 'unknown') return [];
  const owner = address(paramValue(log.decoded, ['owner', 'account', 'src'], 0),
    'approval owner', { nullable:true });
  const spender = address(paramValue(log.decoded, ['spender', 'operator', 'approved', 'guy'], 1),
    'approval spender', { nullable:true });
  if (direction(walletAddress, owner, spender) === 'unknown') return [];
  const value = paramValue(log.decoded, ['value', 'amount', 'tokenid', 'wad'], 2);
  const offset = log?.log_offset === undefined || log?.log_offset === null ? index : log.log_offset;
  return [{
    eventLocator:`log:${offset}`,
    eventType:'approval',
    direction:direction(walletAddress, owner, spender),
    assetStandard:standard,
    assetAddress:address(log?.sender_address, 'approval asset address'),
    fromAddress:owner,
    toAddress:spender,
    tokenId:standard === 'erc721' && eventName === 'Approval'
      ? decimalString(value, 'approved token id', { nullable:true }) : null,
    amountRaw:standard === 'erc20'
      ? decimalString(value, 'approval amount', { nullable:true }) : null,
    details:movementDetails(log, eventName),
  }];
}

function movementsForTransaction(item, walletAddress, includeInternal) {
  const movements = [];
  const fromAddress = address(item.from_address, 'transaction from address');
  const toAddress = address(item.to_address, 'transaction to address', { nullable:true });
  const valueWei = decimalString(item.value ?? '0', 'transaction value');
  const topLevelDirection = direction(walletAddress, fromAddress, toAddress);
  if (BigInt(valueWei) > 0n && topLevelDirection !== 'unknown') movements.push({
    eventLocator:'native:transaction-value', eventType:'native_transfer',
    direction:topLevelDirection, assetStandard:'native',
    assetAddress:null, fromAddress, toAddress, tokenId:null, amountRaw:valueWei,
    details:{ provider:'goldrush', kind:'top_level_value' },
  });
  const feeWei = decimalString(item.fees_paid, 'network fee', { nullable:true });
  if (feeWei !== null && BigInt(feeWei) > 0n && fromAddress === walletAddress) movements.push({
    eventLocator:'fee:network', eventType:'fee', direction:'out', assetStandard:'native',
    assetAddress:null, fromAddress, toAddress:null, tokenId:null, amountRaw:feeWei,
    details:{ provider:'goldrush', kind:'network_fee' },
  });
  if (includeInternal && !Array.isArray(item.internal_transfers)) {
    fail('GOLDRUSH_RESPONSE_INVALID',
      'GoldRush returned invalid internal-transfer data for a trace-enabled chain.');
  }
  if (includeInternal) for (const [index, transferInput] of item.internal_transfers.entries()) {
    const transfer = plainObject(transferInput);
    const internalFrom = address(transfer.from_address, 'internal transfer from address');
    const internalTo = address(transfer.to_address, 'internal transfer to address');
    const internalValue = decimalString(transfer.value, 'internal transfer value');
    const internalDirection = direction(walletAddress, internalFrom, internalTo);
    if (internalDirection !== 'unknown') movements.push({
      eventLocator:`internal:${index}`, eventType:'native_transfer',
      direction:internalDirection, assetStandard:'native',
      assetAddress:null, fromAddress:internalFrom, toAddress:internalTo, tokenId:null,
      amountRaw:internalValue,
      details:{ provider:'goldrush', kind:'internal_transfer' },
    });
  }
  for (const [index, log] of (Array.isArray(item.log_events) ? item.log_events : []).entries()) {
    try {
      movements.push(...transferMovements(log, index, walletAddress));
      movements.push(...approvalMovement(log, index, walletAddress));
    } catch {
      // Unknown/custom/malformed logs are ignored rather than poisoning the complete API page.
    }
  }
  return movements;
}

function normalizeTransaction(itemInput, walletAddress, { includeInternal }) {
  const item = plainObject(itemInput);
  const fromAddress = address(item.from_address, 'transaction from address');
  const toAddress = address(item.to_address, 'transaction to address', { nullable:true });
  const valueWei = decimalString(item.value ?? '0', 'transaction value');
  const networkFeeWei = decimalString(item.fees_paid, 'network fee', { nullable:true });
  return {
    txHash:hash(item.tx_hash, 'transaction hash'),
    blockNumber:decimalString(item.block_height, 'block height'),
    blockHash:hash(item.block_hash, 'block hash', { nullable:true }),
    transactionIndex:decimalString(item.tx_offset, 'transaction offset', { nullable:true }),
    occurredAt:timestamp(item.block_signed_at),
    fromAddress,
    toAddress,
    nonce:null,
    // The documented transactions_v3 response does not include calldata. Null is deliberate.
    input:null,
    methodSelector:null,
    valueWei,
    gasLimit:decimalString(item.gas_offered, 'gas offered', { nullable:true }),
    gasUsed:decimalString(item.gas_spent, 'gas spent', { nullable:true }),
    effectiveGasPriceWei:decimalString(item.gas_price, 'gas price', { nullable:true }),
    networkFeeWei,
    executionStatus:typeof item.successful === 'boolean'
      ? (item.successful ? 'success' : 'reverted') : 'unknown',
    // The endpoint gives a chain tip but no explicit finality/canonicality proof. The row is stored
    // as observed canonical data and remains unfinalized until a later RPC/reorg verifier upgrades it.
    finalityStatus:'unfinalized',
    canonical:true,
    rawSummary:{
      provider:'goldrush',
      valueQuote:Number.isFinite(item.value_quote) ? item.value_quote : null,
      gasQuote:Number.isFinite(item.gas_quote) ? item.gas_quote : null,
      explorerUrls:(Array.isArray(item.explorers) ? item.explorers : [])
        .map(entry => typeof entry?.url === 'string' ? entry.url : null).filter(Boolean),
      calldataAvailable:false,
      internalTransfersRequested:includeInternal,
      decodedLogCount:Array.isArray(item.log_events) ? item.log_events.length : 0,
    },
    movements:movementsForTransaction(item, walletAddress, includeInternal),
  };
}

function unwrapPayload(payloadInput) {
  const payload = plainObject(payloadInput);
  if (payload.error === true) {
    fail('GOLDRUSH_PROVIDER_ERROR', 'GoldRush could not return wallet history for this chain.');
  }
  return plainObject(payload.data === undefined ? payload : payload.data);
}

function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  if (/^[0-9]+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function createGoldRushWalletHistoryAdapter({ apiKey, chains = Object.keys(GOLDRUSH_CHAIN_SLUGS),
  fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, timeoutMs = 15_000,
  finalityVerifier = null, finalizedOnly = false } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('GoldRush API key is required');
  const token = apiKey.trim();
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new TypeError('timeoutMs must be between 1000 and 120000');
  }
  let parsedBase;
  try { parsedBase = new URL(baseUrl); }
  catch { throw new TypeError('baseUrl must be a valid HTTPS URL'); }
  if (parsedBase.protocol !== 'https:' || parsedBase.username || parsedBase.password) {
    throw new TypeError('baseUrl must be a valid HTTPS URL without embedded credentials');
  }
  if (!Array.isArray(chains)) throw new TypeError('chains must be an array of supported chain keys');
  if (finalityVerifier !== null && typeof finalityVerifier?.verifyPage !== 'function') {
    throw new TypeError('finalityVerifier must expose verifyPage');
  }
  if (typeof finalizedOnly !== 'boolean') throw new TypeError('finalizedOnly must be a boolean');
  if (finalizedOnly && !finalityVerifier) {
    throw new TypeError('finalizedOnly requires a finalityVerifier');
  }
  const configuredChains = [...new Set(chains.map(value => String(value || '').trim().toLowerCase()))];
  if (!configuredChains.length || configuredChains.some(chain => !GOLDRUSH_CHAIN_SLUGS[chain])) {
    throw new TypeError('chains must contain supported GoldRush chain keys');
  }

  return Object.freeze({
    providerKey:'goldrush',
    label:'GoldRush wallet history',
    chains:Object.freeze(configuredChains),
    capabilities:Object.freeze({ transactions:true, movements:true, receipts:false }),
    async fetchPage(request) {
      if (request.fromBlock !== null || request.throughBlock !== null) {
        fail('GOLDRUSH_RANGE_UNSUPPORTED', 'GoldRush page sync does not accept block-range requests.');
      }
      if (request.cursor !== null && (typeof request.cursor !== 'object'
        || Array.isArray(request.cursor)
        || Object.keys(request.cursor).length !== 1
        || !Object.hasOwn(request.cursor, 'page'))) {
        fail('GOLDRUSH_CURSOR_INVALID', 'GoldRush wallet-history cursor is invalid.');
      }
      const page = request.cursor === null ? 0 : request.cursor.page;
      if (!Number.isSafeInteger(page) || page < 0) {
        fail('GOLDRUSH_CURSOR_INVALID', 'GoldRush wallet-history cursor is invalid.');
      }
      const chainSlug = GOLDRUSH_CHAIN_SLUGS[request.chain];
      if (!chainSlug || !configuredChains.includes(request.chain)) {
        fail('GOLDRUSH_CHAIN_UNSUPPORTED', `GoldRush wallet history is not enabled for ${request.chain}.`);
      }
      const includeInternal = GOLDRUSH_INTERNAL_TRANSFER_CHAINS.has(request.chain);
      const url = new URL(`${parsedBase.toString().replace(/\/$/, '')}/${chainSlug}/address/`
        + `${request.walletAddress}/transactions_v3/page/${page}/`);
      url.searchParams.set('block-signed-at-asc', 'true');
      if (includeInternal) url.searchParams.set('with-internal', 'true');
      const controller = new globalThis.AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method:'GET',
          headers:{ authorization:`Bearer ${token}`, accept:'application/json' },
          signal:controller.signal,
        });
      } catch (error) {
        const code = error?.name === 'AbortError' ? 'GOLDRUSH_TIMEOUT' : 'GOLDRUSH_UNAVAILABLE';
        fail(code, code === 'GOLDRUSH_TIMEOUT'
          ? 'GoldRush wallet history timed out.' : 'GoldRush wallet history is temporarily unavailable.');
      } finally { clearTimeout(timer); }
      if (!response?.ok) {
        const status = Number.isInteger(response?.status) ? response.status : null;
        if (status === 401 || status === 403) {
          fail('GOLDRUSH_AUTH_FAILED', 'GoldRush wallet history authorization failed.', { status });
        }
        if (status === 429) {
          fail('GOLDRUSH_RATE_LIMITED', 'GoldRush wallet history is temporarily rate limited.', {
            status, retryAfterMs:retryAfterMs(response),
          });
        }
        fail('GOLDRUSH_UNAVAILABLE', 'GoldRush wallet history is temporarily unavailable.', { status });
      }
      let payload;
      try { payload = await response.json(); }
      catch { fail('GOLDRUSH_RESPONSE_INVALID', 'GoldRush returned invalid wallet-history data.'); }
      const data = unwrapPayload(payload);
      const currentPage = Number(data.current_page);
      if (!Number.isSafeInteger(currentPage) || currentPage !== page) {
        fail('GOLDRUSH_RESPONSE_INVALID', 'GoldRush returned the wrong wallet-history page.');
      }
      const observedHeadBlock = decimalString(data.chain_tip_height, 'chain tip height');
      const items = Array.isArray(data.items) ? data.items : null;
      if (items === null) fail('GOLDRUSH_RESPONSE_INVALID', 'GoldRush returned invalid wallet-history items.');
      const links = plainObject(data.links);
      if (!(links.next === null || (typeof links.next === 'string' && links.next.length > 0))) {
        fail('GOLDRUSH_RESPONSE_INVALID', 'GoldRush returned invalid wallet-history pagination.');
      }
      const hasMore = typeof links.next === 'string';
      let transactions = items.map(item => normalizeTransaction(item, request.walletAddress,
        { includeInternal }));
      let finalizedThroughBlock = null;
      if (finalityVerifier) {
        const verified = await finalityVerifier.verifyPage({
          chain:request.chain,
          observedHeadBlock,
          transactions,
        });
        if (!verified || !Array.isArray(verified.transactions)) {
          fail('GOLDRUSH_RESPONSE_INVALID', 'Wallet-history finality verification failed.');
        }
        transactions = verified.transactions;
        finalizedThroughBlock = verified.finalizedThroughBlock;
      }
      if (finalizedOnly) {
        // GoldRush does not expose a bounded reorg contract. The production runtime therefore
        // retains only rows independently proven canonical and finalized by GhostMint's RPC.
        // Pagination still advances when this removes every row, so a recent-only page cannot
        // stall the worker. A later user-requested generation can observe those rows once final.
        transactions = transactions.filter(transaction => transaction.canonical === true
          && transaction.finalityStatus === 'finalized');
      }
      return {
        chain:request.chain,
        providerKey:'goldrush',
        transactions,
        nextCursor:hasMore ? { page:currentPage + 1 } : null,
        hasMore,
        observedHeadBlock,
        finalizedThroughBlock,
        // Page exhaustion and chain_tip_height are not response-level proof of complete indexed
        // history. A separate verifier must establish coverage before cleanup/provenance can run.
        coverage:{ history:null, provenance:null },
        recheckRange:null,
      };
    },
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  GOLDRUSH_CHAIN_SLUGS,
  GOLDRUSH_INTERNAL_TRANSFER_CHAINS,
  GoldRushWalletHistoryError,
  createGoldRushWalletHistoryAdapter,
};

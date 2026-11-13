'use strict';

const { createHash } = require('node:crypto');

const REQUIRED_CHAINS = Object.freeze([
  'ethereum',
  'base',
  'arbitrum',
  'polygon',
  'ink',
  'robinhood',
  'hyperevm',
]);
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_PAGES_PER_CHAIN = 25;
const GOLDRUSH_PAGE_LIMIT = 100;
const CAPABILITY_NAMES = Object.freeze([
  'pagination',
  'completeness',
  'finality',
  'internalTransfer',
  'reorg',
]);

class GoldRushCanaryValidationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'GoldRushCanaryValidationError';
    this.code = code;
  }
}

function validationError(code, message) {
  throw new GoldRushCanaryValidationError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHashList(value, path, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    validationError('CANARY_MANIFEST_INVALID', `${path} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  const hashes = value.map(hash => {
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
      validationError('CANARY_MANIFEST_INVALID', `${path} contains an invalid transaction hash`);
    }
    return hash.toLowerCase();
  });
  if (new Set(hashes).size !== hashes.length) {
    validationError('CANARY_MANIFEST_INVALID', `${path} must not contain duplicates`);
  }
  return Object.freeze(hashes);
}

function validateManifest(manifest, { maxPages = MAX_PAGES_PER_CHAIN } = {}) {
  if (!isPlainObject(manifest)) {
    validationError('CANARY_MANIFEST_INVALID', 'manifest must be an object');
  }
  if (!Number.isInteger(maxPages) || maxPages < 2 || maxPages > MAX_PAGES_PER_CHAIN) {
    validationError('CANARY_LIMIT_INVALID', `maxPages must be between 2 and ${MAX_PAGES_PER_CHAIN}`);
  }
  const keys = Object.keys(manifest).sort();
  const required = [...REQUIRED_CHAINS].sort();
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
    validationError('CANARY_MANIFEST_INVALID', 'manifest must contain exactly the seven required chains');
  }

  const normalized = {};
  for (const chain of REQUIRED_CHAINS) {
    const entry = manifest[chain];
    if (!isPlainObject(entry)) {
      validationError('CANARY_MANIFEST_INVALID', `${chain} manifest entry must be an object`);
    }
    const allowed = new Set([
      'address',
      'minPages',
      'knownTxHashes',
      'finalizedTxHashes',
      'internalTransferTxHashes',
      'maxRecheckBlocks',
    ]);
    if (Object.keys(entry).some(key => !allowed.has(key)) || Object.keys(entry).length !== allowed.size) {
      validationError('CANARY_MANIFEST_INVALID', `${chain} manifest entry has missing or unsupported fields`);
    }
    if (typeof entry.address !== 'string' || !ADDRESS_PATTERN.test(entry.address)
      || /^0x0{40}$/i.test(entry.address)) {
      validationError('CANARY_MANIFEST_INVALID', `${chain}.address must be an explicit public EVM address`);
    }
    if (!Number.isInteger(entry.minPages) || entry.minPages < 2 || entry.minPages > maxPages) {
      validationError('CANARY_MANIFEST_INVALID', `${chain}.minPages must be between 2 and maxPages`);
    }
    if (!Number.isSafeInteger(entry.maxRecheckBlocks) || entry.maxRecheckBlocks < 1) {
      validationError('CANARY_MANIFEST_INVALID',
        `${chain}.maxRecheckBlocks must be a positive safe integer`);
    }
    const knownTxHashes = normalizeHashList(entry.knownTxHashes, `${chain}.knownTxHashes`);
    const finalizedTxHashes = normalizeHashList(entry.finalizedTxHashes, `${chain}.finalizedTxHashes`);
    const internalTransferTxHashes = normalizeHashList(entry.internalTransferTxHashes,
      `${chain}.internalTransferTxHashes`, { allowEmpty:true });
    const known = new Set(knownTxHashes);
    if ([...finalizedTxHashes, ...internalTransferTxHashes].some(hash => !known.has(hash))) {
      validationError('CANARY_MANIFEST_INVALID',
        `${chain} finalized and internal-transfer hashes must also be known hashes`);
    }
    normalized[chain] = Object.freeze({
      address:entry.address.toLowerCase(),
      minPages:entry.minPages,
      knownTxHashes,
      finalizedTxHashes,
      internalTransferTxHashes,
      maxRecheckBlocks:entry.maxRecheckBlocks,
    });
  }
  return Object.freeze(normalized);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function transactionFingerprint(transaction) {
  return digest({
    txHash:transaction.txHash,
    blockNumber:transaction.blockNumber ?? null,
    blockHash:transaction.blockHash ?? null,
    transactionIndex:transaction.transactionIndex ?? null,
    executionStatus:transaction.executionStatus ?? null,
    finalityStatus:transaction.finalityStatus ?? null,
    canonical:transaction.canonical !== false,
    movements:(Array.isArray(transaction.movements) ? transaction.movements : []).map(movement => ({
      eventLocator:movement?.eventLocator ?? null,
      eventType:movement?.eventType ?? null,
      direction:movement?.direction ?? null,
      assetStandard:movement?.assetStandard ?? null,
      assetAddress:movement?.assetAddress ?? null,
      tokenId:movement?.tokenId ?? null,
      amountRaw:movement?.amountRaw ?? null,
      fromAddress:movement?.fromAddress ?? null,
      toAddress:movement?.toAddress ?? null,
      kind:movement?.details?.kind ?? null,
    })),
  });
}

function pageZeroFingerprint(page) {
  return digest({
    hasMore:page.hasMore,
    nextCursor:page.nextCursor,
    transactions:page.transactions.map(transaction => ({
      txHash:transaction.txHash,
      fingerprint:transactionFingerprint(transaction),
    })),
  });
}

function validatePageShape(page, pageLimit) {
  if (!isPlainObject(page) || !Array.isArray(page.transactions)
    || page.transactions.length > pageLimit || typeof page.hasMore !== 'boolean') return false;
  if ((page.hasMore && (page.nextCursor === null || page.nextCursor === undefined))
    || (!page.hasMore && page.nextCursor !== null)) return false;
  if (!isPlainObject(page.coverage)) return false;
  return page.transactions.every(transaction => isPlainObject(transaction)
    && typeof transaction.txHash === 'string' && HASH_PATTERN.test(transaction.txHash));
}

function completeHistoryRange(page) {
  const history = page?.coverage?.history;
  if (!isPlainObject(history) || history.complete !== true
    || typeof history.fromBlock !== 'string' || !DECIMAL_PATTERN.test(history.fromBlock)
    || typeof history.throughBlock !== 'string' || !DECIMAL_PATTERN.test(history.throughBlock)) return null;
  if (BigInt(history.fromBlock) > BigInt(history.throughBlock)) return null;
  return history;
}

function validRecheckRange(page, history, maxRecheckBlocks) {
  const range = page?.recheckRange;
  if (!history || !isPlainObject(range)
    || typeof range.fromBlock !== 'string' || !DECIMAL_PATTERN.test(range.fromBlock)
    || typeof range.throughBlock !== 'string' || !DECIMAL_PATTERN.test(range.throughBlock)) return false;
  const width = BigInt(range.throughBlock) - BigInt(range.fromBlock) + 1n;
  return BigInt(range.fromBlock) >= BigInt(history.fromBlock)
    && BigInt(range.throughBlock) <= BigInt(history.throughBlock)
    && BigInt(range.fromBlock) <= BigInt(range.throughBlock)
    && BigInt(range.throughBlock) === BigInt(history.throughBlock)
    && width <= BigInt(maxRecheckBlocks);
}

function hasInternalTransfer(transaction) {
  return (Array.isArray(transaction?.movements) ? transaction.movements : []).some(movement =>
    movement?.details?.kind === 'internal_transfer'
      || (typeof movement?.eventLocator === 'string' && movement.eventLocator.startsWith('internal:')));
}

function capability(passed, failureCode) {
  return Object.freeze({ passed, code:passed ? 'PASS' : failureCode });
}

function failedChainResult(chain, code, { pagesFetched = 0, requestCount = 0,
  uniqueTransactions = 0, duplicateTransactions = 0 } = {}) {
  const capabilities = {};
  for (const name of CAPABILITY_NAMES) capabilities[name] = capability(false, code);
  return Object.freeze({
    chain,
    ready:false,
    pagesFetched,
    requestCount,
    uniqueTransactions,
    duplicateTransactions,
    capabilities:Object.freeze(capabilities),
  });
}

async function fetchPage(adapter, chain, address, cursor, pageLimit) {
  return adapter.fetchPage({
    chain,
    providerKey:'goldrush',
    walletAddress:address,
    cursor,
    limit:pageLimit,
    fromBlock:null,
    throughBlock:null,
  });
}

async function inspectChain(adapter, chain, fixture, { maxPages, pageLimit,
  internalTransferSupported }) {
  const transactions = new Map();
  let duplicateTransactions = 0;
  let duplicateConflict = false;
  let cursor = null;
  const seenCursors = new Set([canonicalJson(null)]);
  let cursorLoop = false;
  let pagesFetched = 0;
  let requestCount = 0;
  let firstPageFingerprint = null;
  let terminalPage = null;

  try {
    while (pagesFetched < maxPages) {
      const page = await fetchPage(adapter, chain, fixture.address, cursor, pageLimit);
      requestCount += 1;
      if (!validatePageShape(page, pageLimit)) {
        return failedChainResult(chain, 'PROVIDER_RESPONSE_INVALID', {
          pagesFetched, requestCount, uniqueTransactions:transactions.size, duplicateTransactions,
        });
      }
      pagesFetched += 1;
      if (pagesFetched === 1) firstPageFingerprint = pageZeroFingerprint(page);
      for (const transaction of page.transactions) {
        const txHash = transaction.txHash.toLowerCase();
        const fingerprint = transactionFingerprint(transaction);
        if (transactions.has(txHash)) {
          duplicateTransactions += 1;
          if (transactions.get(txHash).fingerprint !== fingerprint) duplicateConflict = true;
        } else {
          transactions.set(txHash, { transaction, fingerprint });
        }
      }
      if (!page.hasMore) {
        terminalPage = page;
        break;
      }
      const nextCursorKey = canonicalJson(page.nextCursor);
      if (seenCursors.has(nextCursorKey)) {
        cursorLoop = true;
        break;
      }
      seenCursors.add(nextCursorKey);
      cursor = page.nextCursor;
    }

    const restartedPage = await fetchPage(adapter, chain, fixture.address, null, pageLimit);
    requestCount += 1;
    const restartMatches = validatePageShape(restartedPage, pageLimit)
      && firstPageFingerprint !== null
      && pageZeroFingerprint(restartedPage) === firstPageFingerprint;
    const paginationPassed = pagesFetched >= fixture.minPages && !cursorLoop
      && !duplicateConflict && restartMatches;
    let paginationCode = 'PASS';
    if (pagesFetched < fixture.minPages) paginationCode = 'MINIMUM_PAGES_NOT_REACHED';
    else if (cursorLoop) paginationCode = 'CURSOR_DID_NOT_ADVANCE';
    else if (duplicateConflict) paginationCode = 'DUPLICATE_TRANSACTION_CONFLICT';
    else if (!restartMatches) paginationCode = 'PAGE_ZERO_RESTART_MISMATCH';

    const knownObserved = fixture.knownTxHashes.every(hash => transactions.has(hash));
    const history = completeHistoryRange(terminalPage);
    const completenessPassed = Boolean(terminalPage && history && knownObserved);
    const completenessCode = !terminalPage ? 'BOUNDED_SCAN_NOT_COMPLETE'
      : !history ? 'HISTORY_COVERAGE_UNPROVEN'
        : !knownObserved ? 'KNOWN_TRANSACTIONS_NOT_OBSERVED' : 'PASS';

    const finalizedObserved = fixture.finalizedTxHashes.every(hash =>
      transactions.get(hash)?.transaction?.finalityStatus === 'finalized');
    const finalityCode = fixture.finalizedTxHashes.some(hash => !transactions.has(hash))
      ? 'FINALIZED_TRANSACTIONS_NOT_OBSERVED' : 'FINALITY_UNPROVEN';

    let internalObserved = false;
    let internalCode = 'INTERNAL_TRANSFERS_UNSUPPORTED_BY_PROVIDER';
    if (internalTransferSupported) {
      if (fixture.internalTransferTxHashes.length === 0) {
        internalCode = 'INTERNAL_TRANSFER_FIXTURE_REQUIRED';
      } else {
        internalObserved = fixture.internalTransferTxHashes.every(hash => {
          const record = transactions.get(hash);
          return record ? hasInternalTransfer(record.transaction) : false;
        });
        internalCode = fixture.internalTransferTxHashes.some(hash => !transactions.has(hash))
          ? 'INTERNAL_TRANSACTIONS_NOT_OBSERVED' : 'INTERNAL_TRANSFERS_UNPROVEN';
      }
    }

    const reorgPassed = Boolean(terminalPage
      && validRecheckRange(terminalPage, history, fixture.maxRecheckBlocks));
    const capabilities = Object.freeze({
      pagination:capability(paginationPassed, paginationCode),
      completeness:capability(completenessPassed, completenessCode),
      finality:capability(finalizedObserved, finalityCode),
      internalTransfer:capability(internalObserved, internalCode),
      reorg:capability(reorgPassed, terminalPage ? 'REORG_RANGE_UNPROVEN' : 'BOUNDED_SCAN_NOT_COMPLETE'),
    });
    const ready = CAPABILITY_NAMES.every(name => capabilities[name].passed);
    return Object.freeze({
      chain,
      ready,
      pagesFetched,
      requestCount,
      uniqueTransactions:transactions.size,
      duplicateTransactions,
      capabilities,
    });
  } catch {
    return failedChainResult(chain, 'PROVIDER_REQUEST_FAILED', {
      pagesFetched, requestCount:requestCount + 1,
      uniqueTransactions:transactions.size, duplicateTransactions,
    });
  }
}

async function runGoldRushCanary({ apiKey, manifest, adapterFactory,
  internalTransferChains = REQUIRED_CHAINS, maxPages = 8,
  pageLimit = GOLDRUSH_PAGE_LIMIT } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    validationError('CANARY_KEY_REQUIRED', 'apiKey is required');
  }
  if (typeof adapterFactory !== 'function') {
    validationError('CANARY_ADAPTER_REQUIRED', 'adapterFactory must be a function');
  }
  if (!Number.isInteger(maxPages) || maxPages < 2 || maxPages > MAX_PAGES_PER_CHAIN) {
    validationError('CANARY_LIMIT_INVALID', `maxPages must be between 2 and ${MAX_PAGES_PER_CHAIN}`);
  }
  if (pageLimit !== GOLDRUSH_PAGE_LIMIT) {
    validationError('CANARY_LIMIT_INVALID',
      `pageLimit must equal GoldRush's fixed page size of ${GOLDRUSH_PAGE_LIMIT}`);
  }
  if (!(internalTransferChains instanceof Set) && !Array.isArray(internalTransferChains)) {
    validationError('CANARY_LIMIT_INVALID', 'internalTransferChains must be a set or array');
  }
  const internalChains = new Set(internalTransferChains);
  if ([...internalChains].some(chain => !REQUIRED_CHAINS.includes(chain))) {
    validationError('CANARY_LIMIT_INVALID', 'internalTransferChains contains an unsupported chain');
  }
  const fixtures = validateManifest(manifest, { maxPages });

  let adapter;
  try {
    adapter = await adapterFactory({ apiKey:apiKey.trim(), chains:Object.freeze([...REQUIRED_CHAINS]) });
  } catch {
    const chains = REQUIRED_CHAINS.map(chain => failedChainResult(chain, 'ADAPTER_INITIALIZATION_FAILED'));
    return Object.freeze({
      ready:false,
      expectedChains:Object.freeze([...REQUIRED_CHAINS]),
      limits:Object.freeze({ maxPages, pageLimit }),
      chains:Object.freeze(chains),
    });
  }
  if (!adapter || typeof adapter.fetchPage !== 'function') {
    validationError('CANARY_ADAPTER_INVALID', 'adapterFactory must return a fetchPage adapter');
  }

  const chains = [];
  for (const chain of REQUIRED_CHAINS) {
    chains.push(await inspectChain(adapter, chain, fixtures[chain], {
      maxPages,
      pageLimit,
      internalTransferSupported:internalChains.has(chain),
    }));
  }
  return Object.freeze({
    ready:chains.every(result => result.ready),
    expectedChains:Object.freeze([...REQUIRED_CHAINS]),
    limits:Object.freeze({ maxPages, pageLimit }),
    chains:Object.freeze(chains),
  });
}

module.exports = {
  CAPABILITY_NAMES,
  GOLDRUSH_PAGE_LIMIT,
  GoldRushCanaryValidationError,
  MAX_PAGES_PER_CHAIN,
  REQUIRED_CHAINS,
  runGoldRushCanary,
  validateManifest,
};

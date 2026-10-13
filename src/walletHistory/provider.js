'use strict';

// Provider-independent wallet-history adapter contract. Network-specific adapters belong in
// separate modules; this registry only selects them and validates their normalized output.

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-f]{2})*$/i;
const SELECTOR_PATTERN = /^0x[0-9a-f]{8}$/i;
const UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const PG_INTEGER_MAX = 2_147_483_647n;
const MAX_PAGE_TRANSACTIONS = 500;
const MAX_TRANSACTION_MOVEMENTS = 2_000;

const EXECUTION_STATUSES = new Set(['success', 'reverted', 'unknown']);
const FINALITY_STATUSES = new Set(['unfinalized', 'finalized']);
const MOVEMENT_TYPES = new Set([
  'native_transfer', 'erc20_transfer', 'erc721_transfer', 'erc1155_transfer',
  'mint', 'burn', 'fee', 'approval', 'other',
]);
const MOVEMENT_DIRECTIONS = new Set(['in', 'out', 'self', 'unknown']);
const ASSET_STANDARDS = new Set(['native', 'erc20', 'erc721', 'erc1155', 'unknown']);

class WalletHistoryProviderContractError extends TypeError {
  constructor(path, message) {
    super(`${path} ${message}`);
    this.name = 'WalletHistoryProviderContractError';
    this.code = 'WALLET_HISTORY_PROVIDER_CONTRACT';
    this.path = path;
  }
}

function contractError(path, message) {
  throw new WalletHistoryProviderContractError(path, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, path) {
  if (!isPlainObject(value)) contractError(path, 'must be a plain object');
  return value;
}

function assertOnlyFields(value, allowed, path) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) contractError(`${path}.${field}`, 'is not part of the provider contract');
  }
}

function normalizeIdentifier(value, path) {
  if (typeof value !== 'string') contractError(path, 'must be a string');
  const normalized = value.trim().toLowerCase();
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    contractError(path, 'must contain only lowercase letters, numbers, underscores, or hyphens');
  }
  return normalized;
}

function normalizeChain(value) {
  return normalizeIdentifier(value, 'chain');
}

function normalizeProviderKey(value) {
  return normalizeIdentifier(value, 'providerKey');
}

function normalizeAddress(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    contractError(path, 'must be a valid EVM address');
  }
  return value.toLowerCase();
}

function normalizeHash(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    contractError(path, 'must be a 32-byte hexadecimal hash');
  }
  return value.toLowerCase();
}

function normalizeUint(value, path, { nullable = false, maximum = UINT256_MAX } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UINT_PATTERN.test(value)) {
    contractError(path, 'must be a canonical unsigned decimal string');
  }
  if (BigInt(value) > maximum) contractError(path, `must not exceed ${maximum}`);
  return value;
}

function normalizeBoolean(value, path) {
  if (typeof value !== 'boolean') contractError(path, 'must be a boolean');
  return value;
}

function normalizeEnum(value, allowed, path) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    contractError(path, `must be one of: ${[...allowed].join(', ')}`);
  }
  return value;
}

function normalizeIsoTimestamp(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    contractError(path, 'must be an ISO-8601 timestamp string');
  }
  return new Date(value).toISOString();
}

function normalizeJsonValue(value, path, depth = 0) {
  if (depth > 12) contractError(path, 'exceeds the maximum JSON nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) contractError(path, 'must contain only finite JSON numbers');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) contractError(path, 'contains too many items');
    return value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`, depth + 1));
  }
  if (!isPlainObject(value)) contractError(path, 'must contain only JSON-compatible values');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || typeof item === 'bigint' || typeof item === 'function') {
      contractError(`${path}.${key}`, 'must contain only JSON-compatible values');
    }
    result[key] = normalizeJsonValue(item, `${path}.${key}`, depth + 1);
  }
  return result;
}

function normalizeMovement(value, path = 'movement') {
  requireObject(value, path);
  assertOnlyFields(value, new Set([
    'eventLocator', 'eventType', 'direction', 'assetStandard', 'assetAddress',
    'fromAddress', 'toAddress', 'tokenId', 'amountRaw', 'details',
  ]), path);
  if (typeof value.eventLocator !== 'string' || !value.eventLocator.trim()
    || value.eventLocator.length > 200) {
    contractError(`${path}.eventLocator`, 'must be a non-empty string with at most 200 characters');
  }
  const movement = {
    eventLocator:value.eventLocator.trim(),
    eventType:normalizeEnum(value.eventType, MOVEMENT_TYPES, `${path}.eventType`),
    direction:normalizeEnum(value.direction, MOVEMENT_DIRECTIONS, `${path}.direction`),
    assetStandard:normalizeEnum(value.assetStandard, ASSET_STANDARDS, `${path}.assetStandard`),
    assetAddress:normalizeAddress(value.assetAddress, `${path}.assetAddress`, { nullable:true }),
    fromAddress:normalizeAddress(value.fromAddress, `${path}.fromAddress`, { nullable:true }),
    toAddress:normalizeAddress(value.toAddress, `${path}.toAddress`, { nullable:true }),
    tokenId:normalizeUint(value.tokenId, `${path}.tokenId`, { nullable:true }),
    amountRaw:normalizeUint(value.amountRaw, `${path}.amountRaw`, { nullable:true }),
    details:normalizeJsonValue(value.details, `${path}.details`),
  };
  if (movement.assetStandard === 'native') {
    if (movement.assetAddress !== null) {
      contractError(`${path}.assetAddress`, 'must be null for a native-token movement');
    }
  }
  if (['erc20', 'erc721', 'erc1155'].includes(movement.assetStandard)
    && movement.assetAddress === null) {
    contractError(`${path}.assetAddress`, `is required for ${movement.assetStandard}`);
  }
  if (movement.assetStandard === 'erc721' && movement.tokenId === null) {
    contractError(`${path}.tokenId`, 'is required for erc721');
  }
  return movement;
}

function normalizeTransaction(value, path = 'transaction') {
  requireObject(value, path);
  assertOnlyFields(value, new Set([
    'txHash', 'blockNumber', 'blockHash', 'transactionIndex', 'occurredAt',
    'fromAddress', 'toAddress', 'nonce', 'input', 'methodSelector', 'valueWei',
    'gasLimit', 'gasUsed', 'effectiveGasPriceWei', 'networkFeeWei', 'executionStatus',
    'finalityStatus', 'canonical', 'rawSummary', 'movements',
  ]), path);
  if (value.input !== null
    && (typeof value.input !== 'string' || !HEX_BYTES_PATTERN.test(value.input))) {
    contractError(`${path}.input`, 'must be null or an even-length hexadecimal byte string');
  }
  if (value.methodSelector !== null
    && (typeof value.methodSelector !== 'string' || !SELECTOR_PATTERN.test(value.methodSelector))) {
    contractError(`${path}.methodSelector`, 'must be null or a 4-byte hexadecimal selector');
  }
  if (!Array.isArray(value.movements) || value.movements.length > MAX_TRANSACTION_MOVEMENTS) {
    contractError(`${path}.movements`, `must be an array with at most ${MAX_TRANSACTION_MOVEMENTS} items`);
  }
  const transaction = {
    txHash:normalizeHash(value.txHash, `${path}.txHash`),
    blockNumber:normalizeUint(value.blockNumber, `${path}.blockNumber`, { maximum:PG_BIGINT_MAX }),
    blockHash:normalizeHash(value.blockHash, `${path}.blockHash`, { nullable:true }),
    transactionIndex:normalizeUint(value.transactionIndex, `${path}.transactionIndex`, {
      nullable:true, maximum:PG_INTEGER_MAX,
    }),
    occurredAt:normalizeIsoTimestamp(value.occurredAt, `${path}.occurredAt`),
    fromAddress:normalizeAddress(value.fromAddress, `${path}.fromAddress`),
    toAddress:normalizeAddress(value.toAddress, `${path}.toAddress`, { nullable:true }),
    nonce:normalizeUint(value.nonce, `${path}.nonce`, { nullable:true }),
    input:value.input === null ? null : value.input.toLowerCase(),
    methodSelector:value.methodSelector === null ? null : value.methodSelector.toLowerCase(),
    valueWei:normalizeUint(value.valueWei, `${path}.valueWei`),
    gasLimit:normalizeUint(value.gasLimit, `${path}.gasLimit`, { nullable:true }),
    gasUsed:normalizeUint(value.gasUsed, `${path}.gasUsed`, { nullable:true }),
    effectiveGasPriceWei:normalizeUint(value.effectiveGasPriceWei,
      `${path}.effectiveGasPriceWei`, { nullable:true }),
    networkFeeWei:normalizeUint(value.networkFeeWei, `${path}.networkFeeWei`, { nullable:true }),
    executionStatus:normalizeEnum(value.executionStatus, EXECUTION_STATUSES, `${path}.executionStatus`),
    finalityStatus:normalizeEnum(value.finalityStatus, FINALITY_STATUSES, `${path}.finalityStatus`),
    canonical:normalizeBoolean(value.canonical, `${path}.canonical`),
    rawSummary:normalizeJsonValue(value.rawSummary, `${path}.rawSummary`),
    movements:value.movements.map((movement, index) => normalizeMovement(movement,
      `${path}.movements[${index}]`)),
  };
  const locators = transaction.movements.map(item => item.eventLocator);
  if (new Set(locators).size !== locators.length) {
    contractError(`${path}.movements`, 'must not contain duplicate eventLocator values');
  }
  return transaction;
}

function normalizeCoverageRange(value, path) {
  if (value === null) return null;
  requireObject(value, path);
  assertOnlyFields(value, new Set(['fromBlock', 'throughBlock', 'complete']), path);
  const result = {
    fromBlock:normalizeUint(value.fromBlock, `${path}.fromBlock`, { maximum:PG_BIGINT_MAX }),
    throughBlock:normalizeUint(value.throughBlock, `${path}.throughBlock`, { maximum:PG_BIGINT_MAX }),
    complete:normalizeBoolean(value.complete, `${path}.complete`),
  };
  if (BigInt(result.fromBlock) > BigInt(result.throughBlock)) {
    contractError(path, 'must not end before it starts');
  }
  return result;
}

function normalizeRecheckRange(value, path) {
  if (value === null) return null;
  requireObject(value, path);
  assertOnlyFields(value, new Set(['fromBlock', 'throughBlock']), path);
  const result = {
    fromBlock:normalizeUint(value.fromBlock, `${path}.fromBlock`, { maximum:PG_BIGINT_MAX }),
    throughBlock:normalizeUint(value.throughBlock, `${path}.throughBlock`, { maximum:PG_BIGINT_MAX }),
  };
  if (BigInt(result.fromBlock) > BigInt(result.throughBlock)) {
    contractError(path, 'must not end before it starts');
  }
  return result;
}

function validateProviderPage(value, expected = {}) {
  const path = 'page';
  requireObject(value, path);
  assertOnlyFields(value, new Set([
    'chain', 'providerKey', 'transactions', 'nextCursor', 'hasMore', 'observedHeadBlock',
    'coverage', 'recheckRange',
  ]), path);
  const chain = normalizeChain(value.chain);
  const providerKey = normalizeProviderKey(value.providerKey);
  if (expected.chain !== undefined && chain !== normalizeChain(expected.chain)) {
    contractError('page.chain', 'does not match the requested chain');
  }
  if (expected.providerKey !== undefined && providerKey !== normalizeProviderKey(expected.providerKey)) {
    contractError('page.providerKey', 'does not match the selected provider');
  }
  if (!Array.isArray(value.transactions) || value.transactions.length > MAX_PAGE_TRANSACTIONS) {
    contractError('page.transactions', `must be an array with at most ${MAX_PAGE_TRANSACTIONS} items`);
  }
  if (typeof value.hasMore !== 'boolean') contractError('page.hasMore', 'must be a boolean');
  const nextCursor = value.nextCursor === null
    ? null : normalizeJsonValue(value.nextCursor, 'page.nextCursor');
  if (value.hasMore && nextCursor === null) {
    contractError('page.nextCursor', 'is required when hasMore is true');
  }
  if (!value.hasMore && nextCursor !== null) {
    contractError('page.nextCursor', 'must be null when hasMore is false');
  }
  requireObject(value.coverage, 'page.coverage');
  assertOnlyFields(value.coverage, new Set(['history', 'provenance']), 'page.coverage');
  const transactions = value.transactions.map((transaction, index) => normalizeTransaction(transaction,
    `page.transactions[${index}]`));
  const hashes = transactions.map(transaction => transaction.txHash);
  if (new Set(hashes).size !== hashes.length) {
    contractError('page.transactions', 'must not contain duplicate txHash values');
  }
  const observedHeadBlock = normalizeUint(value.observedHeadBlock, 'page.observedHeadBlock', {
    nullable:true, maximum:PG_BIGINT_MAX,
  });
  const historyCoverage = normalizeCoverageRange(value.coverage.history, 'page.coverage.history');
  const provenanceCoverage = normalizeCoverageRange(value.coverage.provenance, 'page.coverage.provenance');
  const recheckRange = normalizeRecheckRange(value.recheckRange, 'page.recheckRange');
  if (observedHeadBlock !== null) {
    const head = BigInt(observedHeadBlock);
    for (let index = 0; index < transactions.length; index += 1) {
      if (BigInt(transactions[index].blockNumber) > head) {
        contractError(`page.transactions[${index}].blockNumber`, 'must not exceed page.observedHeadBlock');
      }
    }
    for (const [name, range] of [['history', historyCoverage], ['provenance', provenanceCoverage]]) {
      if (range && BigInt(range.throughBlock) > head) {
        contractError(`page.coverage.${name}.throughBlock`, 'must not exceed page.observedHeadBlock');
      }
    }
  }
  if (historyCoverage && provenanceCoverage
    && (BigInt(provenanceCoverage.fromBlock) < BigInt(historyCoverage.fromBlock)
      || BigInt(provenanceCoverage.throughBlock) > BigInt(historyCoverage.throughBlock))) {
    contractError('page.coverage.provenance', 'must be contained within page.coverage.history');
  }
  if (recheckRange) {
    if (value.hasMore) contractError('page.recheckRange', 'is only allowed on the final page');
    if (!historyCoverage?.complete) {
      contractError('page.recheckRange', 'requires an explicit complete history coverage range');
    }
    if (BigInt(recheckRange.fromBlock) < BigInt(historyCoverage.fromBlock)
      || BigInt(recheckRange.throughBlock) > BigInt(historyCoverage.throughBlock)) {
      contractError('page.recheckRange', 'must be contained within complete history coverage');
    }
  }
  return {
    supported:true,
    state:'ready',
    chain,
    providerKey,
    transactions,
    nextCursor,
    hasMore:value.hasMore,
    observedHeadBlock,
    // Null means the provider made no completeness claim. A non-null claim must always carry an
    // explicit boolean; ending a page never silently upgrades either coverage dimension.
    coverage:{
      history:historyCoverage,
      provenance:provenanceCoverage,
    },
    recheckRange,
  };
}

function validateFetchRequest(value) {
  requireObject(value, 'request');
  assertOnlyFields(value, new Set([
    'chain', 'providerKey', 'walletAddress', 'cursor', 'limit', 'fromBlock', 'throughBlock',
  ]), 'request');
  const limit = value.limit === undefined ? 100 : value.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_TRANSACTIONS) {
    contractError('request.limit', `must be an integer between 1 and ${MAX_PAGE_TRANSACTIONS}`);
  }
  const fromBlock = value.fromBlock === undefined || value.fromBlock === null
    ? null : normalizeUint(value.fromBlock, 'request.fromBlock', { maximum:PG_BIGINT_MAX });
  const throughBlock = value.throughBlock === undefined || value.throughBlock === null
    ? null : normalizeUint(value.throughBlock, 'request.throughBlock', { maximum:PG_BIGINT_MAX });
  if (fromBlock !== null && throughBlock !== null && BigInt(fromBlock) > BigInt(throughBlock)) {
    contractError('request', 'must not end before it starts');
  }
  return {
    chain:normalizeChain(value.chain),
    providerKey:value.providerKey === undefined || value.providerKey === null
      ? null : normalizeProviderKey(value.providerKey),
    walletAddress:normalizeAddress(value.walletAddress, 'request.walletAddress'),
    cursor:value.cursor === undefined || value.cursor === null
      ? null : normalizeJsonValue(value.cursor, 'request.cursor'),
    limit,
    fromBlock,
    throughBlock,
  };
}

function normalizeCapabilities(value = {}) {
  requireObject(value, 'adapter.capabilities');
  assertOnlyFields(value, new Set(['transactions', 'movements', 'receipts']), 'adapter.capabilities');
  return Object.freeze({
    transactions:value.transactions === true,
    movements:value.movements === true,
    receipts:value.receipts === true,
  });
}

function unsupportedDescriptor(chain, providerKey, reasonCode, reason) {
  return Object.freeze({
    supported:false,
    state:'unsupported',
    chain,
    providerKey:providerKey || null,
    reasonCode,
    reason,
    // An unsupported adapter has not scanned anything and makes no coverage claim.
    coverage:Object.freeze({ history:null, provenance:null }),
  });
}

function createWalletHistoryProviderRegistry({ adapters = [], defaults = {} } = {}) {
  if (!Array.isArray(adapters)) contractError('adapters', 'must be an array');
  requireObject(defaults, 'defaults');
  const byChain = new Map();
  const defaultProviders = new Map(Object.entries(defaults).map(([chain, providerKey]) => [
    normalizeChain(chain), normalizeProviderKey(providerKey),
  ]));

  function register(adapter) {
    requireObject(adapter, 'adapter');
    assertOnlyFields(adapter, new Set([
      'providerKey', 'label', 'chains', 'capabilities', 'fetchPage',
    ]), 'adapter');
    const providerKey = normalizeProviderKey(adapter.providerKey);
    if (typeof adapter.label !== 'string' || !adapter.label.trim() || adapter.label.length > 100) {
      contractError('adapter.label', 'must be a non-empty string with at most 100 characters');
    }
    if (!Array.isArray(adapter.chains) || adapter.chains.length === 0) {
      contractError('adapter.chains', 'must be a non-empty array');
    }
    if (typeof adapter.fetchPage !== 'function') contractError('adapter.fetchPage', 'must be a function');
    const chains = [...new Set(adapter.chains.map(normalizeChain))];
    if (chains.length !== adapter.chains.length) contractError('adapter.chains', 'must not contain duplicates');
    const capabilities = normalizeCapabilities(adapter.capabilities || {});
    if (!capabilities.transactions) {
      contractError('adapter.capabilities.transactions', 'must be explicitly true');
    }
    const record = Object.freeze({
      providerKey,
      label:adapter.label.trim(),
      chains:Object.freeze(chains),
      capabilities,
      fetchPage:adapter.fetchPage,
    });
    for (const chain of chains) {
      let providers = byChain.get(chain);
      if (!providers) { providers = new Map(); byChain.set(chain, providers); }
      if (providers.has(providerKey)) {
        contractError('adapter.providerKey', `duplicates ${providerKey} for ${chain}`);
      }
      providers.set(providerKey, record);
    }
    return Object.freeze({ providerKey, chains:Object.freeze([...chains]) });
  }

  for (const adapter of adapters) register(adapter);

  function select(chainInput, providerInput) {
    const chain = normalizeChain(chainInput);
    const providers = byChain.get(chain);
    let providerKey = providerInput === undefined || providerInput === null
      ? null : normalizeProviderKey(providerInput);
    if (!providers || providers.size === 0) {
      return { descriptor:unsupportedDescriptor(chain, providerKey, 'provider_not_configured',
        `Wallet history is not configured for ${chain}.`) };
    }
    if (!providerKey) {
      providerKey = defaultProviders.get(chain) || (providers.size === 1 ? providers.keys().next().value : null);
    }
    if (!providerKey) {
      return { descriptor:unsupportedDescriptor(chain, null, 'provider_not_selected',
        `More than one wallet-history provider is configured for ${chain}; select one explicitly.`) };
    }
    const adapter = providers.get(providerKey);
    if (!adapter) {
      return { descriptor:unsupportedDescriptor(chain, providerKey, 'provider_not_configured',
        `${providerKey} is not configured for ${chain}.`) };
    }
    return { adapter, descriptor:Object.freeze({
      supported:true,
      state:'ready',
      chain,
      providerKey,
      label:adapter.label,
      capabilities:adapter.capabilities,
      // Selection alone proves no historical or provenance coverage.
      coverage:Object.freeze({ history:null, provenance:null }),
    }) };
  }

  function describe({ chain, providerKey } = {}) {
    return select(chain, providerKey).descriptor;
  }

  async function fetchPage(input) {
    const request = validateFetchRequest(input);
    const selected = select(request.chain, request.providerKey);
    if (!selected.adapter) return selected.descriptor;
    const page = await selected.adapter.fetchPage(Object.freeze({ ...request,
      providerKey:selected.descriptor.providerKey }));
    return validateProviderPage(page, {
      chain:selected.descriptor.chain,
      providerKey:selected.descriptor.providerKey,
    });
  }

  function list() {
    const result = [];
    for (const [chain, providers] of byChain) {
      for (const providerKey of providers.keys()) result.push(describe({ chain, providerKey }));
    }
    return result.sort((left, right) => `${left.chain}:${left.providerKey}`
      .localeCompare(`${right.chain}:${right.providerKey}`));
  }

  return Object.freeze({ register, describe, fetchPage, list });
}

module.exports = {
  ASSET_STANDARDS,
  EXECUTION_STATUSES,
  FINALITY_STATUSES,
  MAX_PAGE_TRANSACTIONS,
  MAX_TRANSACTION_MOVEMENTS,
  MOVEMENT_DIRECTIONS,
  MOVEMENT_TYPES,
  WalletHistoryProviderContractError,
  createWalletHistoryProviderRegistry,
  normalizeChain,
  normalizeMovement,
  normalizeProviderKey,
  normalizeTransaction,
  normalizeUint,
  validateFetchRequest,
  validateProviderPage,
};

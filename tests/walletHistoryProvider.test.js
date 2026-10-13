const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WalletHistoryProviderContractError,
  createWalletHistoryProviderRegistry,
  normalizeChain,
  normalizeMovement,
  normalizeProviderKey,
  normalizeTransaction,
  validateProviderPage,
} = require('../src/walletHistory/provider');

const WALLET = '0x00000000000000000000000000000000000000AA';
const OTHER = '0x00000000000000000000000000000000000000BB';
const CONTRACT = '0x00000000000000000000000000000000000000CC';
const TX_HASH = `0x${'AB'.repeat(32)}`;
const BLOCK_HASH = `0x${'CD'.repeat(32)}`;

function nativeMovement(overrides = {}) {
  return {
    eventLocator:'native:transaction-value',
    eventType:'native_transfer',
    direction:'out',
    assetStandard:'native',
    assetAddress:null,
    fromAddress:WALLET,
    toAddress:OTHER,
    tokenId:null,
    amountRaw:null,
    details:{ note:'canonical transaction value' },
    ...overrides,
  };
}

function transaction(overrides = {}) {
  return {
    txHash:TX_HASH,
    blockNumber:'9007199254740993',
    blockHash:BLOCK_HASH,
    transactionIndex:'4',
    occurredAt:'2026-10-13T12:00:00+00:00',
    fromAddress:WALLET,
    toAddress:CONTRACT,
    nonce:'999999999999999999',
    input:'0x1234',
    methodSelector:null,
    valueWei:'900719925474099300000000',
    gasLimit:'21000',
    gasUsed:'21000',
    effectiveGasPriceWei:'1234567890',
    networkFeeWei:'25925925690000',
    executionStatus:'success',
    finalityStatus:'finalized',
    canonical:true,
    rawSummary:{ providerReceipt:'normalized' },
    movements:[nativeMovement()],
    ...overrides,
  };
}

function page(overrides = {}) {
  return {
    chain:'Ethereum',
    providerKey:'Alchemy',
    transactions:[transaction()],
    nextCursor:{ page:'opaque-2' },
    hasMore:true,
    observedHeadBlock:'9007199254741000',
    coverage:{
      history:{ fromBlock:'9007199254740000', throughBlock:'9007199254740993', complete:false },
      provenance:null,
    },
    recheckRange:null,
    ...overrides,
  };
}

test('normalizes registry identifiers while refusing ambiguous or malformed keys', () => {
  assert.equal(normalizeChain('  Ethereum  '), 'ethereum');
  assert.equal(normalizeProviderKey('Covalent_V2'), 'covalent_v2');
  assert.throws(() => normalizeChain('Robinhood Chain'), error =>
    error instanceof WalletHistoryProviderContractError && error.path === 'chain');
  assert.throws(() => normalizeProviderKey(''), /providerKey/);
});

test('returns a truthful unsupported state when no provider or requested provider is configured', async () => {
  const registry = createWalletHistoryProviderRegistry();
  assert.deepEqual(registry.describe({ chain:'ethereum' }), {
    supported:false,
    state:'unsupported',
    chain:'ethereum',
    providerKey:null,
    reasonCode:'provider_not_configured',
    reason:'Wallet history is not configured for ethereum.',
    coverage:{ history:null, provenance:null },
  });
  assert.deepEqual(await registry.fetchPage({
    chain:'ethereum', providerKey:'alchemy', walletAddress:WALLET, cursor:null, limit:25,
  }), {
    supported:false,
    state:'unsupported',
    chain:'ethereum',
    providerKey:'alchemy',
    reasonCode:'provider_not_configured',
    reason:'Wallet history is not configured for ethereum.',
    coverage:{ history:null, provenance:null },
  });
});

test('selects an adapter, normalizes its request, and validates its page without losing integer precision', async () => {
  let received;
  const registry = createWalletHistoryProviderRegistry({ adapters:[{
    providerKey:'Alchemy',
    label:'Alchemy history',
    chains:['Ethereum'],
    capabilities:{ transactions:true, movements:true, receipts:true },
    fetchPage:async request => { received=request; return page(); },
  }] });
  assert.deepEqual(registry.describe({ chain:'ETHEREUM' }), {
    supported:true,
    state:'ready',
    chain:'ethereum',
    providerKey:'alchemy',
    label:'Alchemy history',
    capabilities:{ transactions:true, movements:true, receipts:true },
    coverage:{ history:null, provenance:null },
  });
  const result = await registry.fetchPage({
    chain:' Ethereum ', walletAddress:WALLET, cursor:{ page:'opaque-1' }, limit:50,
    fromBlock:'9007199254740000', throughBlock:'9007199254741000',
  });
  assert.deepEqual(received, {
    chain:'ethereum',
    providerKey:'alchemy',
    walletAddress:WALLET.toLowerCase(),
    cursor:{ page:'opaque-1' },
    limit:50,
    fromBlock:'9007199254740000',
    throughBlock:'9007199254741000',
  });
  assert.equal(result.supported, true);
  assert.equal(result.state, 'ready');
  assert.equal(result.transactions[0].valueWei, '900719925474099300000000');
  assert.equal(result.transactions[0].nonce, '999999999999999999');
  assert.equal(result.transactions[0].fromAddress, WALLET.toLowerCase());
  assert.equal(result.transactions[0].txHash, TX_HASH.toLowerCase());
  assert.equal(result.transactions[0].occurredAt, '2026-10-13T12:00:00.000Z');
  assert.equal(result.coverage.history.complete, false);
  assert.equal(result.coverage.provenance, null);
});

test('requires explicit completeness fields and never infers coverage from the end of pagination', () => {
  assert.throws(() => validateProviderPage(page({
    nextCursor:null,
    hasMore:false,
    coverage:{ history:null },
  })), error => error instanceof WalletHistoryProviderContractError
    && error.path === 'page.coverage.provenance');
  const finished = validateProviderPage(page({
    nextCursor:null,
    hasMore:false,
    coverage:{ history:null, provenance:null },
  }));
  assert.equal(finished.hasMore, false);
  assert.deepEqual(finished.coverage, { history:null, provenance:null });
});

test('rejects numeric blockchain quantities rather than rounding them in JavaScript', () => {
  assert.throws(() => normalizeTransaction(transaction({ valueWei:9_007_199_254_740_993 })), error =>
    error instanceof WalletHistoryProviderContractError
    && error.path === 'transaction.valueWei'
    && /decimal string/.test(error.message));
  assert.throws(() => normalizeMovement(nativeMovement({ amountRaw:'0x2a' })), /decimal string/);
  assert.throws(() => validateProviderPage(page({ observedHeadBlock:123 })), /observedHeadBlock/);
  assert.throws(() => normalizeTransaction(transaction({ blockNumber:'9223372036854775808' })),
    /must not exceed/);
  assert.throws(() => normalizeTransaction(transaction({ valueWei:(1n << 256n).toString() })),
    /must not exceed/);
});

test('preserves unavailable calldata as null instead of inventing an empty transaction input', () => {
  const normalized = normalizeTransaction(transaction({ input:null }));
  assert.equal(normalized.input, null);
  assert.throws(() => normalizeTransaction(transaction({ input:'not-hex' })), /must be null or/);
});

test('rejects malformed, duplicate, and provider-mismatched pages', () => {
  assert.throws(() => normalizeTransaction(transaction({ blockNumber:null })), /decimal string/);
  assert.throws(() => normalizeTransaction(transaction({ movements:[
    nativeMovement(), nativeMovement({ amountRaw:'1' }),
  ] })), /duplicate eventLocator/);
  assert.throws(() => validateProviderPage(page({ transactions:[
    transaction(), transaction({ valueWei:'1' }),
  ] })), /duplicate txHash/);
  assert.throws(() => validateProviderPage(page(), { chain:'base' }), /does not match the requested chain/);
  assert.throws(() => validateProviderPage(page(), { providerKey:'covalent' }),
    /does not match the selected provider/);
  assert.throws(() => validateProviderPage(page({ extraClaim:'all history complete' })),
    /not part of the provider contract/);
});

test('rejects provider ranges that could orphan rows outside proven history', () => {
  assert.throws(() => validateProviderPage(page({
    nextCursor:null, hasMore:false,
    coverage:{ history:{ fromBlock:'10', throughBlock:'100', complete:true }, provenance:null },
    recheckRange:{ fromBlock:'0', throughBlock:'100' },
  })), error => error instanceof WalletHistoryProviderContractError
    && error.path === 'page.recheckRange');
  assert.throws(() => validateProviderPage(page({
    observedHeadBlock:'50',
    transactions:[transaction({ blockNumber:'51' })],
    coverage:{ history:{ fromBlock:'10', throughBlock:'50', complete:false }, provenance:null },
  })), error => error instanceof WalletHistoryProviderContractError
    && error.path === 'page.transactions[0].blockNumber');
  assert.throws(() => validateProviderPage(page({
    coverage:{ history:{ fromBlock:'10', throughBlock:'100', complete:false },
      provenance:{ fromBlock:'0', throughBlock:'100', complete:true } },
  })), error => error instanceof WalletHistoryProviderContractError
    && error.path === 'page.coverage.provenance');
});

test('requires explicit provider selection when a chain has multiple adapters and no default', async () => {
  let calls = 0;
  const adapter = providerKey => ({
    providerKey,
    label:providerKey,
    chains:['base'],
    capabilities:{ transactions:true },
    fetchPage:async () => { calls += 1; return page({ chain:'base', providerKey }); },
  });
  const registry = createWalletHistoryProviderRegistry({ adapters:[adapter('alchemy'), adapter('covalent')] });
  const result = await registry.fetchPage({ chain:'base', walletAddress:WALLET });
  assert.equal(result.supported, false);
  assert.equal(result.reasonCode, 'provider_not_selected');
  assert.equal(calls, 0);

  const selected = createWalletHistoryProviderRegistry({
    adapters:[adapter('alchemy'), adapter('covalent')],
    defaults:{ base:'covalent' },
  });
  assert.equal(selected.describe({ chain:'base' }).providerKey, 'covalent');
});

test('registration rejects implicit transaction capability and duplicate chain-provider pairs', () => {
  const base = {
    providerKey:'alchemy', label:'Alchemy', chains:['ethereum'], fetchPage:async () => page(),
  };
  assert.throws(() => createWalletHistoryProviderRegistry({ adapters:[base] }),
    /capabilities.transactions must be explicitly true/);
  assert.throws(() => createWalletHistoryProviderRegistry({ adapters:[
    { ...base, capabilities:{ transactions:true } },
    { ...base, capabilities:{ transactions:true } },
  ] }), /duplicates alchemy for ethereum/);
});

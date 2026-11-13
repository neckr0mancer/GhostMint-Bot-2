'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { URL } = require('node:url');
const {
  REQUIRED_CHAINS,
  runGoldRushCanary,
  validateManifest,
} = require('../src/walletHistory/goldRushCanary');
const {
  GOLDRUSH_CHAIN_SLUGS,
  GOLDRUSH_INTERNAL_TRANSFER_CHAINS,
  createGoldRushWalletHistoryAdapter,
} = require('../src/walletHistory/goldRushAdapter');

function address(index) {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

function hash(index) {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

function manifest() {
  return Object.fromEntries(REQUIRED_CHAINS.map((chain, index) => {
    const finalized = hash(index * 10 + 1);
    const internal = hash(index * 10 + 2);
    return [chain, {
      address:address(index + 1),
      minPages:2,
      maxRecheckBlocks:200,
      knownTxHashes:[finalized, internal],
      finalizedTxHashes:[finalized],
      internalTransferTxHashes:[internal],
    }];
  }));
}

function transaction(txHash, { finalized = true, internal = false, blockNumber = '100' } = {}) {
  return {
    txHash,
    blockNumber,
    blockHash:hash(Number(blockNumber) + 1_000),
    transactionIndex:'0',
    finalityStatus:finalized ? 'finalized' : 'unfinalized',
    canonical:true,
    movements:internal ? [{
      eventLocator:'internal:0',
      eventType:'native_transfer',
      direction:'in',
      assetStandard:'native',
      assetAddress:null,
      tokenId:null,
      amountRaw:'1',
      fromAddress:address(100),
      toAddress:address(101),
      details:{ kind:'internal_transfer' },
    }] : [],
  };
}

function passingPage(manifestEntry, cursor) {
  const first = transaction(manifestEntry.finalizedTxHashes[0], { blockNumber:'100' });
  const internalHash = manifestEntry.internalTransferTxHashes[0]
    || manifestEntry.knownTxHashes.at(-1);
  if (cursor === null) return {
    transactions:[first],
    nextCursor:{ page:1 },
    hasMore:true,
    observedHeadBlock:'200',
    coverage:{ history:null, provenance:null },
    recheckRange:null,
  };
  return {
    transactions:[first, transaction(internalHash, {
      internal:true, blockNumber:'101',
    })],
    nextCursor:null,
    hasMore:false,
    observedHeadBlock:'200',
    coverage:{
      history:{ fromBlock:'0', throughBlock:'200', complete:true },
      provenance:null,
    },
    recheckRange:{ fromBlock:'90', throughBlock:'200' },
  };
}

function goldRushTransaction(txHash, fixtureAddress, blockHeight, { internal = false } = {}) {
  return {
    block_signed_at:'2026-10-15T12:30:00Z',
    block_height:blockHeight,
    block_hash:hash(blockHeight + 2_000),
    tx_hash:txHash,
    tx_offset:0,
    successful:true,
    from_address:fixtureAddress,
    to_address:address(500),
    value:'0',
    gas_offered:21_000,
    gas_spent:21_000,
    gas_price:1,
    fees_paid:'21000',
    internal_transfers:internal ? [{
      from_address:address(500),
      to_address:fixtureAddress,
      value:'1',
    }] : [],
    log_events:[],
  };
}

test('manifest requires exactly seven chains and explicit public evidence fields', () => {
  const fixtures = manifest();
  const normalized = validateManifest(fixtures, { maxPages:4 });
  assert.deepEqual(Object.keys(normalized), REQUIRED_CHAINS);
  assert.equal(normalized.ethereum.address, fixtures.ethereum.address);

  const missing = manifest();
  delete missing.ink;
  assert.throws(() => validateManifest(missing), /exactly the seven required chains/);

  const extra = manifest();
  extra.sepolia = extra.ethereum;
  assert.throws(() => validateManifest(extra), /exactly the seven required chains/);

  const tooShallow = manifest();
  tooShallow.base = { ...tooShallow.base, minPages:1 };
  assert.throws(() => validateManifest(tooShallow), /minPages/);

  const unboundedRecheck = manifest();
  unboundedRecheck.base = { ...unboundedRecheck.base, maxRecheckBlocks:0 };
  assert.throws(() => validateManifest(unboundedRecheck), /maxRecheckBlocks/);

  const missingEvidence = manifest();
  missingEvidence.polygon = { ...missingEvidence.polygon, finalizedTxHashes:[] };
  assert.throws(() => validateManifest(missingEvidence), /non-empty array/);

  const unavailableTraceEvidence = manifest();
  unavailableTraceEvidence.ink = { ...unavailableTraceEvidence.ink,
    internalTransferTxHashes:[] };
  assert.deepEqual(validateManifest(unavailableTraceEvidence).ink.internalTransferTxHashes, []);

  const unknownEvidence = manifest();
  unknownEvidence.arbitrum = {
    ...unknownEvidence.arbitrum,
    finalizedTxHashes:[hash(9_999)],
  };
  assert.throws(() => validateManifest(unknownEvidence), /must also be known hashes/);
});

test('passes only after every chain proves all capabilities and deduplicates page overlap', async () => {
  const fixtures = manifest();
  const secret = 'canary-secret-must-not-appear';
  let factoryInput;
  const result = await runGoldRushCanary({
    apiKey:secret,
    manifest:fixtures,
    maxPages:4,
    adapterFactory:options => {
      factoryInput = options;
      return {
        fetchPage:async request => passingPage(fixtures[request.chain], request.cursor),
      };
    },
  });

  assert.equal(factoryInput.apiKey, secret);
  assert.deepEqual(factoryInput.chains, REQUIRED_CHAINS);
  assert.equal(result.ready, true);
  assert.equal(result.chains.length, 7);
  for (const chain of result.chains) {
    assert.equal(chain.ready, true);
    assert.equal(chain.pagesFetched, 2);
    assert.equal(chain.requestCount, 3);
    assert.equal(chain.uniqueTransactions, 2);
    assert.equal(chain.duplicateTransactions, 1);
    assert.equal(Object.values(chain.capabilities).every(item => item.passed), true);
  }

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(secret));
  for (const entry of Object.values(fixtures)) {
    assert.doesNotMatch(serialized, new RegExp(entry.address, 'i'));
    for (const txHash of entry.knownTxHashes) assert.doesNotMatch(serialized, new RegExp(txHash, 'i'));
  }
});

test('reports current-style incomplete pages truthfully without leaking fixture identifiers', async () => {
  const fixtures = manifest();
  const result = await runGoldRushCanary({
    apiKey:'private-key',
    manifest:fixtures,
    maxPages:3,
    adapterFactory:() => ({
      fetchPage:async request => {
        const entry = fixtures[request.chain];
        const page = passingPage(entry, request.cursor);
        return {
          ...page,
          transactions:page.transactions.map(item => ({
            ...item,
            finalityStatus:'unfinalized',
            movements:[],
          })),
          coverage:{ history:null, provenance:null },
          recheckRange:null,
        };
      },
    }),
  });

  assert.equal(result.ready, false);
  for (const chain of result.chains) {
    assert.equal(chain.capabilities.pagination.passed, true);
    assert.equal(chain.capabilities.completeness.code, 'HISTORY_COVERAGE_UNPROVEN');
    assert.equal(chain.capabilities.finality.code, 'FINALITY_UNPROVEN');
    assert.equal(chain.capabilities.internalTransfer.code, 'INTERNAL_TRANSFERS_UNPROVEN');
    assert.equal(chain.capabilities.reorg.code, 'REORG_RANGE_UNPROVEN');
  }
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private-key/);
});

test('the real GoldRush adapter remains blocked despite valid two-page responses', async () => {
  const fixtures = manifest();
  const chainBySlug = Object.fromEntries(Object.entries(GOLDRUSH_CHAIN_SLUGS)
    .map(([chain, slug]) => [slug, chain]));
  const result = await runGoldRushCanary({
    apiKey:'private-key',
    manifest:fixtures,
    maxPages:3,
    internalTransferChains:GOLDRUSH_INTERNAL_TRANSFER_CHAINS,
    adapterFactory:options => createGoldRushWalletHistoryAdapter({
      ...options,
      fetchImpl:async url => {
        const requestUrl = new URL(String(url));
        const parts = requestUrl.pathname.split('/').filter(Boolean);
        const chain = chainBySlug[parts[1]];
        const page = Number(parts.at(-1));
        const fixture = fixtures[chain];
        const txHash = page === 0
          ? fixture.finalizedTxHashes[0] : fixture.internalTransferTxHashes[0];
        return {
          ok:true,
          status:200,
          headers:{ get:() => null },
          json:async () => ({
            error:false,
            data:{
              current_page:page,
              chain_tip_height:200,
              links:{ next:page === 0 ? 'next' : null },
              items:[goldRushTransaction(txHash, fixture.address, 100 + page, {
                internal:page === 1,
              })],
            },
          }),
        };
      },
    }),
  });

  assert.equal(result.ready, false);
  for (const chain of result.chains) {
    assert.equal(chain.capabilities.pagination.passed, true);
    assert.equal(chain.capabilities.completeness.code, 'HISTORY_COVERAGE_UNPROVEN');
    assert.equal(chain.capabilities.finality.code, 'FINALITY_UNPROVEN');
    assert.equal(chain.capabilities.internalTransfer.code,
      GOLDRUSH_INTERNAL_TRANSFER_CHAINS.has(chain.chain)
        ? 'PASS' : 'INTERNAL_TRANSFERS_UNSUPPORTED_BY_PROVIDER');
    assert.equal(chain.capabilities.reorg.code, 'REORG_RANGE_UNPROVEN');
  }
});

test('keeps the all-chain gate blocked when the provider does not support traces on a chain', async () => {
  const fixtures = manifest();
  fixtures.ink = { ...fixtures.ink, internalTransferTxHashes:[] };
  const result = await runGoldRushCanary({
    apiKey:'private-key',
    manifest:fixtures,
    maxPages:3,
    internalTransferChains:new Set(REQUIRED_CHAINS.filter(chain => chain !== 'ink')),
    adapterFactory:() => ({
      fetchPage:async request => passingPage(fixtures[request.chain], request.cursor),
    }),
  });

  const ink = result.chains.find(chain => chain.chain === 'ink');
  assert.equal(result.ready, false);
  assert.equal(ink.ready, false);
  assert.equal(ink.capabilities.internalTransfer.passed, false);
  assert.equal(ink.capabilities.internalTransfer.code,
    'INTERNAL_TRANSFERS_UNSUPPORTED_BY_PROVIDER');
});

test('rejects a recheck range wider than the reviewed per-chain maximum', async () => {
  const fixtures = manifest();
  const result = await runGoldRushCanary({
    apiKey:'private-key',
    manifest:fixtures,
    maxPages:3,
    adapterFactory:() => ({
      fetchPage:async request => {
        const page = passingPage(fixtures[request.chain], request.cursor);
        if (request.cursor !== null) page.recheckRange = {
          fromBlock:'0', throughBlock:'200',
        };
        return page;
      },
    }),
  });

  assert.equal(result.ready, false);
  for (const chain of result.chains) {
    assert.equal(chain.capabilities.reorg.passed, false);
    assert.equal(chain.capabilities.reorg.code, 'REORG_RANGE_UNPROVEN');
  }
});

test('rejects a narrow recheck range that does not reach the covered head', async () => {
  const fixtures = manifest();
  const result = await runGoldRushCanary({
    apiKey:'private-key',
    manifest:fixtures,
    maxPages:3,
    adapterFactory:() => ({
      fetchPage:async request => {
        const page = passingPage(fixtures[request.chain], request.cursor);
        if (request.cursor !== null) page.recheckRange = {
          fromBlock:'90', throughBlock:'150',
        };
        return page;
      },
    }),
  });

  for (const chain of result.chains) {
    assert.equal(chain.capabilities.reorg.passed, false);
    assert.equal(chain.capabilities.reorg.code, 'REORG_RANGE_UNPROVEN');
  }
});

test('requires the fixed GoldRush page size instead of reporting an ignored limit', async () => {
  await assert.rejects(runGoldRushCanary({
    apiKey:'private-key',
    manifest:manifest(),
    pageLimit:50,
    adapterFactory:() => ({ fetchPage:async () => { throw new Error('unreachable'); } }),
  }), /fixed page size of 100/);
});

test('rejects a provider page that exceeds the fixed GoldRush page size', async () => {
  const fixtures = manifest();
  const repeated = transaction(fixtures.ethereum.knownTxHashes[0]);
  const result = await runGoldRushCanary({
    apiKey:'private-key',
    manifest:fixtures,
    maxPages:3,
    adapterFactory:() => ({
      fetchPage:async request => request.chain === 'ethereum' && request.cursor === null
        ? {
          transactions:Array.from({ length:101 }, (_, index) => ({
            ...repeated, txHash:hash(20_000 + index),
          })),
          nextCursor:{ page:1 },
          hasMore:true,
          coverage:{ history:null, provenance:null },
        }
        : passingPage(fixtures[request.chain], request.cursor),
    }),
  });

  const ethereum = result.chains.find(chain => chain.chain === 'ethereum');
  assert.equal(ethereum.ready, false);
  assert.equal(ethereum.capabilities.pagination.code, 'PROVIDER_RESPONSE_INVALID');
});

test('caps traversal, performs one page-zero restart, and refuses incomplete scans', async () => {
  const fixtures = manifest();
  const calls = new Map();
  const result = await runGoldRushCanary({
    apiKey:'private-key',
    manifest:fixtures,
    maxPages:2,
    adapterFactory:() => ({
      fetchPage:async request => {
        calls.set(request.chain, (calls.get(request.chain) || 0) + 1);
        const entry = fixtures[request.chain];
        return {
          transactions:[transaction(entry.finalizedTxHashes[0])],
          nextCursor:{ page:(request.cursor?.page ?? -1) + 1 },
          hasMore:true,
          observedHeadBlock:'200',
          coverage:{ history:null, provenance:null },
          recheckRange:null,
        };
      },
    }),
  });

  assert.equal(result.ready, false);
  for (const chain of result.chains) {
    assert.equal(calls.get(chain.chain), 3);
    assert.equal(chain.pagesFetched, 2);
    assert.equal(chain.requestCount, 3);
    assert.equal(chain.capabilities.completeness.code, 'BOUNDED_SCAN_NOT_COMPLETE');
  }
});

test('detects a changed page-zero restart fingerprint', async () => {
  const fixtures = manifest();
  const pageZeroReads = new Map();
  const result = await runGoldRushCanary({
    apiKey:'private-key',
    manifest:fixtures,
    maxPages:3,
    adapterFactory:() => ({
      fetchPage:async request => {
        const entry = fixtures[request.chain];
        if (request.cursor === null) {
          const reads = (pageZeroReads.get(request.chain) || 0) + 1;
          pageZeroReads.set(request.chain, reads);
          const page = passingPage(entry, null);
          if (reads > 1) page.transactions[0] = {
            ...page.transactions[0], blockHash:hash(8_888),
          };
          return page;
        }
        return passingPage(entry, request.cursor);
      },
    }),
  });

  assert.equal(result.ready, false);
  for (const chain of result.chains) {
    assert.equal(chain.duplicateTransactions, 1);
    assert.equal(chain.capabilities.pagination.passed, false);
    assert.equal(chain.capabilities.pagination.code, 'PAGE_ZERO_RESTART_MISMATCH');
  }
});

test('rejects conflicting transaction data while deduplicating page overlap', async () => {
  const fixtures = manifest();
  const result = await runGoldRushCanary({
    apiKey:'private-key',
    manifest:fixtures,
    maxPages:3,
    adapterFactory:() => ({
      fetchPage:async request => {
        const page = passingPage(fixtures[request.chain], request.cursor);
        if (request.cursor !== null) page.transactions[0] = {
          ...page.transactions[0], blockHash:hash(7_777),
        };
        return page;
      },
    }),
  });

  assert.equal(result.ready, false);
  for (const chain of result.chains) {
    assert.equal(chain.duplicateTransactions, 1);
    assert.equal(chain.capabilities.pagination.passed, false);
    assert.equal(chain.capabilities.pagination.code, 'DUPLICATE_TRANSACTION_CONFLICT');
  }
});

test('redacts adapter initialization and provider failures', async () => {
  const fixtures = manifest();
  const secret = 'do-not-return-this-secret';
  const initialization = await runGoldRushCanary({
    apiKey:secret,
    manifest:fixtures,
    adapterFactory:() => { throw new Error(`failed with ${secret}`); },
  });
  assert.equal(initialization.ready, false);
  assert.equal(initialization.chains[0].capabilities.pagination.code,
    'ADAPTER_INITIALIZATION_FAILED');
  assert.doesNotMatch(JSON.stringify(initialization), new RegExp(secret));

  const request = await runGoldRushCanary({
    apiKey:secret,
    manifest:fixtures,
    adapterFactory:() => ({
      fetchPage:async input => {
        throw new Error(`${secret}:${input.walletAddress}:${fixtures[input.chain].knownTxHashes[0]}`);
      },
    }),
  });
  assert.equal(request.ready, false);
  assert.equal(request.chains[0].capabilities.pagination.code, 'PROVIDER_REQUEST_FAILED');
  assert.doesNotMatch(JSON.stringify(request), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(request), new RegExp(fixtures.ethereum.address, 'i'));
});

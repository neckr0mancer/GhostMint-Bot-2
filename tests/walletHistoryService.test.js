const assert = require('node:assert/strict');
const test = require('node:test');
const { ValidationError } = require('../src/validation/domain');
const { createWalletHistoryService } = require('../src/walletHistory/service');

const wallet = { id: 7, chain: 'Ethereum', address: '0x00000000000000000000000000000000000000A7' };

function fixture({ supported = false, subject = null, fetchError = null, supportedChains = [],
  now = () => Date.now() } = {}) {
  const calls = [];
  const repository = {
    listPage: async (userId, input) => {
      calls.push(['list', userId, input]);
      return { items: [{ txHash: '0x1' }], total: 1, snapshotAt: '2026-01-01T00:00:00.000Z',
        snapshotScope:'first_observed_at', coverage: { state: 'partial' } };
    },
    listAccountPage: async (userId, input) => {
      calls.push(['account-list', userId, input]);
      return { items:[{txHash:'0x2',walletId:7,walletLabel:'Trading'}],total:1,
        snapshotAt:'2026-01-01T00:00:00.000Z',snapshotScope:'first_observed_at',
        coverage:{state:'mixed',chains:[]} };
    },
    registerSubject: async input => { calls.push(['register', input]); return input; },
    setSyncState: async input => { calls.push(['state', input]); return { state: input.state }; },
    queueSync: async input => { calls.push(['queue', input]); return { state:'queued' }; },
    getSubject: async input => { calls.push(['get', input]); return subject; },
    beginSync: async input => { calls.push(['begin', input]); return { generation: 3 }; },
    applyProviderPage: async input => { calls.push(['apply', input]); return { state: 'current', generation: input.generation, cursor: null }; },
    markSyncError: async input => { calls.push(['error', input]); return { state:'error' }; },
    deleteSubject: async input => { calls.push(['delete', input]); return true; },
  };
  const providerRegistry = {
    describe: input => ({ ...input, providerKey:supported?'fixture':null, supported, ...(supported ? { currentHeadBlock: '100' }
      : { reason: 'No indexer is configured.' }) }),
    fetchPage: async input => { calls.push(['fetch', input]); if (fetchError) throw fetchError; return { supported: true, transactions: [],
      hasMore: false, nextCursor: null, observedHeadBlock: '100',
      coverage: { history: { fromBlock: '0', throughBlock: '100', complete: true },
        provenance: { fromBlock: '100', throughBlock: '100', complete: true } },
      recheckRange: { fromBlock: '0', throughBlock: '100' } }; },
  };
  return { calls, repository, service: createWalletHistoryService({ repository, providerRegistry,
    supportedChains,now }) };
}

test('wallet history list validates and forwards snapshot-bounded pagination and filters', async () => {
  const { calls, service } = fixture();
  const result = await service.listHistory('user-a', wallet, { page: 2, pageSize: 25,
    source: 'external', direction: 'in', txHash: '0xabc' });
  assert.equal(result.page, 2);
  assert.equal(result.totalPages, 1);
  assert.equal(result.snapshotScope, 'first_observed_at');
  assert.equal(calls[0][0], 'list');
  assert.equal(calls[0][2].chain, null);
  assert.equal(calls[0][2].walletAddress, wallet.address.toLowerCase());
  assert.equal(calls[0][2].offset, 25);
  assert.equal(calls[0][2].source, 'external');
});
test('wallet history rejects unsafe filters before reaching storage', async () => {
  const { service } = fixture();
  await assert.rejects(service.listHistory('user-a', wallet, { source: 'provider_says_ghostmint' }),
    error => error instanceof ValidationError && error.issues[0].field === 'source');
  await assert.rejects(service.listHistory('user-a', wallet, { pageSize: 101 }),
    error => error instanceof ValidationError && error.issues[0].field === 'pageSize');
  const scoped = fixture({ supportedChains:['ethereum', 'base'] }).service;
  await assert.rejects(scoped.listHistory('user-a', wallet, { chain:'ink' }),
    error => error instanceof ValidationError && error.issues[0].field === 'chain');
});

test('account wallet history validates the shared filters and forwards the optional owned wallet scope', async () => {
  const {calls,service}=fixture({supportedChains:['ethereum','base']});
  const result=await service.listAccountHistory('user-a',{
    walletId:'7',page:'2',pageSize:'25',source:'external',direction:'in',txHash:'0xabc',
  });
  assert.equal(result.page,2);
  assert.equal(result.items[0].walletLabel,'Trading');
  const call=calls.find(item=>item[0]==='account-list');
  assert.equal(call[1],'user-a');
  assert.equal(call[2].walletId,7);
  assert.equal(call[2].chain,null);
  assert.deepEqual(call[2].supportedChains,['ethereum','base']);
  assert.equal(call[2].offset,25);
  assert.equal(call[2].source,'external');
  await assert.rejects(service.listAccountHistory('user-a',{walletId:'0'}),error=>
    error instanceof ValidationError&&error.issues[0].field==='walletId');
  await assert.rejects(service.listAccountHistory('user-a',{chain:'ink'}),error=>
    error instanceof ValidationError&&error.issues[0].field==='chain');
  await assert.rejects(service.listAccountHistory('user-a',{address:'not-an-address'}),error=>
    error instanceof ValidationError&&error.issues[0].field==='address');
});

test('unsupported wallet history sync is accepted but reports unsupported truthfully', async () => {
  const { calls, service } = fixture({ supported: false });
  const result = await service.requestSync('user-a', wallet);
  assert.deepEqual(result, { accepted: true, chain:'ethereum', supported: false, state: 'unsupported', providerKey: null,
    message: 'No indexer is configured.' });
  assert.equal(calls[0][0], 'register');
  assert.equal(calls[1][0], 'state');
  assert.equal(calls[1][1].state, 'unsupported');
});

test('worker fallback preserves its requested unsupported chain instead of fanning out', async () => {
  const { calls, service } = fixture({ supported:false, supportedChains:['ethereum', 'base'] });
  const result = await service.runSyncPage('user-a', wallet, { chain:'ethereum' });
  assert.equal(result.chain, 'ethereum');
  assert.deepEqual(calls.filter(call => call[0] === 'register').map(call => call[1].chain),
    ['ethereum']);
});

test('configured wallet history sync is queued without pretending it already ran', async () => {
  const { calls, service } = fixture({ supported: true });
  const result = await service.requestSync('user-a', wallet);
  assert.equal(result.state, 'queued');
  assert.equal(result.supported, true);
  assert.equal(calls[0][1].trackingStartBlock, '100');
  assert.equal(calls.some(call => call[0] === 'fetch'), false);
  assert.equal(calls.some(call => call[0] === 'queue'), true);
});

test('wallet history sync reports disabled without creating a queue when no worker can consume it', async () => {
  const { calls, repository } = fixture({ supported:true, supportedChains:['ethereum'] });
  const providerRegistry={describe:()=>{throw new Error('disabled sync must not inspect a provider');}};
  const service=createWalletHistoryService({repository,providerRegistry,
    supportedChains:['ethereum'],syncEnabled:false});
  assert.deepEqual(await service.requestSync('user-a',wallet),{
    accepted:false,supported:false,state:'disabled',
    message:'Wallet history sync is not enabled on this server.',
  });
  assert.deepEqual(calls,[]);
});

test('an unqualified sync request covers every supported EVM chain independently', async () => {
  const { calls, service } = fixture({ supported:false, supportedChains:['ethereum', 'base'] });
  const result = await service.requestSync('user-a', wallet);
  assert.equal(result.requestedChains, 2);
  assert.equal(result.supportedChains, 0);
  assert.equal(result.state, 'unsupported');
  assert.deepEqual(result.chains.map(item => item.chain), ['ethereum', 'base']);
  assert.deepEqual(calls.filter(call => call[0] === 'register').map(call => call[1].chain),
    ['ethereum', 'base']);
});

test('worker-facing sync applies explicit coverage and orphans only a complete generation range', async () => {
  const { calls, service } = fixture({ supported: true });
  const result = await service.runSyncPage('user-a', wallet);
  assert.equal(result.state, 'current');
  assert.deepEqual(calls.map(call => call[0]), ['register', 'get', 'begin', 'fetch', 'apply']);
  assert.deepEqual(calls[4][1].page.recheckRange, { fromBlock:'0', throughBlock:'100' });
  assert.equal(calls[4][1].expectedCursor, null);
});

test('worker-facing sync resumes the saved generation and cursor across provider pages', async () => {
  const savedCursor = { pageKey: 'next-page' };
  const { calls, service } = fixture({ supported: true, subject: { sync: {
    providerKey:'fixture', state:'backfilling', generation:7, cursor:savedCursor,
  } } });
  await service.runSyncPage('user-a', wallet);
  assert.equal(calls.some(call => call[0] === 'begin'), false);
  const fetch = calls.find(call => call[0] === 'fetch');
  const apply = calls.find(call => call[0] === 'apply');
  assert.deepEqual(fetch[1].cursor, savedCursor);
  assert.equal(apply[1].generation, 7);
});

test('a leased worker uses the existing subject without re-registering it', async () => {
  const subject = { sync:{ providerKey:'fixture', state:'backfilling', generation:7,
    cursor:{page:2}, claimedBy:'worker-a' } };
  const { calls, service } = fixture({ supported:true, subject });
  const result = await service.runSyncPage('user-a', wallet, { workerId:'worker-a' });
  assert.equal(result.stale, undefined);
  assert.equal(calls.some(call => call[0] === 'register'), false);
  assert.equal(calls.find(call => call[0] === 'apply')[1].workerId, 'worker-a');
});

test('a stale lease owner cannot call the provider or mutate the sync', async () => {
  const subject = { sync:{ providerKey:'fixture', state:'backfilling', generation:7,
    cursor:{page:2}, claimedBy:'worker-b' } };
  const { calls, service } = fixture({ supported:true, subject });
  const result = await service.runSyncPage('user-a', wallet, { workerId:'worker-a' });
  assert.equal(result.stale, true);
  assert.equal(calls.some(call => call[0] === 'fetch'), false);
  assert.equal(calls.some(call => call[0] === 'apply'), false);
});

test('provider failure marks only the generation and cursor that actually failed', async () => {
  const failure = new Error('provider unavailable');
  const savedCursor = { pageKey:'retry-this-page' };
  const { calls, service } = fixture({ supported:true, fetchError:failure, subject:{ sync:{
    providerKey:'fixture', state:'backfilling', generation:9, cursor:savedCursor,
  } } });
  await assert.rejects(service.runSyncPage('user-a', wallet), failure);
  const marked = calls.find(call => call[0] === 'error');
  assert.equal(marked[1].generation, 9);
  assert.deepEqual(marked[1].expectedCursor, savedCursor);
});

test('provider failure preserves safe diagnostics and bounded retry timing', async () => {
  const failure = Object.assign(new Error('GoldRush wallet history is temporarily rate limited.'), {
    code:'GOLDRUSH_RATE_LIMITED', retryAfterMs:7_000,
  });
  const { calls, service } = fixture({ supported:true, fetchError:failure, now:()=>1_000 });
  await assert.rejects(service.runSyncPage('user-a', wallet), failure);
  const marked = calls.find(call => call[0] === 'error')[1];
  assert.equal(marked.errorCode, 'GOLDRUSH_RATE_LIMITED');
  assert.equal(marked.errorMessage, failure.message);
  assert.ok(marked.retryAfter instanceof Date);
  assert.equal(marked.retryAfter.getTime(), 8_000);
});

test('permanent provider configuration failures wait for an explicit retry', async () => {
  const failure = Object.assign(new Error('GoldRush wallet history authorization failed.'), {
    code:'GOLDRUSH_AUTH_FAILED',
  });
  const { calls, service } = fixture({ supported:true, fetchError:failure, now:()=>1_000 });
  await assert.rejects(service.runSyncPage('user-a', wallet), failure);
  const marked = calls.find(call => call[0] === 'error')[1];
  assert.equal(marked.errorCode, 'GOLDRUSH_AUTH_FAILED');
  assert.equal(marked.retryAfter, null);
});

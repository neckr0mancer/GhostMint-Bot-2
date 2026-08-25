const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { handleMintPasteMessage } = require('../src/discord/discordBot');
const { createSeaDropDiscoveryService } = require('../src/mint/seaDropDiscoveryService');
const { createSchedulerWorker, STAGE_NOT_OPEN } = require('../src/scheduler/schedulerWorker');
const { createHttpAdapter } = require('../src/social/adapters');
const { createFlowStateStore } = require('../src/telegram/flowState');
const { createProviderService } = require('../src/transactions/providerService');
const { ValidationError } = require('../src/validation/domain');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('SEC-001 re-review: the fetch-time scraper guard rejects a persisted private IPv6 URL', async () => {
  let requests = 0;
  const adapter = createHttpAdapter('scraper', {
    request: async () => {
      requests += 1;
      return { data: '<p>review only</p>' };
    },
  });

  await assert.rejects(
    adapter.poll({
      id: 'review-rule', userId: 'review-user', name: 'review-rule',
      type: 'twitter_account', config: { sourceUrl: 'http://[::1]/' }, cursor: null,
    }),
    /private|internal/i,
  );
  assert.equal(requests, 0, 'the request transport must never receive a private destination');
});

test('TX-004 re-review: a timed-out candidate keeps aggregate broadcast truth ambiguous', async () => {
  let acceptedAfterTimeout = false;
  const service = createProviderService({
    chains: { ethereum: { chainId: 1, rpcUrls: ['rejecting-rpc', 'accepting-late-rpc'] } },
    timeoutMs: 10,
    retries: 0,
    providerFactory: url => ({ url }),
  });

  const outcome = await service.performAll('ethereum', 'broadcastTransaction', async provider => {
    if (provider.url === 'rejecting-rpc') {
      throw Object.assign(new Error('one RPC rejected'), { code: 'CALL_EXCEPTION' });
    }
    await wait(35);
    acceptedAfterTimeout = true;
    return { hash: '0xreview-accepted' };
  }, { timeoutMs: 10 }).then(value => ({ value }), error => ({ error }));

  await wait(45);
  assert.equal(acceptedAfterTimeout, true, 'the timed-out provider accepted the identical signed bytes');
  assert.notEqual(outcome.error?.code, 'CALL_EXCEPTION',
    'one definitive response cannot make a timed-out/possibly accepted aggregate definitive');
});

function transientDiscoveryFixture(etherscanGet) {
  const saved = [];
  const service = createSeaDropDiscoveryService({
    providerService: {
      perform: async (chain, name, operation) => operation({ getLogs: async () => [] }),
    },
    publicDropResolver: {
      async getPublicDrop() {
        return {
          mintPriceWei: '0', startTime: 0, endTime: 0,
          maxTotalMintableByWallet: 0, feeBps: 0, restrictFeeRecipients: false,
        };
      },
      async getAllowedFeeRecipients() { return []; },
    },
    chains: { ethereum: { chainId: 1 } },
    apiKey: 'review-only',
    repository: {
      async getSeaDrop() { return null; },
      async saveSeaDrop(chain, contractAddress, value) { saved.push(value); return value; },
    },
    http: { get: etherscanGet },
  });
  return { saved, service };
}

test('MINT-001 re-review: standard transport failures never persist a negative SeaDrop result', async () => {
  for (const code of ['ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_NETWORK']) {
    const { saved, service } = transientDiscoveryFixture(async () => {
      throw Object.assign(new Error('transport unavailable'), { code });
    });
    await service.resolve('ethereum', '0x0000000000000000000000000000000000000001');
    assert.equal(saved.length, 0, `${code} must remain retryable rather than poison the cache`);
  }
});

test('MINT-001 re-review: an Etherscan HTTP-200 rate-limit body is transient', async () => {
  const { saved, service } = transientDiscoveryFixture(async () => ({
    data: { status: '0', message: 'NOTOK', result: 'Max rate limit reached' },
  }));
  await service.resolve('ethereum', '0x0000000000000000000000000000000000000001');
  assert.equal(saved.length, 0, 'an application-level rate limit must not become a permanent negative cache row');
});

test('UX-002 re-review: an ignored Discord EOA paste preserves the active flow', async () => {
  const flowState = createFlowStateStore();
  flowState.start('discord', 'review-user', 'wallet_create', 'label', { marker: 'keep-me' });
  const message = {
    author: { id: 'review-user', bot: false }, guildId: 'review-guild', channelId: 'review-channel',
    content: '0x9999999999999999999999999999999999999999', replies: [],
    async reply(payload) { this.replies.push(payload); return { id: 'reply' }; },
  };
  const commands = {
    parseOpenSeaCollectionSlug: () => null,
    wallets: () => [],
    isContractAddress: async () => false,
  };

  await handleMintPasteMessage({
    identity: { resolveOrCreate: async () => 'internal-user' }, commands, flowState,
    chains: { ethereum: { name: 'Ethereum', sym: 'ETH' } }, rateLimiter: { check() {} },
  }, message);

  assert.equal(flowState.get('discord', 'review-user')?.data.marker, 'keep-me');
  assert.equal(message.replies.length, 0);
});

test('TX-007 re-review: one unchanged firing is pre-armed only once', async () => {
  const startedAt = Date.now();
  let prearms = 0;
  const task = {
    id: 'review-task', userId: 'review-user', name: 'review task',
    mintTime: startedAt + 120, nextAttemptAt: startedAt + 120,
  };
  const worker = createSchedulerWorker({
    repository: { async listImminent() { return [task]; } },
    intentRepository: {}, transactionEngine: {}, executeTask: async () => {},
    now: () => Date.now(), pollIntervalMs: 1_000, preciseArmWindowMs: 10,
    prearmLeadMs: 80, prearm: async () => { prearms += 1; },
  });

  await worker.armPreciseTimers();
  await wait(55);
  assert.equal(prearms, 1, 'the first lead timer should have fired once');
  await worker.armPreciseTimers();
  await wait(10);
  worker.stop();
  assert.equal(prearms, 1, 'later lookahead sweeps must not re-run preparation for the same firing');
});

test('TX-020 re-review: stop clears block-retry waiters', async () => {
  let nowMs = 1_000;
  const worker = createSchedulerWorker({
    repository: {
      async fail() { return 'retry'; },
      async claimSpecific() { return null; },
    },
    intentRepository: { async getByIdempotencyKey() { return null; } },
    transactionEngine: {},
    executeTask: async () => {
      throw new ValidationError({ field: 'stage', message: 'not open' }, STAGE_NOT_OPEN);
    },
    now: () => nowMs,
  });

  await worker.processTask({
    id: 'review-task', userId: 'review-user', chain: 'ethereum', idempotencyKey: 'review-key',
    attemptCount: 1, maxAttempts: 3,
  });
  assert.equal(worker.hasBlockWaiters('ethereum'), true);
  worker.stop();
  nowMs += 1_000;
  assert.equal(worker.hasBlockWaiters('ethereum'), false, 'shutdown must not retain waiters/listeners');
});

test('BASE-005 re-review: fixture cleanup SQL uses the column aliases it declares', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'clear-test-fixtures.js'), 'utf8');
  assert.doesNotMatch(source, /d\(user_id,\s*label\)[\s\S]{0,160}d\.uid/,
    'the derived table declares user_id/label, so d.uid/d.lbl makes the owner cleanup fail and roll back');
});

test('BASE-006 re-review: the shared worklist retains its title and valid Markdown rows', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'docs', 'agent', 'WORKLIST.md'), 'utf8');
  assert.match(source, /^# GhostMint — Agent Worklist/m, 'the worklist title and Phase 1 preamble must be preserved');
  const malformedRows = source.split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => /^\s*\|/.test(line) && !/\|\s*$/.test(line));
  assert.deepEqual(malformedRows, [], 'every Markdown table row must have a closing delimiter');
});

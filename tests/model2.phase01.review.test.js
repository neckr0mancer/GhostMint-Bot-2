const assert = require('node:assert/strict');
const test = require('node:test');

const { createSeaDropDiscoveryService } = require('../src/mint/seaDropDiscoveryService');
const { createProviderService } = require('../src/transactions/providerService');
const { requestSchemas } = require('../src/validation/domain');

test('SEC-001 review reproduction: scraper validation rejects private IPv6 literals', () => {
  for (const sourceUrl of [
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
  ]) {
    assert.throws(
      () => requestSchemas.watchRuleCreate({
        name: 'review-only',
        type: 'twitter_account',
        method: 'scraper',
        config: { handle: 'review-only', sourceUrl },
      }),
      /private|internal/i,
      `${sourceUrl} must be rejected before the scraper can request it`,
    );
  }
});

test('TX-004 review reproduction: one raced RPC rejection cannot hide another RPC acceptance', async () => {
  let acceptedBySecondProvider = false;
  const service = createProviderService({
    chains: { ethereum: { chainId: 1, rpcUrls: ['rejecting-rpc', 'accepting-rpc'] } },
    timeoutMs: 100,
    retries: 0,
    providerFactory: url => ({
      async broadcastTransaction() {
        if (url === 'rejecting-rpc') {
          throw Object.assign(new Error('first RPC reports a call exception'), { code: 'CALL_EXCEPTION' });
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        acceptedBySecondProvider = true;
        return { hash: `0x${'ab'.repeat(32)}` };
      },
    }),
  });

  const outcome = await service.performAll(
    'ethereum',
    'broadcastTransaction',
    provider => provider.broadcastTransaction('0xreview-only'),
  ).then(value => ({ value }), error => ({ error }));

  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(acceptedBySecondProvider, true, 'the second RPC must have accepted the same signed bytes');
  assert.equal(outcome.error, undefined,
    'performAll must report success when any RPC accepted; a permanent error here can mark a live transaction reverted');
  assert.equal(outcome.value.hash, `0x${'ab'.repeat(32)}`);
});

test('MINT-001 review reproduction: a common network reset cannot persist a negative SeaDrop cache entry', async () => {
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
      async saveSeaDrop(chain, contractAddress, value) {
        saved.push(value);
        return value;
      },
    },
    http: {
      async get() {
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      },
    },
  });

  await service.resolve('ethereum', '0x0000000000000000000000000000000000000001');
  assert.equal(saved.length, 0,
    'a transient Etherscan reset plus an empty non-archive RPC result must remain retryable, not be cached as non-SeaDrop');
});

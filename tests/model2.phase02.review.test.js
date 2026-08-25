const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseEther, parseUnits, Wallet } = require('ethers');

const { createDashboardApi } = require('../src/dashboard/api');
const {
  SEADROP_GATED_INTERFACE,
  validateOpenSeaMintCall,
} = require('../src/mint/seaDropCall');
const { createSeaDropDiscoveryService } = require('../src/mint/seaDropDiscoveryService');
const { createProofResolver } = require('../src/mint/proofResolver');
const { createSchedulerWorker } = require('../src/scheduler/schedulerWorker');
const {
  assertPublicScraperDestination,
  isPrivateScraperHostname,
} = require('../src/security/scraperUrlPolicy');
const { createProviderService } = require('../src/transactions/providerService');
const { createTransactionEngine } = require('../src/transactions/transactionEngine');
const { requestSchemas } = require('../src/validation/domain');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('SEC-001 phase-2: scraper DNS resolution fails closed', async () => {
  await assert.rejects(
    assertPublicScraperDestination('https://review.example/watch', {
      lookup: async () => { throw Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' }); },
    }),
    /dns|resolve|destination|unavailable/i,
    'a lookup failure must never authorize the subsequent request',
  );
});

test('SEC-001 phase-2: scraper policy rejects non-global address ranges', () => {
  for (const address of ['198.18.0.1', '224.0.0.1', '255.255.255.255', 'fec0::1', '::7f00:1']) {
    assert.equal(isPrivateScraperHostname(address), true,
      `${address} is not a globally routable scraper destination`);
  }
});

test('TX-004 phase-2: a definitive and a transient broadcast failure remain ambiguous', async () => {
  const service = createProviderService({
    chains: { ethereum: { chainId: 1, rpcUrls: ['definitive', 'transient'] } },
    timeoutMs: 20,
    retries: 0,
    providerFactory: url => ({ url }),
  });
  const error = await service.performAll('ethereum', 'broadcastTransaction', async provider => {
    if (provider.url === 'definitive') {
      throw Object.assign(new Error('call rejected'), { code: 'CALL_EXCEPTION' });
    }
    throw Object.assign(new Error('connection failed'), { code: 'NETWORK_ERROR' });
  }).then(() => null, caught => caught);

  assert.equal(error?.code, 'RPC_UNAVAILABLE',
    'a transient candidate means the signed transaction outcome is not definitively rejected');
  service.destroy();
});

test('TX-004 phase-2: sequential failover cannot report a revert after an earlier request may accept', async () => {
  let acceptedAfterTimeout = false;
  const service = createProviderService({
    chains: { ethereum: { chainId: 1, rpcUrls: ['accepts-late', 'definitive'] } },
    timeoutMs: 10,
    retries: 0,
    providerFactory: url => ({ url }),
  });
  const error = await service.perform('ethereum', 'broadcastTransaction', async provider => {
    if (provider.url === 'accepts-late') {
      await wait(35);
      acceptedAfterTimeout = true;
      return { hash: '0xreviewaccepted' };
    }
    throw Object.assign(new Error('call rejected'), { code: 'CALL_EXCEPTION' });
  }).then(() => null, caught => caught);

  await wait(45);
  assert.equal(acceptedAfterTimeout, true, 'the first timed-out request did accept the signed bytes');
  assert.equal(error?.code, 'RPC_UNAVAILABLE',
    'later definitive rejection cannot erase an earlier ambiguous broadcast');
  service.destroy();
});

test('MINT-001 phase-2: nested transport failures never persist a negative SeaDrop result', async () => {
  const saved = [];
  const service = createSeaDropDiscoveryService({
    providerService: {
      perform: async (_chain, _name, operation) => operation({ getLogs: async () => [] }),
    },
    publicDropResolver: {
      async getPublicDrop() { return null; },
      async getAllowedFeeRecipients() { return []; },
    },
    chains: { ethereum: { chainId: 1 } },
    apiKey: 'review-only',
    repository: {
      async getSeaDrop() { return null; },
      async saveSeaDrop(_chain, _contract, value) { saved.push(value); return value; },
    },
    http: {
      async get() {
        throw Object.assign(new Error('wrapped transport failure'), { cause: { code: 'EPIPE' } });
      },
    },
  });

  await service.resolve('ethereum', '0x0000000000000000000000000000000000000001');
  assert.equal(saved.length, 0, 'a nested EPIPE is retryable and must not poison the durable cache');
});

test('SEC-013 phase-2: automatic mint-proof lookup blocks private IPv6 before transport', async () => {
  let fetches = 0;
  const resolver = createProofResolver({
    fetchJson: async () => {
      fetches += 1;
      return { data: { proof: [`0x${'cd'.repeat(32)}`] } };
    },
  });

  await assert.rejects(resolver.resolve({
    methodSignature: 'mint(uint256,bytes32[])',
    arguments: [1],
    proofUrl: 'http://[::1]/proof',
    walletAddress: '0x00000000000000000000000000000000000000A1',
  }), /public|private|internal|proof URL/i);
  assert.equal(fetches, 0, 'a blocked proof destination must never reach the HTTP transport');
});

test('MINT-008 phase-2: OpenSea gated calldata cannot redirect value to an arbitrary call target', () => {
  const contractAddress = '0x0000000000000000000000000000000000000011';
  const minterAddress = '0x0000000000000000000000000000000000000022';
  const attackerTarget = '0x00000000000000000000000000000000000000ee';
  const mintParams = {
    mintPrice: 1n,
    maxTotalMintableByWallet: 1n,
    startTime: 1n,
    endTime: 4_000_000_000n,
    dropStageIndex: 0n,
    maxTokenSupplyForStage: 1n,
    feeBps: 0n,
    restrictFeeRecipients: false,
  };
  const data = SEADROP_GATED_INTERFACE.encodeFunctionData('mintAllowList', [
    contractAddress,
    '0x0000000000000000000000000000000000000000',
    minterAddress,
    1n,
    mintParams,
    [],
  ]);

  assert.throws(() => validateOpenSeaMintCall({
    built: { to: attackerTarget, data, valueWei: '1', chain: 'wrong-chain' },
    contractAddress,
    quantity: 1,
    minterAddress,
  }), /target|SeaDrop|chain/i,
  'the call target must be the canonical or freshly verified allowed SeaDrop on the requested chain');
});

test('TX-007 phase-2: a completed pre-arm is replaced when the firing moves', async () => {
  let current = {
    id: 'review-task', userId: 'review-user', name: 'review task',
    mintTime: Date.now() + 35, nextAttemptAt: Date.now() + 35,
  };
  let prearms = 0;
  const worker = createSchedulerWorker({
    repository: { async listImminent() { return [current]; } },
    intentRepository: {}, transactionEngine: {}, executeTask: async () => {},
    preciseArmWindowMs: 1,
    prearmLeadMs: 20,
    prearm: async () => { prearms += 1; },
  });

  await worker.armPreciseTimers();
  await wait(30);
  assert.equal(prearms, 1, 'the original firing should be prepared once');
  const moved = Date.now() + 35;
  current = { ...current, mintTime: moved, nextAttemptAt: moved };
  await worker.armPreciseTimers();
  await wait(30);
  worker.stop();
  assert.equal(prearms, 2, 'a completed sentinel for the old firing must not suppress the moved firing');
});

test('TX-020 phase-2: stop terminates stale-claim recovery sweeps', async () => {
  let sweeps = 0;
  const worker = createSchedulerWorker({
    repository: {
      async listStaleClaims() { sweeps += 1; return []; },
      async claimDue() { return null; },
      async listImminent() { return []; },
    },
    intentRepository: {}, transactionEngine: {}, executeTask: async () => {},
    pollIntervalMs: 1_000,
    staleRecoveryIntervalMs: 10,
  });

  worker.start();
  await wait(35);
  worker.stop();
  const stoppedAt = sweeps;
  await wait(35);
  assert.equal(sweeps, stoppedAt, 'recovery work must not continue after shutdown');
});

test('TX-020 phase-2: a block cannot consume a waiter before retry state is durable', async () => {
  let now = 1_000;
  let retryPersisted = false;
  let claimSawPersistedState = null;
  let worker;
  const early = Object.assign(new Error('stage not open'), { code: 'STAGE_NOT_OPEN' });
  const repository = {
    async fail() { retryPersisted = true; return 'retry'; },
    async claimSpecific() { claimSawPersistedState = retryPersisted; return null; },
  };
  worker = createSchedulerWorker({
    repository,
    intentRepository: { async getByIdempotencyKey() { return null; } },
    transactionEngine: {},
    executeTask: async () => { throw early; },
    now: () => now,
    onStageNotOpen: chain => {
      now += 1_000;
      worker.handleBlock(chain);
    },
  });

  await worker.processTask({
    id: 'review-task', userId: 'review-user', name: 'review task', chain: 'ethereum',
    idempotencyKey: 'review-key', attemptCount: 1, maxAttempts: 3,
  });
  await wait(5);
  worker.stop();
  assert.equal(claimSawPersistedState, true,
    'the exact-task claim must run only after repository.fail has made the retry claimable');
});

test('TX-014 phase-2: a missed signed-hash attach aborts before broadcast', async () => {
  const signer = new Wallet(`0x${'42'.repeat(32)}`);
  let broadcasts = 0;
  const repository = {
    async createSubmitted(input) {
      return { ...input, intentId: 'review-intent', state: 'submitted', txHash: null };
    },
    async attachSignedHash() { return null; },
    async rollingSpendWei() { return 0n; },
    async transition(intentId, state, details = {}) {
      return { intentId, state, ...details };
    },
  };
  const provider = {
    async getFeeData() {
      return { gasPrice: parseUnits('2', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null };
    },
    async estimateGas() { return 21_000n; },
    async getBalance() { return parseEther('10'); },
    async call() { return '0x'; },
    async getTransactionCount() { return 0; },
    async getNetwork() { return { chainId: 1n }; },
    async broadcastTransaction() { broadcasts += 1; return { hash: '0xreview' }; },
  };
  const engine = createTransactionEngine({
    providerService: {
      expectedChainId: () => 1,
      perform: (_chain, _name, operation) => operation(provider),
    },
    intentRepository: repository,
    policyRepository: {
      async resolvePolicy() {
        return {
          simulationEnabled: true,
          gasCeilingGwei: 100,
          maxTransactionValueWei: parseEther('1'),
          dailySpendingBudgetWei: parseEther('2'),
          requiredConfirmations: 1,
          transactionTimeoutMs: 1_000,
          gasPriceMultiplier: 1,
          ceilingExempt: false,
        };
      },
    },
    decryptPrivateKey: () => `0x${'42'.repeat(32)}`,
  });

  await assert.rejects(engine.submit({
    userId: '11111111-1111-4111-8111-111111111111',
    wallet: { id: 1, address: signer.address },
    chain: 'ethereum',
    to: '0x0000000000000000000000000000000000000001',
    data: '0x',
    valueWei: 0n,
  }));
  assert.equal(broadcasts, 0,
    'if the durable hash CAS misses, no provider may receive the signed transaction');
});

function responseFixture() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('TX-024 phase-2: dashboard batch preview rejects duplicate wallets before preparation', async () => {
  let prepared = 0;
  let submitted = 0;
  const commands = {
    async prepareMint(_userId, input) {
      prepared += 1;
      return {
        wallet: {
          label: input.walletLabel,
          address: '0x0000000000000000000000000000000000000001',
          chain: 'ethereum',
        },
        prepared: {
          chain: 'ethereum',
          preview: { contractAddress: '0x0000000000000000000000000000000000000002' },
        },
        simulation: { ok: true },
      };
    },
    async submitPreparedMint() {
      submitted += 1;
      return { state: 'confirmed', txHash: null };
    },
  };
  const api = createDashboardApi({
    auth: {}, identityRepository: {}, commands,
    chains: { ethereum: { name: 'Ethereum' } },
  });
  const request = {
    dashboardSession: { userId: 'review-user' },
    body: { walletLabels: ['alpha', 'alpha'] },
  };
  const preview = responseFixture();
  let forwarded = null;
  await api.previewMint(request, preview, error => { forwarded = error; });
  assert.ifError(forwarded);

  if (preview.body?.previewToken) {
    const confirm = responseFixture();
    await api.confirmMint({
      dashboardSession: { userId: 'review-user' },
      body: { previewToken: preview.body.previewToken, confirmation: 'CONFIRM' },
    }, confirm, error => { forwarded = error; });
    assert.ifError(forwarded);
  }

  assert.equal(preview.statusCode, 400, 'duplicate labels must be rejected as invalid input');
  assert.equal(prepared, 0, 'invalid batches must not consume simulation/RPC work');
  assert.equal(submitted, 0, 'one confirmation must never submit the same wallet twice');
});

test('TX-027 phase-2: dashboard confirm never reports a reverted intent as a successful mint', async () => {
  const commands = {
    async prepareMint(_userId, input) {
      return {
        wallet: {
          label: input.walletLabel,
          address: '0x0000000000000000000000000000000000000001',
          chain: 'ethereum',
        },
        prepared: {
          chain: 'ethereum',
          preview: { contractAddress: '0x0000000000000000000000000000000000000002' },
        },
        simulation: { ok: true },
      };
    },
    async submitPreparedMint() {
      return { state: 'reverted', txHash: '0xreviewreverted' };
    },
  };
  const api = createDashboardApi({
    auth: {}, identityRepository: {}, commands,
    chains: { ethereum: { name: 'Ethereum' } },
  });
  const preview = responseFixture();
  let forwarded = null;
  await api.previewMint({
    dashboardSession: { userId: 'review-user' },
    body: { walletLabel: 'alpha' },
  }, preview, error => { forwarded = error; });
  assert.ifError(forwarded);

  const confirm = responseFixture();
  await api.confirmMint({
    dashboardSession: { userId: 'review-user' },
    body: { previewToken: preview.body.previewToken, confirmation: 'CONFIRM' },
  }, confirm, error => { forwarded = error; });
  assert.ifError(forwarded);
  assert.equal(confirm.body.results[0].status, 'failed',
    'only a confirmed intent may increment mint activity or produce a success response');
});

test('TX-025 phase-2: viaOpenSea must be a validated boolean', () => {
  const now = Date.now();
  assert.throws(() => requestSchemas.taskCreate({
    name: 'review task',
    walletLabel: 'alpha',
    contractAddress: '0x0000000000000000000000000000000000000001',
    functionName: 'mint',
    quantity: 1,
    priceETH: 0,
    chain: 'ethereum',
    mintTime: new Date(now + 60_000).toISOString(),
    viaOpenSea: 'false',
  }, { supportedChains: ['ethereum'], now }), error => (
    error?.issues?.some(issue => issue.field === 'viaOpenSea')
  ), 'string truthiness must not select the OpenSea transaction path');
});

test('TX-026 phase-2: phase eligibility cannot churn beyond the documented 24-hour window', () => {
  const now = Date.now();
  const mintTime = now + 60_000;
  assert.throws(() => requestSchemas.taskCreate({
    name: 'review task',
    walletLabel: 'alpha',
    contractAddress: '0x0000000000000000000000000000000000000001',
    functionName: 'mint',
    quantity: 1,
    priceETH: 0,
    chain: 'ethereum',
    mintTime: new Date(mintTime).toISOString(),
    eligibilityMode: 'earliest_eligible',
    eligibilityDeadline: new Date(mintTime + (24 * 60 * 60 * 1_000) + 1).toISOString(),
  }, { supportedChains: ['ethereum'], now }), error => (
    error?.issues?.some(issue => issue.field === 'eligibilityDeadline')
  ), 'an API caller must not create years of per-minute phase attempts and audit rows');
});

test('BASE-005 phase-2: fixture cleanup cannot infer wallet ownership from task history', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'clear-test-fixtures.js'), 'utf8');
  assert.doesNotMatch(source, /DELETE\s+FROM\s+wallets\b/i,
    'wallet keys need explicit fixture provenance; absence of non-fixture activity does not prove a wallet is disposable');
});

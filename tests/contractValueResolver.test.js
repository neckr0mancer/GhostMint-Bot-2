const assert = require('node:assert/strict');
const test = require('node:test');
const { Interface } = require('ethers');
const { createContractValueResolver, CANDIDATES } = require('../src/mint/contractValueResolver');

const CONTRACT = '0x00000000000000000000000000000000000000C3';

function fakeRepository(initial = null) {
  const saved = [];
  return {
    saved,
    async get() { return initial; },
    async save(chain, contractAddress, value) { saved.push(value); return { ...value, resolvedAt: new Date() }; },
  };
}

// Builds a providerService.perform stub that answers a fixed map of {functionName: returnValue},
// reverting (throwing) for any function not in the map -- same "missing getter" shape a real
// contract without that function would produce.
function fakeProviderService(answers) {
  return {
    async perform(chain, name, operation) {
      return operation({
        async call({ data }) {
          for (const [functionName, value] of Object.entries(answers)) {
            const iface = new Interface([`function ${functionName}() view returns (uint256)`]);
            if (data === iface.encodeFunctionData(functionName, [])) {
              return iface.encodeFunctionResult(functionName, [value]);
            }
          }
          throw new Error('CALL_EXCEPTION');
        },
      });
    },
  };
}

test('resolves price, maxSupply, maxPerWallet, and totalMinted independently from their first matching candidate getter', async () => {
  const providerService = fakeProviderService({ mintPrice: 1000n, MAX_SUPPLY: 10_000n, maxPerWallet: 5n, totalSupply: 3_000n });
  const repository = fakeRepository();
  const resolver = createContractValueResolver({ providerService, repository });
  const result = await resolver.resolve('ethereum', CONTRACT);
  assert.deepEqual(result.price, { value: '1000', source: 'mintPrice' });
  assert.deepEqual(result.maxSupply, { value: '10000', source: 'MAX_SUPPLY' });
  assert.deepEqual(result.maxPerWallet, { value: '5', source: 'maxPerWallet' });
  assert.deepEqual(result.totalMinted, { value: '3000', source: 'totalSupply' });
});

test('totalMinted and maxSupply are resolved independently -- a contract with only totalSupply() reports the same number under both', async () => {
  // totalSupply() is a shared fallback candidate for both maxSupply (fixed-cap stand-in) and
  // totalMinted (current count) -- a contract that only implements this one getter is ambiguous
  // between "fixed supply" and "current count" by design, and both resolve to it.
  const providerService = fakeProviderService({ totalSupply: 500n });
  const repository = fakeRepository();
  const resolver = createContractValueResolver({ providerService, repository });
  const result = await resolver.resolve('ethereum', CONTRACT);
  assert.equal(result.maxSupply.value, '500');
  assert.equal(result.totalMinted.value, '500');
});

test('falls through candidate names in order and reports null for a value no candidate resolves', async () => {
  const providerService = fakeProviderService({ price: 250n });
  const repository = fakeRepository();
  const resolver = createContractValueResolver({ providerService, repository });
  const result = await resolver.resolve('ethereum', CONTRACT);
  assert.deepEqual(result.price, { value: '250', source: 'price' });
  assert.equal(result.maxSupply, null);
  assert.equal(result.maxPerWallet, null);
  assert.equal(result.totalMinted, null);
});

test('an already-cached row is returned immediately without any provider calls', async () => {
  const cached = { price: null, maxSupply: null, maxPerWallet: null, totalMinted: null, resolvedAt: new Date() };
  const repository = fakeRepository(cached);
  const resolver = createContractValueResolver({
    providerService: { perform: async () => { throw new Error('should not be called'); } }, repository,
  });
  const result = await resolver.resolve('ethereum', CONTRACT);
  assert.equal(result, cached);
  assert.equal(repository.saved.length, 0);
});

test('candidate lists are exported for other modules to reference', () => {
  assert.ok(CANDIDATES.totalMinted.includes('totalSupply'));
});

// Section AD Tier 1 -- probeTotalMinted must be live every call, never served from the shared
// contract_value_cache row (which may already exist with total_minted left NULL from a SeaDrop or
// OpenSea-only save, per resolve()'s cache-row gotcha documented in the source).
test('probeTotalMinted resolves live and ignores the repository entirely, even when a cached row already exists', async () => {
  const providerService = fakeProviderService({ totalSupply: 4_242n });
  const repository = fakeRepository({ price: null, maxSupply: null, maxPerWallet: null, totalMinted: null, resolvedAt: new Date() });
  const resolver = createContractValueResolver({ providerService, repository });
  const result = await resolver.probeTotalMinted('ethereum', CONTRACT);
  assert.deepEqual(result, { value: '4242', source: 'totalSupply' });
  assert.equal(repository.saved.length, 0, 'must never write to the shared cache row');
});

test('probeTotalMinted returns null when no candidate getter resolves, without throwing', async () => {
  const providerService = fakeProviderService({});
  const repository = fakeRepository();
  const resolver = createContractValueResolver({ providerService, repository });
  assert.equal(await resolver.probeTotalMinted('ethereum', CONTRACT), null);
});

// SeaDrop's PublicDrop struct has no supply-cap field, so detectMintContract's SeaDrop branch
// calls this instead of resolve() for maxSupply -- must be live and bypass the repository for the
// same cache-collision reason probeTotalMinted does (a SeaDrop-only save may already have written a
// row with max_total_supply left NULL, which resolve() would then treat as cached forever).
test('probeMaxSupply resolves live and ignores the repository entirely, even when a cached row already exists', async () => {
  const providerService = fakeProviderService({ maxSupply: 8_888n });
  const repository = fakeRepository({ price: null, maxSupply: null, maxPerWallet: null, totalMinted: null, resolvedAt: new Date() });
  const resolver = createContractValueResolver({ providerService, repository });
  const result = await resolver.probeMaxSupply('ethereum', CONTRACT);
  assert.deepEqual(result, { value: '8888', source: 'maxSupply' });
  assert.equal(repository.saved.length, 0, 'must never write to the shared cache row');
});

test('probeMaxSupply returns null when no candidate getter resolves, without throwing', async () => {
  const providerService = fakeProviderService({});
  const repository = fakeRepository();
  const resolver = createContractValueResolver({ providerService, repository });
  assert.equal(await resolver.probeMaxSupply('ethereum', CONTRACT), null);
});

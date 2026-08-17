const assert = require('node:assert/strict');
const test = require('node:test');
const { parseUnits } = require('ethers');
const { createGasService } = require('../src/gas/gasService');
const { GasLookupError } = require('../src/gas/etherscanGasService');

const CHAINS = { robinhood: { chainId: 4663 } };

test('a successful Etherscan lookup is returned directly, without ever touching the RPC fallback', async () => {
  const etherscanResult = { chain: 'ethereum', chainId: 1, safeGasPriceGwei: 10, gasPriceGwei: 12, maxFeePerGasGwei: 15, source: 'etherscan-v2' };
  const service = createGasService({
    etherscanService: { lookup: async () => etherscanResult },
    providerService: { perform: async () => { throw new Error('should not be called'); } },
    chains: CHAINS,
  });
  const result = await service.lookup('ethereum');
  assert.deepEqual(result, etherscanResult);
});

test('falls back to the chain\'s own RPC (getFeeData) when Etherscan has no data for the chain', async () => {
  const service = createGasService({
    etherscanService: { lookup: async () => { throw new GasLookupError('UNSUPPORTED_CHAIN', 'nope'); } },
    providerService: { perform: async (chain, op, run) => run({ getFeeData: async () => ({ gasPrice: parseUnits('3', 'gwei'), maxFeePerGas: parseUnits('5', 'gwei'), maxPriorityFeePerGas: parseUnits('1', 'gwei') }) }) },
    chains: CHAINS,
  });
  const result = await service.lookup('robinhood');
  assert.equal(result.chain, 'robinhood');
  assert.equal(result.chainId, 4663);
  assert.equal(result.safeGasPriceGwei, 3);
  assert.equal(result.gasPriceGwei, 3);
  assert.equal(result.maxFeePerGasGwei, 5);
  assert.equal(result.source, 'rpc-fallback');
});

test('the RPC fallback reports the same figure for every field on a legacy chain with no EIP-1559 fee data', async () => {
  const service = createGasService({
    etherscanService: { lookup: async () => { throw new GasLookupError('UNSUPPORTED_CHAIN', 'nope'); } },
    providerService: { perform: async (chain, op, run) => run({ getFeeData: async () => ({ gasPrice: parseUnits('7', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }) }) },
    chains: CHAINS,
  });
  const result = await service.lookup('robinhood');
  assert.equal(result.safeGasPriceGwei, 7);
  assert.equal(result.gasPriceGwei, 7);
  assert.equal(result.maxFeePerGasGwei, 7);
});

test('a non-GasLookupError from Etherscan propagates without triggering the RPC fallback', async () => {
  const service = createGasService({
    etherscanService: { lookup: async () => { throw new Error('boom'); } },
    providerService: { perform: async () => { throw new Error('should not be called'); } },
    chains: CHAINS,
  });
  await assert.rejects(service.lookup('robinhood'), /boom/);
});

test('an unconfigured chain fails closed even before touching the RPC', async () => {
  const service = createGasService({
    etherscanService: { lookup: async () => { throw new GasLookupError('UNSUPPORTED_CHAIN', 'nope'); } },
    providerService: { perform: async () => { throw new Error('should not be called'); } },
    chains: CHAINS,
  });
  await assert.rejects(service.lookup('not-a-real-chain'), GasLookupError);
});

test('a failed RPC fallback still surfaces as a GasLookupError, not a raw provider error', async () => {
  const service = createGasService({
    etherscanService: { lookup: async () => { throw new GasLookupError('UNSUPPORTED_CHAIN', 'nope'); } },
    providerService: { perform: async () => { throw new Error('all RPC endpoints unreachable'); } },
    chains: CHAINS,
  });
  await assert.rejects(service.lookup('robinhood'), GasLookupError);
});

test('an RPC response with no usable fee fields at all is reported as a provider error', async () => {
  const service = createGasService({
    etherscanService: { lookup: async () => { throw new GasLookupError('UNSUPPORTED_CHAIN', 'nope'); } },
    providerService: { perform: async (chain, op, run) => run({ getFeeData: async () => ({ gasPrice: null, maxFeePerGas: null, maxPriorityFeePerGas: null }) }) },
    chains: CHAINS,
  });
  await assert.rejects(service.lookup('robinhood'), GasLookupError);
});

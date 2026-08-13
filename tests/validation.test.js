const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LIMITS,
  MAX_SCHEDULE_AHEAD_MS,
  ValidationError,
  requestSchemas,
  validationPayload,
  validationReply,
} = require('../src/validation/domain');

const CHAINS = ['ethereum', 'base', 'arbitrum', 'polygon'];
const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const CONTRACT = '0x0000000000000000000000000000000000000001';

function validMint(overrides = {}) {
  return {
    walletLabel: 'Primary Wallet',
    contractAddress: CONTRACT,
    functionName: 'mint',
    quantity: 1,
    priceETH: 0,
    chain: 'ethereum',
    ...overrides,
  };
}

function validTask(overrides = {}) {
  return {
    name: 'Launch mint',
    ...validMint(),
    mintTime: new Date(NOW + 60_000).toISOString(),
    ...overrides,
  };
}

function rejectsField(callback, field) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.issues[0].field, field);
    return true;
  });
}

test('invalid, past, and timer-overflow dates cannot create tasks', () => {
  rejectsField(() => requestSchemas.taskCreate(validTask({ mintTime: 'not-a-date' }), { supportedChains: CHAINS, now: NOW }), 'mintTime');
  rejectsField(() => requestSchemas.taskCreate(validTask({ mintTime: new Date(NOW - 1).toISOString() }), { supportedChains: CHAINS, now: NOW }), 'mintTime');
  rejectsField(() => requestSchemas.taskCreate(validTask({ mintTime: NOW + MAX_SCHEDULE_AHEAD_MS + 1 }), { supportedChains: CHAINS, now: NOW }), 'mintTime');
  const accepted = requestSchemas.taskCreate(validTask(), { supportedChains: CHAINS, now: NOW });
  assert.equal(accepted.mintTime, NOW + 60_000);
  assert.match(accepted.id, /^[0-9a-f-]{36}$/);
});

test('unsupported chains are rejected instead of defaulting to Ethereum', () => {
  rejectsField(() => requestSchemas.mint(validMint({ chain: 'solana' }), { supportedChains: CHAINS }), 'chain');
  rejectsField(() => requestSchemas.mint(validMint({ chain: '' }), { supportedChains: CHAINS }), 'chain');
});

test('negative, NaN, infinite, fractional, and oversized numeric values are rejected', () => {
  const cases = [
    ['quantity', { quantity: -1 }],
    ['quantity', { quantity: 'NaN' }],
    ['quantity', { quantity: 1.5 }],
    ['quantity', { quantity: LIMITS.quantity + 1 }],
    ['priceETH', { priceETH: -0.1 }],
    ['priceETH', { priceETH: Infinity }],
    ['priceETH', { priceETH: LIMITS.priceEth + 1 }],
    ['gasLimit', { gasLimit: 20_999 }],
    ['gasLimit', { gasLimit: LIMITS.gasLimit + 1 }],
    ['maxFeePerGasGwei', { maxFeePerGasGwei: LIMITS.feeGwei + 1 }],
  ];
  for (const [field, overrides] of cases) {
    rejectsField(() => requestSchemas.mint(validMint(overrides), { supportedChains: CHAINS }), field);
  }
  rejectsField(() => requestSchemas.sniperCreate({
    label: 'watcher', targetAddress: CONTRACT, chain: 'ethereum', walletLabel: 'Primary',
    fixedValueETH: -1, gasBoostPercent: 20,
  }, { supportedChains: CHAINS }), 'fixedValueETH');
  rejectsField(() => requestSchemas.sniperCreate({
    label: 'watcher', targetAddress: CONTRACT, chain: 'ethereum', walletLabel: 'Primary',
    fixedValueETH: 0, gasBoostPercent: LIMITS.sniperGasBoostPercent + 1,
  }, { supportedChains: CHAINS }), 'gasBoostPercent');
  const sniper = requestSchemas.sniperCreate({
    label: 'watcher', targetAddress: CONTRACT, chain: 'ethereum', walletLabel: 'Primary',
  }, { supportedChains: CHAINS });
  assert.match(sniper.id, /^[0-9a-f-]{36}$/);
});

test('addresses, function names, ABI definitions, labels, and label uniqueness are validated', () => {
  rejectsField(() => requestSchemas.mint(validMint({ contractAddress: '0x1234' }), { supportedChains: CHAINS }), 'contractAddress');
  rejectsField(() => requestSchemas.mint(validMint({ functionName: 'mint()' }), { supportedChains: CHAINS }), 'functionName');
  rejectsField(() => requestSchemas.mint(validMint({ abi: 'not-json' }), { supportedChains: CHAINS }), 'abi');
  rejectsField(() => requestSchemas.walletCreate({
    privateKey: `0x${'11'.repeat(32)}`, label: 'Primary', chain: 'ethereum',
  }, { supportedChains: CHAINS, existingLabels: ['primary'] }), 'label');
});

test('invalid deletion identifiers are rejected before ownership mutation', () => {
  rejectsField(() => requestSchemas.taskDeletion({ id: '12345' }), 'id');
  rejectsField(() => requestSchemas.sniperDeletion({ id: 'not-a-uuid' }), 'id');
  rejectsField(() => requestSchemas.pnlDeletion({ id: -1 }), 'id');
  assert.deepEqual(requestSchemas.taskDeletion({ id: '550e8400-e29b-41d4-a716-446655440000' }), {
    id: '550e8400-e29b-41d4-a716-446655440000',
  });
});

test('HTTP and Telegram validation formats carry the same stable code and issue', () => {
  let error;
  try { requestSchemas.mint(validMint({ chain: 'unsupported' }), { supportedChains: CHAINS }); }
  catch (caught) { error = caught; }
  const payload = validationPayload(error);
  const reply = validationReply(error);
  assert.equal(payload.code, 'VALIDATION_ERROR');
  assert.equal(payload.issues[0].field, 'chain');
  assert.match(reply, /Validation failed: chain/);
});

test('transaction policy settings validate editable safety values', () => {
  const settings = requestSchemas.transactionPolicy({
    simulationEnabled: false,
    gasCeilingGwei: 12.5,
    maxTransactionValueWei: '100000000000000000',
    dailySpendingBudgetWei: 250000000000000000n,
    requiredConfirmations: 12,
    transactionTimeoutMs: 600000,
  });
  assert.equal(settings.simulationEnabled, false);
  assert.equal(settings.maxTransactionValueWei, 100000000000000000n);
  rejectsField(() => requestSchemas.transactionPolicy({ simulationEnabled: 'false' }), 'simulationEnabled');
  rejectsField(() => requestSchemas.transactionPolicy({ maxTransactionValueWei: '-1' }), 'maxTransactionValueWei');
  rejectsField(() => requestSchemas.transactionPolicy({ requiredConfirmations: 0 }), 'requiredConfirmations');
});

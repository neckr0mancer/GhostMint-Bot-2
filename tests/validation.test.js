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

test('invalid, past, and overly distant dates cannot create tasks', () => {
  rejectsField(() => requestSchemas.taskCreate(validTask({ mintTime: 'not-a-date' }), { supportedChains: CHAINS, now: NOW }), 'mintTime');
  rejectsField(() => requestSchemas.taskCreate(validTask({ mintTime: new Date(NOW - 1).toISOString() }), { supportedChains: CHAINS, now: NOW }), 'mintTime');
  rejectsField(() => requestSchemas.taskCreate(validTask({ mintTime: NOW + MAX_SCHEDULE_AHEAD_MS + 1 }), { supportedChains: CHAINS, now: NOW }), 'mintTime');
  const accepted = requestSchemas.taskCreate(validTask(), { supportedChains: CHAINS, now: NOW });
  assert.equal(accepted.mintTime, NOW + 60_000);
  assert.match(accepted.id, /^[0-9a-f-]{36}$/);
});

test('schedule strings require an explicit timezone', () => {
  rejectsField(() => requestSchemas.taskCreate(validTask({ mintTime:'2030-01-01T12:00:00' }), { supportedChains:CHAINS, now:NOW }), 'mintTime');
  assert.equal(requestSchemas.taskCreate(validTask({ mintTime:'2030-01-01T12:00:00Z' }), { supportedChains:CHAINS, now:NOW }).mintTime,
    Date.parse('2030-01-01T12:00:00Z'));
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
  rejectsField(() => requestSchemas.sniperCreate({
    label:'watcher', targetAddress:CONTRACT, chain:'ethereum', walletLabel:'Primary',
    contractAllowlist:[CONTRACT], contractDenylist:[CONTRACT],
  }, { supportedChains:CHAINS }), 'contractAllowlist');
  rejectsField(() => requestSchemas.sniperCreate({
    label:'watcher', targetAddress:CONTRACT, chain:'ethereum', walletLabel:'Primary', maxAttempts:21,
  }, { supportedChains:CHAINS }), 'maxAttempts');
});

test('addresses, function names, ABI definitions, labels, and label uniqueness are validated', () => {
  rejectsField(() => requestSchemas.mint(validMint({ contractAddress: '0x1234' }), { supportedChains: CHAINS }), 'contractAddress');
  rejectsField(() => requestSchemas.mint(validMint({ functionName: 'mint()' }), { supportedChains: CHAINS }), 'functionName');
  rejectsField(() => requestSchemas.mint(validMint({ functionName: 'publicMint' }), { supportedChains: CHAINS }), 'functionName');
  rejectsField(() => requestSchemas.mint(validMint({ abi: [{ type:'function', name:'mint', inputs:[] }] }), { supportedChains: CHAINS }), 'abi');
  rejectsField(() => requestSchemas.mint(validMint({ abi: 'not-json' }), { supportedChains: CHAINS }), 'abi');
  rejectsField(() => requestSchemas.walletCreate({
    privateKey: `0x${'11'.repeat(32)}`, label: 'Primary', chain: 'ethereum',
  }, { supportedChains: CHAINS, existingLabels: ['primary'] }), 'label');
});

test('wallet import accepts either a private key or a seed phrase and derives the same kind of result either way', () => {
  const byKey = requestSchemas.walletCreate({
    importMethod: 'privateKey', privateKey: `0x${'11'.repeat(32)}`, label: 'Primary', chain: 'ethereum',
  }, { supportedChains: CHAINS, existingLabels: [] });
  assert.equal(byKey.address, '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
  const byPhrase = requestSchemas.walletCreate({
    importMethod: 'seedPhrase', seedPhrase: 'test test test test test test test test test test test junk',
    label: 'Recovered', chain: 'ethereum',
  }, { supportedChains: CHAINS, existingLabels: [] });
  assert.equal(byPhrase.address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.equal(byPhrase.privateKey, '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  rejectsField(() => requestSchemas.walletCreate({
    importMethod: 'seedPhrase', seedPhrase: 'not a real recovery phrase', label: 'Bad', chain: 'ethereum',
  }, { supportedChains: CHAINS, existingLabels: [] }), 'seedPhrase');
});

test('invalid deletion identifiers are rejected before ownership mutation', () => {
  rejectsField(() => requestSchemas.taskDeletion({ id: '12345' }), 'id');
  rejectsField(() => requestSchemas.sniperDeletion({ id: 'not-a-uuid' }), 'id');
  rejectsField(() => requestSchemas.pnlDeletion({ id: -1 }), 'id');
  assert.equal(requestSchemas.pnlDeletion({id:'123e4567-e89b-42d3-a456-426614174000'}).id,
    '123e4567-e89b-42d3-a456-426614174000');
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

test('send requires a positive amount, a valid destination, and has no contract-shaped fields', () => {
  const valid = requestSchemas.send({
    walletLabel: 'Primary', toAddress: CONTRACT, amountETH: 0.5, chain: 'ethereum',
  }, { supportedChains: CHAINS });
  assert.deepEqual(Object.keys(valid).sort(), ['amountETH', 'chain', 'gasGwei', 'toAddress', 'walletLabel']);
  rejectsField(() => requestSchemas.send({
    walletLabel: 'Primary', toAddress: CONTRACT, amountETH: 0, chain: 'ethereum',
  }, { supportedChains: CHAINS }), 'amountETH');
  rejectsField(() => requestSchemas.send({
    walletLabel: 'Primary', toAddress: CONTRACT, amountETH: -1, chain: 'ethereum',
  }, { supportedChains: CHAINS }), 'amountETH');
  rejectsField(() => requestSchemas.send({
    walletLabel: 'Primary', toAddress: CONTRACT, amountETH: LIMITS.priceEth + 1, chain: 'ethereum',
  }, { supportedChains: CHAINS }), 'amountETH');
  rejectsField(() => requestSchemas.send({
    walletLabel: 'Primary', toAddress: '0x1234', amountETH: 1, chain: 'ethereum',
  }, { supportedChains: CHAINS }), 'toAddress');
  rejectsField(() => requestSchemas.send({
    walletLabel: 'Primary', toAddress: CONTRACT, amountETH: 1, chain: 'solana',
  }, { supportedChains: CHAINS }), 'chain');
});

test('keystore export password must be at least 12 characters', () => {
  rejectsField(() => requestSchemas.walletExport({ securityPassword: 'short' }), 'securityPassword');
  rejectsField(() => requestSchemas.walletExport({}), 'securityPassword');
  assert.equal(requestSchemas.walletExport({ securityPassword: 'a-long-enough-password' }).securityPassword, 'a-long-enough-password');
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

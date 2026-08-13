const assert = require('node:assert/strict');
const test = require('node:test');
const { createBotCommandService } = require('../src/commands/botCommandService');
const { ValidationError } = require('../src/validation/domain');

function fixture() {
  const state = {
    wallets: [
      { userId: 'user-a', label: 'alpha', address: '0x0000000000000000000000000000000000000001', chain: 'ethereum' },
      { userId: 'user-b', label: 'beta', address: '0x0000000000000000000000000000000000000002', chain: 'ethereum' },
    ],
    tasks: [], activity: [], pnl: [], snipers: [],
  };
  const calls = [];
  const service = createBotCommandService({
    storage: {
      addWallet: async value => { calls.push(['addWallet', value]); return { ...value, id: 3 }; },
      deleteWallet: async (...args) => { calls.push(['deleteWallet', ...args]); return true; },
    },
    schedulerRepository: { cancel: async (...args) => { calls.push(['cancel', ...args]); return null; } },
    providerService: {}, governance: {}, adminCommands: {}, sniperService: {}, supportedChains: ['ethereum'],
    chains: { ethereum: { sym: 'ETH' } },
    encryptPrivateKey: value => { calls.push(['encrypt', value]); return { ciphertext: 'encrypted' }; },
    getState: () => state,
  });
  return { calls, service };
}

test('shared wallet commands cannot read or remove another Discord user wallet', async () => {
  const { calls, service } = fixture();
  assert.deepEqual(service.wallets('user-a').map(item => item.label), ['alpha']);
  await assert.rejects(service.removeWallet('user-a', 'beta'), ValidationError);
  assert.deepEqual(calls, []);
});

test('wallet creation generates a valid key server-side and returns only the public wallet details', async () => {
  const { calls, service } = fixture();
  const created = await service.createWallet('user-a', { label: 'generated', chain: 'ethereum' });
  assert.deepEqual(Object.keys(created).sort(), ['address', 'chain', 'label']);
  assert.match(created.address, /^0x[0-9A-Fa-f]{40}$/);
  const encryption = calls.find(call => call[0] === 'encrypt');
  assert.match(encryption[1], /^0x[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(created).includes(encryption[1]), false);
});

test('wallet import remains available through the separate fallback operation', async () => {
  const { calls, service } = fixture();
  const privateKey = `0x${'11'.repeat(32)}`;
  const imported = await service.importWallet('user-a', { label: 'imported', chain: 'ethereum', privateKey });
  assert.equal(imported.label, 'imported');
  assert.deepEqual(calls.find(call => call[0] === 'encrypt'), ['encrypt', privateKey]);
});

test('shared task controls always pass the resolved internal user ID to the repository', async () => {
  const { calls, service } = fixture();
  const id = '123e4567-e89b-42d3-a456-426614174000';
  await assert.rejects(service.controlTask('user-a', 'cancel', id), ValidationError);
  assert.deepEqual(calls, [['cancel', 'user-a', id]]);
});

const assert = require('node:assert/strict');
const test = require('node:test');

// The authenticated server profile is the chain authority for the dashboard, just as
// CONFIG.supportedChains is for Telegram. These tests prevent the browser bundle from reintroducing
// a second hardcoded allowlist that silently makes a configured EVM network bot-only.
test('dashboard accepts every EVM chain supplied by the authenticated server profile', async () => {
  const { dashboardEvmChains } = await import('../dashboard/src/chainOptions.mjs');
  assert.deepEqual(dashboardEvmChains(['ethereum', 'base', 'sepolia', 'future-evm']),
    ['ethereum', 'base', 'sepolia', 'future-evm']);
});

test('dashboard chain normalization removes duplicates and never enables Solana', async () => {
  const { dashboardEvmChains } = await import('../dashboard/src/chainOptions.mjs');
  assert.deepEqual(dashboardEvmChains([' Ethereum ', 'ethereum', '', null, 'solana', 'BASE']),
    ['ethereum', 'base']);
});

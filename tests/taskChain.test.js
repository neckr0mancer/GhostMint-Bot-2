const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = async () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'scheduler', 'taskChain.js')).href);
const serverSource = readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('a stored supported chain wins over the wallet home chain', async () => {
  const { resolveTaskChain } = await load();
  assert.deepEqual(resolveTaskChain({ chain: 'base' }, ['ethereum', 'base']), { chain: 'base' });
});

test('a missing or empty stored chain defers to the caller fallback (wallet home)', async () => {
  const { resolveTaskChain } = await load();
  assert.deepEqual(resolveTaskChain({}, ['ethereum']), { chain: null });
  assert.deepEqual(resolveTaskChain({ chain: null }, ['ethereum']), { chain: null });
  assert.deepEqual(resolveTaskChain({ chain: '   ' }, ['ethereum']), { chain: null });
  assert.deepEqual(resolveTaskChain(undefined, ['ethereum']), { chain: null });
});

test('stored values are matched case-insensitively and trimmed', async () => {
  const { resolveTaskChain } = await load();
  assert.deepEqual(resolveTaskChain({ chain: '  Base ' }, ['ethereum', 'base']), { chain: 'base' });
});

test('a stored chain this deployment no longer supports is an error, never a silent fallback', async () => {
  const { resolveTaskChain } = await load();
  const result = await (async () => resolveTaskChain({ chain: 'sepolia' }, ['ethereum', 'base']))();
  assert.equal(result.error, 'sepolia');
  assert.equal(result.chain, undefined);
});

test('executeTask resolves the task chain and never broadcasts on wallet.chain by default', () => {
  // Wiring pins: both call sites go through the shared resolver, and every execution surface
  // (OpenSea build, prepared intent, SeaDrop reads, request schema) carries the resolved chain.
  const occurrences = (serverSource.match(/resolveTaskChain\(task, ?CONFIG\.supportedChains\)/g) || []).length;
  assert.ok(occurrences >= 2, `executeTask and resolveStageStart must both use the resolver (found ${occurrences})`);
  assert.match(serverSource, /if \(resolvedChain\.error\)/);
  assert.doesNotMatch(serverSource, /buildMintTransaction\(wallet\.chain/);
  assert.doesNotMatch(serverSource, /chain: ?executionChain[\s\S]{0,400}?chain: ?wallet\.chain/, 'the mint request must carry the resolved chain');
});

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(
  pathToFileURL(path.join(__dirname, '..', 'dashboard', 'src', 'walletPerformance.js')).href);

const day = 86400000;
const record = (nm, over = {}) => ({ nm, cost: 0, sale: 0, gas: 0, net: 0, t: Date.now(), ...over });

// The whole point of this module is that it parses a string the SERVER writes. If autoRecordPnl's
// template changes, every per-wallet figure on the Wallets page silently drops to zero -- no error,
// no failing request, just numbers that quietly stop being true. This reads the real template out
// of server.js and checks the parser still understands it, so that drift fails here instead.
test('the parser still understands the name autoRecordPnl actually writes', async () => {
  const { pnlWalletLabel, pnlMintedQuantity } = await load();
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const template = /nm: `(Minted \$\{quantity\} NFT\$\{[^}]+\} .+?)`/.exec(source);
  assert.ok(template, 'autoRecordPnl no longer builds its name from a template literal -- if the '
    + 'shape changed, dashboard/src/walletPerformance.js must change with it');

  // Render that template the way the server would, for both the singular and plural branches.
  const render = (quantity, label) => template[1]
    .replace('${quantity}', String(quantity))
    .replace(/\$\{[^}]*quantity === 1[^}]*\}/, quantity === 1 ? '' : 's')
    .replace('${wallet.label}', label);

  assert.equal(pnlWalletLabel(record(render(14, 'Primary'))), 'Primary');
  assert.equal(pnlMintedQuantity(record(render(14, 'Primary'))), 14);
  assert.equal(pnlWalletLabel(record(render(1, 'Cold'))), 'Cold', 'the singular branch parses too');
  assert.equal(pnlMintedQuantity(record(render(1, 'Cold'))), 1);
});

test('a label containing its own em-dash is captured whole, not truncated at it', async () => {
  const { pnlWalletLabel } = await load();
  assert.equal(pnlWalletLabel(record('Minted 2 NFTs — cold — backup')), 'cold — backup');
});

test('records that are not auto-created attribute to no wallet', async () => {
  const { pnlWalletLabel, pnlMintedQuantity } = await load();
  assert.equal(pnlWalletLabel(record('bought a jpeg')), null,
    'a hand-added record has no wallet, and must not be guessed onto one');
  assert.equal(pnlMintedQuantity(record('bought a jpeg')), 0);
  assert.equal(pnlWalletLabel(null), null, 'and a missing record never throws');
  assert.equal(pnlWalletLabel(record('')), null);
});

test('performance sums only this wallet, only inside the window', async () => {
  const { walletPerformance } = await load();
  const records = [
    record('Minted 2 NFTs — Primary', { cost: 0.1, gas: 0.01, net: -0.11, t: Date.now() - 3 * day }),
    record('Minted 5 NFTs — Primary', { cost: 0.2, gas: 0.02, net: -0.22, t: Date.now() - 45 * day }),
    record('Minted 9 NFTs — Trading', { cost: 0.3, gas: 0.03, net: -0.33, t: Date.now() - day }),
  ];

  const week = walletPerformance(records, 'Primary', 7 * day);
  assert.equal(week.minted, 2, 'the 45-day-old row is outside a 7-day window');
  assert.equal(Number(week.cost.toFixed(6)), 0.1);
  assert.equal(Number(week.gas.toFixed(6)), 0.01);

  const quarter = walletPerformance(records, 'Primary', 90 * day);
  assert.equal(quarter.minted, 7, 'both Primary rows are inside 90 days');
  assert.equal(Number(quarter.cost.toFixed(6)), 0.3, "and Trading's cost is never mixed in");

  const all = walletPerformance(records, 'Primary', null);
  assert.equal(all.minted, 7, 'null means all time');

  assert.equal(walletPerformance(records, 'Nothing', 30 * day).minted, 0,
    'a wallet with no records is a real zero, not a missing value');
});

test('a records list that has not loaded is null, not a confident zero', async () => {
  const { walletPerformance } = await load();
  assert.equal(walletPerformance(null, 'Primary', 30 * day), null,
    'the card must be able to render an em-dash rather than claim 0.000000 it cannot know');
  assert.equal(walletPerformance(undefined, 'Primary', 30 * day), null);
});

test('net is summed as stored, so a recorded resale can carry a wallet positive', async () => {
  const { walletPerformance } = await load();
  // autoRecordPnl seeds net as -(cost + gas); entering a sale in Performance recomputes it as
  // sale - cost - gas, which is the only way a wallet's net goes above zero.
  const records = [
    record('Minted 14 NFTs — Primary', { cost: 0.712, sale: 1.241, gas: 0.131, net: 0.398 }),
  ];
  assert.equal(Number(walletPerformance(records, 'Primary', 30 * day).net.toFixed(6)), 0.398);
});

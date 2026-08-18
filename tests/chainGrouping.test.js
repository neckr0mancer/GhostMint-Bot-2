const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { CHAIN_DEFINITIONS } = require('../src/config');

// dashboard/src/shared.jsx hardcodes EVM_CHAINS as a plain array (it's bundled client-side by Vite,
// so it can't require() the server's config module directly). This test guards against that copy
// silently drifting from the server's actual chain universe: if a chain is ever added to or removed
// from CHAIN_DEFINITIONS without updating EVM_CHAINS, GroupedChainOptions would silently omit or
// misclassify it in every chain dropdown across the dashboard.
//
// The comparison is against the MAINNET chains only, not every key in CHAIN_DEFINITIONS. Sepolia
// lives in CHAIN_DEFINITIONS but is deliberately not user-selectable (commit 3ebaa62): it is kept
// solely so the Milestone 14 live acceptance run can opt into it temporarily, that run being the
// only feature requiring a chain flagged isTestnet. Asserting exact parity with every key would
// therefore demand the dashboard re-expose a chain the product deliberately withdrew. Keying off
// isTestnet keeps the drift guard intact for real chains while encoding that decision.
test('EVM_CHAINS in the dashboard bundle stays in sync with the server chain definitions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'src', 'shared.jsx'), 'utf8');
  const match = source.match(/EVM_CHAINS\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, 'shared.jsx must declare an EVM_CHAINS constant');
  const declared = match[1].split(',').map(entry => entry.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const canonical = Object.keys(CHAIN_DEFINITIONS).filter(name => !CHAIN_DEFINITIONS[name].isTestnet);
  assert.deepEqual([...declared].sort(), [...canonical].sort(),
    'EVM_CHAINS must list exactly the non-testnet chains in src/config\'s CHAIN_DEFINITIONS, or the ' +
    'grouped chain dropdown will silently omit a supported chain or misrepresent an unsupported one');
});

// The companion assertion, and the reason the one above can safely narrow to mainnets: nothing a
// user can select may be a testnet. If a testnet is ever meant to be selectable again, this is the
// test that should fail first and force that to be a deliberate decision rather than a drift.
test('no testnet chain is selectable from the dashboard chain dropdowns', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'src', 'shared.jsx'), 'utf8');
  const declared = source.match(/EVM_CHAINS\s*=\s*\[([^\]]*)\]/)[1]
    .split(',').map(entry => entry.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const testnets = declared.filter(name => CHAIN_DEFINITIONS[name]?.isTestnet);
  assert.deepEqual(testnets, [], 'EVM_CHAINS must not offer a testnet chain');
});

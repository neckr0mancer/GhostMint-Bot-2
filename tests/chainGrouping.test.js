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
test('EVM_CHAINS in the dashboard bundle stays in sync with the server chain definitions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'src', 'shared.jsx'), 'utf8');
  const match = source.match(/EVM_CHAINS\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, 'shared.jsx must declare an EVM_CHAINS constant');
  const declared = match[1].split(',').map(entry => entry.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const canonical = Object.keys(CHAIN_DEFINITIONS);
  assert.deepEqual([...declared].sort(), [...canonical].sort(),
    'EVM_CHAINS must list exactly the chains in src/config\'s CHAIN_DEFINITIONS, or the grouped ' +
    'chain dropdown will silently omit a supported chain or misrepresent an unsupported one');
});

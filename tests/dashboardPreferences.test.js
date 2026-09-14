const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'dashboard', 'src', 'App.jsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'dashboard', 'src', 'styles.css'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'dashboard', 'src', 'shared.jsx'), 'utf8');

test('default-chain migration accepts every currently supported EVM dashboard network', () => {
  const sql = fs.readFileSync(path.join(root, 'migrations',
    '058_dashboard_default_chain_supported_networks.sql'), 'utf8');
  assert.match(sql, /DROP CONSTRAINT IF EXISTS users_default_chain_check/);
  for (const chain of ['ethereum','base','arbitrum','polygon','ink','robinhood','hyperevm','sepolia']) {
    assert.match(sql, new RegExp(`'${chain}'`));
  }
});

test('low-balance warning is a persisted display preference, not a transaction limit', () => {
  const sql = fs.readFileSync(path.join(root, 'migrations',
    '059_wallet_low_balance_preference.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN low_balance_threshold_native/);
  assert.match(sql, /DEFAULT 0\.01/);
  assert.match(app, /PUT|method:'PUT'/);
  assert.match(app, /\/api\/profile\/low-balance-threshold/);
  assert.match(app, /This warning does not\s+change transaction limits or reserve funds/);
  const expansion = fs.readFileSync(path.join(root, 'migrations',
    '060_expand_wallet_low_balance_preferences.sql'), 'utf8');
  for (const threshold of ['0.0001','0.0005']) {
    assert.match(expansion, new RegExp(threshold.replace('.', '\\.')));
  }
});

test('wallet cards use the shared preferred-chain display helper', () => {
  assert.match(app, /selectWalletHeadlineBalance\(wallet,preferredChain\)/);
  assert.match(app, /walletFundingStatus\(wallet,\{preferredChain,lowThreshold\}\)/);
  assert.match(app, /if\(Number\(value\)===0\)return '0\.0'/,
    'known zero balances should stay distinct from unavailable while remaining compact');
});

test('saving a default chain refreshes the shared profile used by other forms', () => {
  assert.match(app, /function DefaultChainPanel\(\{profile,onProfileChange\}\)/);
  assert.match(app, /onProfileChange\?\.\(current=>\(\{\.\.\.current,defaultChain:saved\.defaultChain\}\)\)/);
  assert.match(app, /<DefaultChainPanel profile=\{profile\} onProfileChange=\{onProfileChange\}\/\>/);
  assert.match(app, /defaultChain=\{profile\.defaultChain\|\|DEFAULT_EVM_CHAIN\}/,
    'new and imported wallets should use the saved EVM home chain');
  assert.match(app, /chain:chain==='evm'\?defaultChain:chain/);
});

test('controlled mint and wallet-display selectors share the accessible themed listbox', () => {
  assert.match(shared, /export function SelectMenu/);
  assert.match(shared, /aria-controls=\{listId\}/);
  assert.match(shared, /aria-labelledby=\{`\$\{labelId\} \$\{valueId\}`\}/);
  assert.match(shared, /aria-activedescendant=/);
  for(const key of ['ArrowDown','ArrowUp','Home','End','Escape','Tab'])assert.match(shared,new RegExp(`'${key}'`));
  assert.match(shared, /option\.value!==selectedValue[\s\S]*onChange\?\./,
    're-selecting the current option must not repeat saves or invalidate a preview');
  assert.match(shared, /useMemo\(\(\)=>selectMenuOptions\(options,optional\),\[options,optional\]\)/,
    'keyboard movement must not be reset by rebuilding the option list on every child render');
  assert.match(shared, /if\(!selectionChanged&&open&&current>=0&&!normalized\[current\]\?\.disabled\)return current/,
    'an open menu must preserve its valid keyboard target across Schedule parent refreshes');
  assert.match(app, /<SelectMenu className="fl" label="Wallet" value=\{walletLabel\}/);
  assert.match(app, /<SelectMenu className="fl" label="Stage" value=\{selectedStageKey\}/);
  assert.match(app, /<SelectMenu className="fl" name="walletLabel" label="Wallet" value=\{scheduleWallet\}/,
    'Schedule must retain the named value submitted through FormData');
  assert.match(app, /<SelectMenu className="fl" label="Warn below" value=\{value\}/);
  assert.match(css, /\.select-menu-panel\{[^}]*overflow-y:auto;overflow-x:hidden/);
  assert.match(css, /\.select-menu-option\{[^}]*min-height:44px/);
  assert.match(css, /\.select-menu-option-copy small\{[^}]*overflow-wrap:anywhere/);
  assert.match(shared, /export function Select\([\s\S]*<select required=\{!optional\}/,
    'uncontrolled Admin forms keep native required validation until deliberately migrated');
});

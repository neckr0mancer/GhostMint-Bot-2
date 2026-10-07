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

test('display currency is persisted separately from native transaction amounts',()=>{
  const sql=fs.readFileSync(path.join(root,'migrations','068_user_display_currency.sql'),'utf8');
  assert.match(sql,/ADD COLUMN IF NOT EXISTS display_currency/);
  assert.match(sql,/DEFAULT 'USD'/);
  for(const currency of ['USD','NGN','EUR','GBP','CAD','AUD'])assert.match(sql,new RegExp(`'${currency}'`));
  assert.match(app,/\/api\/profile\/display-currency/);
  assert.match(app,/Display currency/);
});

test('time format is a persisted appearance preference shared by the dashboard',()=>{
  const sql=fs.readFileSync(path.join(root,'migrations','070_user_time_format.sql'),'utf8');
  assert.match(sql,/ADD COLUMN IF NOT EXISTS time_format/);
  assert.match(sql,/DEFAULT '24h'/);
  assert.match(sql,/time_format IN \('12h','24h'\)/);
  assert.match(app,/\/api\/profile\/time-format/);
  assert.match(app,/<TimeFormatProvider value=\{profile\.timeFormat\}>/);
});

test('Settings is organized into scoped tabs and hides global usage from non-owners',()=>{
  for(const id of ['appearance','transaction','gas','notifications','api-usage']){
    assert.match(app,new RegExp(`id:'${id}'`));
  }
  assert.match(app,/ownerOnly:true/);
  assert.match(app,/SETTINGS_TABS\.filter\(item=>!item\.ownerOnly\|\|profile\.isOwner\)/);
  assert.match(app,/target==='opensea-eligibility'\?'transaction':tab/);
  assert.match(app,/onOpenSettings=\{\(\)=>go\('Settings','transaction','opensea-eligibility'\)\}/);
  assert.match(app,/onClick=\{\(\)=>choose\(\(\)=>go\('Settings','transaction'\)\)\}[\s\S]*?Transaction mode/,
    'the account-menu shortcut must open the Transaction mode tab, not Appearance');
  assert.match(css,/\.settings-tab-panel\[hidden\]\{display:none\}/);
  for(const id of ['appearance','transaction','gas','notifications']){
    assert.match(app,new RegExp(`id="settings-panel-${id}"[\\s\\S]*?active==='${id}'&&<div`),
      'inactive Settings tab bodies must not mount or fire hidden requests');
  }
  assert.match(app,/id="settings-panel-api-usage"[\s\S]*?active==='api-usage'&&<>/);
});

test('shared Settings tabs expose keyboard and panel relationships',()=>{
  assert.match(shared,/function SubTabs\([\s\S]*ArrowRight:[\s\S]*ArrowLeft:/);
  assert.match(shared,/event\.key==='Home'/);
  assert.match(shared,/event\.key==='End'/);
  assert.match(shared,/row\.scrollWidth<=row\.clientWidth[\s\S]*row\.scrollLeft/,
    'the active tab must remain visible when the shared tab row overflows on narrow screens');
  assert.match(shared,/aria-controls=\{idPrefix\?/);
  assert.match(app,/idPrefix="settings"/);
  assert.match(app,/id="settings-panel-appearance" aria-labelledby="settings-tab-appearance"/);
});

test('Settings card rows align and shared register rows keep prototype gutters',()=>{
  assert.match(css,/\.settings-layout\{[^}]*align-items:stretch/);
  assert.match(css,/\.ledger-row\{[^}]*padding:var\(--row-pad\) 13px/);
  assert.match(css,/\.ledger-row\{grid-template-columns:52% minmax\(0,1fr\);padding:6px 11px\}/);
  assert.match(css,/\.admin-compact-list>div\{[^}]*padding:\.7rem 13px/);
  assert.match(css,/\.admin-detail-list>div\{[^}]*padding:0 13px \.45rem/);
  assert.match(css,/@media\(max-width:900px\)\{[\s\S]*?\.settings-layout[^}]*grid-template-columns:minmax\(0,1fr\)/,
    'Settings must collapse before the 768px layout can overflow');
  assert.match(css,/\.theme-option\.theme-primary-option\{display:grid;[^}]*justify-content:stretch\}/,
    'the later shared theme-option rule must not turn primary previews back into overflowing flex rows');
  assert.match(css,/@media\(max-width:700px\)\{[\s\S]*?\.settings-layout,\.settings-usage-tables,[\s\S]*?grid-template-columns:minmax\(0,1fr\)/,
    'the later phone rule must preserve a shrinkable Settings column');
});

test('Appearance, transaction effects, and API usage match the complete Settings prototype states',()=>{
  assert.match(app,/className="theme-primary-grid" role="group"/);
  assert.match(app,/className="settings-theme-label">More styles · optional/);
  assert.doesNotMatch(app,/<details className="settings-more-themes"/);
  assert.match(app,/<div className="rt">Sidebar<\/div>/);
  assert.match(app,/<span className="p nu">Remembered<\/span>/);
  assert.match(app,/{label:'Max transaction'/);
  assert.match(app,/total=\{\{label:'Daily budget'/);
  assert.match(app,/onClick=\{\(\)=>choose\(selected\.key\)\}/,
    'mode cards preview; the explicit action performs the consequential save');
  assert.match(app,/No adapter requests yet/);
  assert.match(app,/onCreateRule=\{\(\)=>go\?\.\('Automation','social'\)\}/);
});

test('Settings loading and wallet permission controls expose accessible state without oversized visuals',()=>{
  assert.match(app,/settings-mode-skeleton/);
  assert.match(app,/settings-gas-skeleton/);
  assert.match(app,/aria-label="Loading gas prices"/);
  assert.match(app,/prefers-reduced-motion: reduce/);
  assert.match(app,/className=\{entry\?\.error\?'is-error':''\} aria-live="polite"/);
  assert.match(css,/\.schedule-switch\{[^}]*width:44px;height:44px;min-height:44px/);
  assert.match(css,/\.schedule-switch::before\{[^}]*width:40px;height:24px/,
    'the hit target grows to 44px while the visible switch remains compact');
});

test('Settings writes keep the previous choice and expose retryable inline failures',()=>{
  for(const copy of [
    'Could not save the password gate.',
    'Could not save the minting prompt.',
    'Could not change the transaction mode.',
    'Could not reset the transaction mode.',
    'Could not save the default copy timing.',
  ])assert.ok(app.includes(copy),copy);
  assert.match(app,/function settingsSaveError\(title,error,onRetry\)/);
  assert.match(app,/detail:'Your previous choice is still active\.'/);
  assert.match(app,/setSkipMint\(previous\)/);
  assert.match(app,/setLevel\(previous\)/);
  assert.match(app,/<Notice error=\{saveError\}\/>/);
});

test('Settings data loads ignore stale responses and Gas distinguishes configuration from outages',()=>{
  assert.match(shared,/const requestId=useRef\(0\)/);
  assert.match(shared,/if\(activeRequest===requestId\.current\)setData\(value\)/);
  assert.match(shared,/return\(\)=>\{requestId\.current\+=1;\}/,
    'a superseded or unmounted loader must invalidate its in-flight request');
  assert.match(app,/function GasPanel\([\s\S]*const requestId=useRef\(0\)/);
  assert.match(app,/reason\.code==='MISSING_API_KEY'/);
  assert.ok(app.includes('Could not load gas prices.'));
  assert.match(app,/onRetry:\(\)=>load\(next\)/);
  assert.match(app,/disabled=\{loading\}/,
    'only the chain selector involved in the request is locked while Gas refreshes');
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
  assert.match(shared, /aria-labelledby=\{`\$\{labelId\} \$\{valueId\}\$\{selected\?\.tag\?` \$\{tagId\}`:''\}`\}/,
    'the selected option tag must be part of the trigger accessible name');
  assert.match(shared, /aria-activedescendant=/);
  assert.match(shared, /data-option-tone=\{selected\?\.tone\|\|undefined\}/,
    'the selected value must expose its state for stage-specific status styling');
  assert.match(shared, /data-option-tone=\{option\.tone\|\|undefined\}/,
    'each menu option must expose its own state without relying on brittle label text');
  assert.match(shared,/selected\?\.inlineStatus/);
  assert.match(shared,/option\.inlineStatus/,
    'the shared selector must support an inline status beside an option name without replacing its right-side tag');
  for(const key of ['ArrowDown','ArrowUp','Home','End','Escape','Tab'])assert.match(shared,new RegExp(`'${key}'`));
  assert.match(shared, /option\.value!==selectedValue[\s\S]*onChange\?\./,
    're-selecting the current option must not repeat saves or invalidate a preview');
  assert.match(shared, /useMemo\(\(\)=>selectMenuOptions\(options,optional\),\[options,optional\]\)/,
    'keyboard movement must not be reset by rebuilding the option list on every child render');
  assert.match(shared, /if\(!selectionChanged&&open&&current>=0&&!normalized\[current\]\?\.disabled\)return current/,
    'an open menu must preserve its valid keyboard target across Schedule parent refreshes');
  assert.match(app, /<SelectMenu className="fl" label="Wallet" value=\{walletLabel\}/);
  assert.match(app, /<SelectMenu label="Mint stage" value=\{selectedStageKey\}/);
  assert.match(app, /<SelectMenu className="fl" name="walletLabel" label="Wallet" value=\{scheduleWallet\}/,
    'Schedule must retain the named value submitted through FormData');
  assert.match(app, /<SelectMenu className="fl" label="Warn below" value=\{value\}/);
  assert.match(css, /\.select-menu-panel\{[^}]*overflow-y:auto;overflow-x:hidden/);
  assert.match(css, /\.select-menu-option\{[^}]*min-height:44px/);
  assert.match(css, /\.select-menu-option-copy small\{[^}]*overflow-wrap:anywhere/);
  assert.match(shared, /export function Select\([\s\S]*<select required=\{!optional\}/,
    'uncontrolled Admin forms keep native required validation until deliberately migrated');
});

test('theme changes apply locally first and synchronize after connectivity returns',()=>{
  assert.match(app,/resolveDashboardTheme\(profile\.userId,profile\.theme\)/);
  assert.match(app,/savePendingTheme\(profile\.userId,next\)/);
  assert.match(app,/window\.addEventListener\('online',onOnline\)/);
  assert.match(app,/event\.detail\?\.type==='ws\.reconnected'/);
  assert.doesNotMatch(app,/catch\{setTheme\(previous\);\}/,
    'an offline save failure must not undo the theme the user just selected');
});

test('OpenSea eligibility is a durable per-wallet Settings permission',()=>{
  assert.match(app,/function OpenSeaEligibilitySettingsPanel\(\{focus=false\}\)/);
  assert.match(app,/id="opensea-eligibility-settings"/);
  assert.match(app,/wallets\.data\.map\(wallet=>/,
    'one account-level switch must not silently authorize every wallet');
  assert.match(app,/Automatic OpenSea eligibility checks for \{wallet\.label\}/);
  assert.match(app,/disabled=\{changing\|\|!entry\|\|entry\.loading\|\|unavailable\}/);
  assert.match(app,/entry\?\.error&&<button[^>]+onClick=\{\(\)=>reloadWallet\(wallet\)\}>Retry<\/button>/,
    'an individual wallet status read must remain retryable');
  assert.match(app,/ghostmint-opensea-eligibility-changed/,
    'a changed Settings permission must invalidate the mounted Schedule workspace');
});

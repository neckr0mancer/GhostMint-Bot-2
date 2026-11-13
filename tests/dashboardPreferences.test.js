const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'dashboard', 'src', 'App.jsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'dashboard', 'src', 'styles.css'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'dashboard', 'src', 'shared.jsx'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'dashboard', 'src', 'Admin.jsx'), 'utf8');
const dashboardApi = fs.readFileSync(path.join(root, 'src', 'dashboard', 'api.js'), 'utf8');

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

test('account preference events refetch the shared profile in every open dashboard session',()=>{
  const root=app.slice(app.indexOf('export default function App'));
  assert.match(root,/\['identity\.changed','profile\.changed','ws\.reconnected'\]\.includes\(event\.detail\?\.type\)/);
  assert.match(root,/const value=await api\('\/api\/profile'\)/);
  assert.match(root,/loadProfile\(\)/);
  assert.match(root,/profileRequestId=useRef\(0\)/);
  assert.match(root,/if\(active!==profileRequestId\.current\)return/);
  assert.match(root,/if\(error\.status===401\)[\s\S]*?setProfile\(null\)/,
    'only an authentication failure may turn a profile refresh into the signed-out screen');
  assert.match(root,/else setProfileError\(error\)/,
    'transport and server failures must remain retryable without claiming the session ended');
});

test('governance changes refresh mode presets and selected-chain limits in open dashboards',()=>{
  const modeLoads=[...app.matchAll(/useLoad\('\/api\/mode-presets',\[\],\['profile\.changed','admin\.changed'\]\)/g)];
  assert.equal(modeLoads.length,2,'both the account mode selector and Settings must refresh');
  assert.match(app,/useLoad\(limitsPath,\[limitChain\],\['profile\.changed','admin\.changed'\]\)/);
});

test('transaction-mode copy distinguishes automated safeguards from manual mint approval',()=>{
  assert.match(app,/ordinary Mint flow&apos;s final approval/);
  assert.match(app,/\/mintnow<\/code> remains an explicit one-shot no-confirmation shortcut/);
  assert.match(app,/Automation verification default/);
  assert.match(app,/Target opt-in required/);
  assert.doesNotMatch(app,/skips the human approval prompt/);
});

test('an open target policy refetches after Telegram, Discord, or another dashboard changes it',()=>{
  assert.match(app,/function PolicyEditor[\s\S]*?useLoad\(\`\/api\/targets\/\$\{target\.id\}\?type=\$\{target\.type\}\`,\[target\.id,target\.type\],[\s\S]*?'policies\.changed'\)/);
  assert.match(app,/const policyFormKey=value\?\[/);
  assert.match(app,/<form key=\{policyFormKey\} onSubmit=\{update\}>/);
});

test('live account settings and confirmations reconcile after remote writes or reconnects',()=>{
  assert.match(app,/if\(!saving\)setLevel\(profile\.botGateLevel\|\|'off'\)/);
  assert.match(app,/if\(!savingMint\)setSkipMint\(Boolean\(profile\.botGateSkipMint\)\)/);
  assert.match(app,/message\.type==='ws\.reconnected'\|\|message\.type==='confirmations\.changed'/);
});

test('notification bell invalidates stale confirmation loads when live payloads arrive',()=>{
  const bell=app.slice(app.indexOf('function NotificationBell()'),app.indexOf('function SearchOverlay'));
  assert.match(bell,/loadRequestId=useRef\(0\)/);
  assert.match(bell,/requestId===loadRequestId\.current\)setItems\(value\)/);
  assert.match(bell,/message\.type==='confirmation\.pending'\)\{loadRequestId\.current\+=1/);
  assert.match(bell,/message\.type==='confirmation\.resolved'\)\{loadRequestId\.current\+=1/);
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
    assert.match(app,new RegExp(`id="settings-panel-${id}"[\\s\\S]*?active==='${id}'&&<(?:fieldset|div)`),
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
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{[\s\S]*?\.skeleton-card[\s\S]*?animation:none/);
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
  assert.match(shared,/if\(activeRequest===requestId\.current\)\{setData\(value\);setDataPath\(path\);setResolvedPath\(path\);\}/,
    'only the newest request may publish its data and the path that produced it');
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
  assert.match(app, /function DefaultChainPanel\(\{profile,onProfileChange,onBusyChange\}\)/);
  assert.match(app, /onProfileChange\?\.\(current=>\(\{\.\.\.current,defaultChain:saved\.defaultChain\}\)\)/);
  assert.match(app, /<DefaultChainPanel profile=\{profile\} onProfileChange=\{onProfileChange\} onBusyChange=\{setBusySource\}\/\>/);
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
  assert.match(app,/function OpenSeaEligibilitySettingsPanel\(\{focus=false,onBusyChange\}\)/);
  assert.match(app,/id="opensea-eligibility-settings"/);
  assert.match(app,/wallets\.data\.map\(wallet=>/,
    'one account-level switch must not silently authorize every wallet');
  assert.match(app,/Automatic OpenSea eligibility checks for \{wallet\.label\}/);
  assert.match(app,/disabled=\{changing\|\|!entry\|\|entry\.loading\|\|Boolean\(entry\.error\)\|\|unavailable\}/);
  assert.match(app,/entry\?\.error&&<button[^>]+onClick=\{\(\)=>reloadWallet\(wallet\)\}>Retry<\/button>/,
    'an individual wallet status read must remain retryable');
  assert.match(app,/ghostmint-opensea-eligibility-changed/,
    'a changed Settings permission must invalidate the mounted Schedule workspace');
  assert.match(dashboardApi,/authorizeOpenSeaEligibility:[\s\S]*?changed\(req,'wallets'\)/,
    'authorizing a wallet must invalidate eligibility state in every open dashboard session');
  assert.match(dashboardApi,/revokeOpenSeaEligibility:[\s\S]*?changed\(req,'wallets'\)/,
    'revoking a wallet must invalidate eligibility state in every open dashboard session');
});

test('Settings locks its participating controls and tab exits during consequential saves',()=>{
  assert.match(app,/const settingsBusy=Object\.keys\(busySources\)\.length>0/);
  assert.match(app,/<SubTabs[^>]+disabled=\{settingsBusy\}/);
  assert.match(app,/className="settings-tab-lock settings-layout" disabled=\{settingsBusy\}/);
  assert.match(app,/onBusyChange=\{setBusySource\}/);
  assert.match(app,/const busy=saving\|\|savingMint/);
  assert.match(app,/aria-checked=\{level===option\.value\} disabled=\{busy\|\|/,
    'bot security writes must not overlap each other');
  assert.match(css,/\.settings-tab-lock\{border:0;padding:0;margin:0;min-width:0\}/);
});

test('usage and transaction limits never relabel stale data as the newly selected scope',()=>{
  assert.match(app,/const currentLimits=limits\.dataPath===limitsPath\?limits\.data:null/);
  assert.match(app,/limitsUnavailable=limits\.resolvedPath===limitsPath&&Boolean\(limits\.error\)/);
  assert.match(app,/limitsUnavailable\?'Unavailable':'Loading…'/);
  assert.match(app,/modeLimitLabel\(currentLimits\.maxTransactionValueWei,currentLimits\.ceilingExempt,limitSymbol\)/,
    'limits must use the selected chain native symbol rather than hard-coded ETH');
  assert.match(app,/const data=usage\.dataPath===usagePath\?usage\.data:null/);
  assert.match(app,/const loading=usage\.resolvedPath!==usagePath&&!usage\.error/);
});

test('notification routing keeps only Money, Automation, and Security in Recent',()=>{
  assert.match(shared,/export function shouldRetainNotification\(category\)/);
  assert.match(shared,/if\(shouldRetainNotification\(category\)\)\{[\s\S]*?notificationLog=/);
  assert.match(app,/\['System','Connection and sync status','Toast only','nu'\]/);
  assert.match(app,/\['Interface','Copied, saved, and form feedback','Toast only','nu'\]/);
  assert.match(admin,/category:'security'/,
    'owner actions promised by the routing table must be categorised for retention');
});

test('shared confirmation dialogs trap focus, restore focus, and make the background inert',()=>{
  const host=shared.slice(shared.indexOf('export function ConfirmHost'),shared.indexOf('// Toast notifications'));
  assert.match(host,/previouslyFocused=document\.activeElement/);
  assert.match(host,/element\.inert=true/);
  assert.match(host,/event\.key==='Tab'/);
  assert.match(host,/cancelRef\.current\)\?\.focus/);
  assert.match(host,/previouslyFocused\.focus/);
  assert.match(host,/aria-modal="true" aria-describedby=/);
});

test('clock preference reaches the owner Security Log instead of rendering fixed ISO time',()=>{
  const security=app.slice(app.indexOf('function SecurityLogTab'),app.indexOf('function MintHistory'));
  assert.match(security,/const formatDateTime=useDateTimeFormatter\(\)/);
  assert.match(security,/formatDateTime\(when,\{seconds:true\}\)/);
  assert.doesNotMatch(security,/iso\.slice\(11,19\)/);
});

test('profile outages have a retry surface and are not described as expired sessions',()=>{
  assert.match(app,/function ProfileLoadFailure/);
  assert.match(app,/Dashboard temporarily unavailable/);
  assert.match(app,/Your session has not been treated as signed out/);
  assert.match(app,/onRetry=\{\(\)=>loadProfile\(\{showLoading:true\}\)\}/);
});

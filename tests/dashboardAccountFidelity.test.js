const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'dashboard','src','App.jsx'),'utf8');
const styles=fs.readFileSync(path.join(root,'dashboard','src','styles.css'),'utf8');
const prototype=fs.readFileSync(path.join(root,'docs','prototype-pages','account.html'),'utf8');

function accountSource(){
  const start=app.indexOf('const ACCOUNT_TABS=');
  const end=app.indexOf('const SUN_ICON=',start);
  assert.notEqual(start,-1,'Account tab implementation must exist');
  assert.notEqual(end,-1,'Account implementation must remain independently inspectable');
  return app.slice(start,end);
}

test('Account is split into the four prototype sections and keeps the tab in dashboard routing',()=>{
  const source=accountSource();
  for(const id of ['identity','security','linked','sessions']){
    assert.match(source,new RegExp(`id:'${id}'`));
    assert.match(source,new RegExp(`active==='${id}'`));
  }
  assert.match(source,/SubTabs tabs=\{ACCOUNT_TABS\} active=\{active\} onChange=\{onTab\} label="Account sections" disabled=\{accountBusy\}/);
  assert.match(app,/<View profile=\{viewProfile\} go=\{go\} tab=\{tab\}[^>]+onTab=\{next=>go\(page,next\)\}/);
});

test('Account reuses the shell profile and preserves all existing identity and session actions',()=>{
  const source=accountSource();
  assert.doesNotMatch(source,/api\('\/api\/profile'\)/,'Account must not duplicate the shell profile fetch');
  assert.match(source,/api\('\/api\/profile\/display-name'/);
  assert.match(source,/promptSetUsername/);
  assert.match(source,/promptSetSecurityPassword/);
  assert.match(source,/api\('\/api\/auth\/link-code'/);
  assert.match(source,/linking\?'Refresh code':'Generate link code'/);
  assert.match(source,/onLogout\(\{all:true\}\)/);
  assert.match(source,/Log out everywhere/);
  assert.match(source,/session\.activeCount/);
  assert.match(source,/session\?\.clientLabel/);
});

test('transaction mode and default chain point to Settings instead of duplicating controls',()=>{
  const source=accountSource();
  assert.match(source,/Settings → Transaction mode/);
  assert.match(source,/go\?\.\('Settings','gas'\)/);
  assert.match(source,/go\?\.\('Settings','transaction'\)/);
  assert.doesNotMatch(source,/api\('\/api\/profile\/mode'/);
  assert.doesNotMatch(source,/api\('\/api\/profile\/default-chain'/);
});

test('Account uses responsive, theme-token-based layout rules',()=>{
  assert.match(styles,/\.account-readonly-field\{display:grid/);
  assert.match(styles,/@media\(max-width:700px\)[\s\S]*\.account-readonly-field\{grid-template-columns:1fr auto\}/);
  assert.match(styles,/\.account-client-label\{[^}]+var\(--surface-2\)/);
  assert.match(styles,/\.account-tab-panel \.card>p\{[^}]+var\(--text-muted\)/);
});

test('the Account prototype records the newer authenticated-dashboard code generator rule',()=>{
  assert.match(prototype,/authenticated dashboard can <b>generate<\/b> a five-minute, single-use link code/);
  assert.match(prototype,/>Generate link code<\/button>/);
  assert.doesNotMatch(prototype,/Only Telegram can <b>generate<\/b>/);
});

test('Account consequential controls lock their complete surface and always release through finally',()=>{
  const source=accountSource();
  assert.match(source,/const accountBusy=profileBusy\|\|Boolean\(credentialBusy\)\|\|linkBusy\|\|Boolean\(sessionBusy\);/);
  assert.match(source,/useEffect\(\(\)=>\{onBusyChange\?\.\(accountBusy\);\},\[accountBusy,onBusyChange\]\);/);
  assert.match(source,/useEffect\(\(\)=>\(\)=>onBusyChange\?\.\(false\),\[onBusyChange\]\);/);
  assert.match(source,/account-profile-form" aria-busy=\{\(profileBusy\|\|Boolean\(credentialBusy\)\)\|\|undefined\}/);
  assert.match(source,/<fieldset disabled=\{profileBusy\|\|Boolean\(credentialBusy\)\}>/);
  assert.match(source,/className="card" aria-busy=\{Boolean\(credentialBusy\)\|\|undefined\}[\s\S]*?<fieldset disabled=\{Boolean\(credentialBusy\)\}>/);
  assert.match(source,/account-link-card" aria-busy=\{linkBusy\|\|undefined\}[\s\S]*?<fieldset disabled=\{linkBusy\}>/);
  assert.match(source,/account-session-actions" aria-busy=\{Boolean\(sessionBusy\)\|\|undefined\}[\s\S]*?<fieldset disabled=\{Boolean\(sessionBusy\)\}>/);
  assert.match(source,/async function runCredential[\s\S]*?finally\{setCredentialBusy\(''\);\}/);
  assert.match(source,/async function logoutCurrent[\s\S]*?finally\{setSessionBusy\(''\);\}/);
  assert.match(source,/async function logoutEverywhere[\s\S]*?finally\{setSessionBusy\(''\);\}/);
  assert.match(app,/const \[accountBusy,setAccountBusy\]=useState\(false\)/);
  assert.match(app,/onBusyChange=\{page==='Account'\?setAccountBusy:undefined\}/);
  assert.match(app,/function go\(item,nextTab=null,nextTarget=null\)\{\s*if\(accountBusy\)return;/);
  assert.match(app,/className=\{`app\$\{moreOpen\?' more-open':''\}`\} data-m=\{mobile\?'':undefined\} aria-busy=\{accountBusy\|\|undefined\}/);
  assert.match(app,/className="cmdk" disabled=\{accountBusy\}/);
  assert.match(app,/if\(!accountBusy\)setPaletteOpen\(value=>!value\)/);
  assert.match(app,/<AccountMenu[\s\S]*?disabled=\{accountBusy\}\/>/);
  assert.match(app,/<BottomBar[\s\S]*?disabled=\{accountBusy\}\/>/);
  assert.match(app,/<MoreSheet[\s\S]*?disabled=\{accountBusy\}\/>/);
  assert.match(app,/<CommandPalette open=\{!accountBusy&&paletteOpen\}/);
  assert.match(app,/<NavList items=\{PAGES\} page=\{page\} go=\{go\} disabled=\{accountBusy\}\/>/);
  assert.match(app,/TOP_RAIL_PAGES\.map[\s\S]*?<button type="button" className="nav" key=\{item\}[\s\S]*?disabled=\{accountBusy\}/);
});

test('refreshing, consuming, or expiring a link code cannot leave a stale code copyable',()=>{
  const source=accountSource();
  assert.match(source,/const refreshing=Boolean\(linking\);[\s\S]*?setLinking\(null\);[\s\S]*?api\('\/api\/auth\/link-code'/);
  assert.match(source,/The previous code is hidden because its validity cannot be confirmed/);
  assert.match(source,/event\.detail\?\.type!==['"]identity\.changed['"][\s\S]*?setLinking\(null\)/);
  assert.doesNotMatch(source,/link-code-result" aria-live="polite"/,'the changing countdown must not be one live region');
  assert.doesNotMatch(source,/className="sr-only"/,'Account must not depend on a visually-hidden utility that the app does not define');
  assert.match(source,/const linkExpired=Boolean\(linking\)&&remaining===0;/);
  assert.match(source,/if\(now>=expiresAt\)clearInterval\(timer\)/);
  const expiryBranchStart=source.indexOf('{linking&&(linkExpired');
  const usableBranchStart=source.indexOf(':<div className="link-code-result">',expiryBranchStart);
  assert.notEqual(expiryBranchStart,-1,'link code rendering must branch on expiry');
  assert.notEqual(usableBranchStart,-1,'a non-expired code branch must remain');
  const expiredBranch=source.slice(expiryBranchStart,usableBranchStart);
  assert.match(expiredBranch,/role="status"><strong>Link code expired<\/strong>/);
  assert.match(expiredBranch,/This code can no longer be used or copied\. Refresh to generate a new code\./);
  assert.doesNotMatch(expiredBranch,/CopyButton/,'an expired code must not retain a copy action');
  const usableBranch=source.slice(usableBranchStart,source.indexOf('</fieldset>',usableBranchStart));
  assert.match(usableBranch,/<strong role="status"[^>]+>\{linking\.code\}<\/strong>/,'the stable code itself announces generation once');
  assert.match(usableBranch,/<CopyButton value=\{linking\.code\} label="Copy link code"\/>/);
});

test('linked-account labels and cross-platform instructions state only facts the API returns',()=>{
  const source=accountSource();
  assert.doesNotMatch(source,/First linked/,'platform sorting is not evidence of which identity linked first');
  assert.match(source,/enter it with <b>\/link<\/b> on the Discord account/);
  assert.match(source,/Telegram generates its own link code and does not accept a code generated here/);
});

test('a failed logout keeps the authenticated UI and reports the failure',()=>{
  const start=app.indexOf('async function logout(request)');
  const end=app.indexOf('function login(value)',start);
  assert.notEqual(start,-1);
  assert.notEqual(end,-1);
  const source=app.slice(start,end);
  assert.match(source,/catch\{notify\('Could not log out\. Your session is still active; try again\.',\{type:'error'\}\);return false;\}/);
  assert.match(source,/setProfile\(null\);return true;/);
  assert.doesNotMatch(source,/finally/,'logout failure must not share the successful local sign-out path');
});

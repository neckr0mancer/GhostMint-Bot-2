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
  assert.match(source,/SubTabs tabs=\{ACCOUNT_TABS\} active=\{active\} onChange=\{onTab\}/);
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
  assert.match(source,/onClick=\{\(\)=>go\?\.\('Settings'\)\}/);
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

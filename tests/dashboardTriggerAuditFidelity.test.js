const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const app=fs.readFileSync(path.join(__dirname,'..','dashboard','src','App.jsx'),'utf8');

function triggerAuditSource(){
  const start=app.indexOf('const TRIGGER_AUDIT_PAGE_SIZE=');
  const end=app.indexOf('function MintHistory()',start);
  assert.notEqual(start,-1,'Trigger Audit implementation must exist');
  assert.notEqual(end,-1,'Trigger Audit must remain independently inspectable');
  return app.slice(start,end);
}

test('History routes Audit evidence to the authenticated read-only Trigger Audit ledger',()=>{
  const historyStart=app.indexOf('function History({profile,tab,onTab,go})');
  const historyEnd=app.indexOf('/* ==========================================================================\n   Command palette',historyStart);
  assert.notEqual(historyStart,-1);
  assert.notEqual(historyEnd,-1);
  const history=app.slice(historyStart,historyEnd);
  assert.match(history,/\{id:'audit',label:'Audit evidence'\}/);
  assert.match(history,/active==='audit'&&<TriggerAudit\/>/);
  assert.doesNotMatch(history,/Trigger audit is available from Telegram and Discord/,
    'the routed dashboard ledger must replace the old unavailable placeholder');
});

test('Trigger Audit binds search and paging to one encoded GET path and rejects stale responses',()=>{
  const source=triggerAuditSource();
  assert.match(source,/const TRIGGER_AUDIT_PAGE_SIZE=10/);
  assert.match(source,/\/api\/history\/trigger-audit\?page=\$\{page\}&pageSize=\$\{TRIGGER_AUDIT_PAGE_SIZE\}&search=\$\{encodeURIComponent\(search\)\}/);
  assert.match(source,/useLoad\(path,\[page,search\],ACTIVITY_EVENTS\)/);
  assert.match(source,/listing\.dataPath===path\?listing\.data:null/);
  assert.match(source,/listing\.resolvedPath===path\?listing\.error:''/);
  assert.match(source,/<SearchField label="Search audit evidence" value=\{search\}/);
  assert.match(source,/onChange=\{value=>\{setSearch\(value\);setPage\(1\);\}\}/);
  assert.match(source,/const resultsRef=useRef\(null\)/);
  assert.match(source,/setTimeout\(\(\)=>resultsRef\.current\?\.focus\(\{preventScroll:true\}\),0\)/);
  assert.match(source,/className="trigger-audit-results" tabIndex=\{-1\} aria-live="polite"/);
});

test('Trigger Audit has explicit loading, retryable error, and distinct empty states',()=>{
  const source=triggerAuditSource();
  assert.match(source,/aria-busy=\{loading\|\|undefined\}/);
  assert.match(source,/loading\?<div className="card history-list-state"><Skeleton variant="row" rows=\{4\}\/>/);
  assert.match(source,/title:'Could not load audit evidence\.'/);
  assert.match(source,/this read-only record could not be loaded\./);
  assert.match(source,/onRetry:\(\)=>\{listing\.load\(\);focusResults\(\);\}/);
  assert.match(source,/<Empty text=\{search/);
  assert.match(source,/No audit evidence matches this search\./);
  assert.match(source,/No trigger evidence yet\./);
  assert.match(source,/Try another source, target, or transaction hash\./);
  assert.match(source,/Automation attempts with verification on or bypassed will appear here after they execute\./);
});

test('populated Trigger Audit rows preserve evidence, verification, outcome, time, hash, and paging',()=>{
  const source=triggerAuditSource();
  for(const field of ['auditId','triggerSource','sourceEventId','targetType','targetId',
    'verificationState','confirmationShown','outcome','transactionHash','executedAt']){
    assert.match(source,new RegExp(`triggerAuditField\\(row,'${field}'`),
      `${field} must remain visible or drive row identity`);
  }
  assert.match(source,/verification==='on'\?'Verification on'/);
  assert.match(source,/verification==='bypassed'\?'Verification bypassed'/);
  assert.match(source,/\{confirmationShown&&<span>User confirmed<\/span>\}/);
  assert.match(source,/<time dateTime=\{validTime\?when\.toISOString\(\):undefined\}>\{timestamp\}<\/time>/);
  assert.match(source,/<CopyButton value=\{txHash\} label="Copy transaction hash"\/>/);
  assert.match(source,/outcomeTone\(outcome\)/);
  assert.match(source,/<HistoryPager value=\{data\} page=\{page\} setPage=\{changePage\} visibleCount=\{rows\.length\}\/>/);
});

test('Trigger Audit is read-only apart from local filtering, copying, and navigation',()=>{
  const source=triggerAuditSource();
  assert.doesNotMatch(source,/\bapi\(/,'the ledger must not call a mutating API');
  assert.doesNotMatch(source,/method\s*:/,'the ledger must not issue POST, PUT, PATCH, or DELETE requests');
  assert.doesNotMatch(source,/<form\b|type="submit"|ConfirmHost|confirmAction/,
    'an immutable audit ledger must not expose a mutation form');
  assert.match(source,/<SearchField /);
  assert.match(source,/<CopyButton value=\{txHash\}/);
  assert.match(source,/target="_blank" rel="noopener noreferrer"/);
});

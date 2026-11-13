const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'dashboard','src','App.jsx'),'utf8');
const styles=fs.readFileSync(path.join(root,'dashboard','src','styles.css'),'utf8');

function between(source,start,end){
  const from=source.indexOf(start);
  const to=source.indexOf(end,from);
  assert.notEqual(from,-1,`${start} must exist`);
  assert.notEqual(to,-1,`${end} must follow ${start}`);
  return source.slice(from,to);
}

test('History renders immutable trigger audit evidence through the tenant-scoped read route',()=>{
  const audit=between(app,'function TriggerAudit(){','function MintHistory(){');
  assert.match(app,/active==='audit'&&<TriggerAudit\/>/);
  assert.match(audit,/\/api\/history\/trigger-audit\?page=\$\{page\}&pageSize=\$\{TRIGGER_AUDIT_PAGE_SIZE\}&search=\$\{encodeURIComponent\(search\)\}/);
  assert.match(audit,/listing\.dataPath===path\?listing\.data:null/);
  assert.match(audit,/listing\.resolvedPath===path\?listing\.error:''/);
  assert.doesNotMatch(audit,/api\(|method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/,
    'audit evidence must remain read-only');
});

test('Trigger Audit has complete loading, retryable error, empty, populated, search, and pager states',()=>{
  const audit=between(app,'function TriggerAudit(){','function MintHistory(){');
  assert.match(audit,/aria-busy=\{loading\|\|undefined\}/);
  assert.match(audit,/<Skeleton variant="row" rows=\{4\}\/\>/);
  assert.match(audit,/title:'Could not load audit evidence\.'/);
  assert.match(audit,/onRetry:\(\)=>\{listing\.load\(\);focusResults\(\);\}/);
  assert.match(audit,/No trigger evidence yet/);
  assert.match(audit,/No audit evidence matches this search/);
  assert.match(audit,/<Empty text=\{search/);
  assert.match(audit,/<SearchField label="Search audit evidence" value=\{search\}/);
  assert.match(audit,/placeholder="Source, target or hash…"/);
  assert.match(audit,/triggerSource','trigger_source/);
  assert.match(audit,/targetType','target_type/);
  assert.match(audit,/verificationState','verification_state/);
  assert.match(audit,/verification==='on'\?'Verification on'/,
    'an enabled verification policy must not be mislabeled as proof that verification happened');
  assert.match(audit,/confirmationShown','confirmation_shown/);
  assert.match(audit,/confirmationShown&&<span>User confirmed<\/span>/);
  assert.match(audit,/transactionHash','transaction_hash'/);
  assert.match(audit,/executedAt','executed_at'/);
  assert.match(audit,/txHash&&explorer/,
    'an explorer link must require both a transaction hash and a recognized chain explorer');
  assert.match(audit,/<CopyButton value=\{txHash\} label="Copy transaction hash"\/>/);
  assert.match(audit,/<HistoryPager value=\{data\} page=\{page\} setPage=\{changePage\}/);
});

test('Trigger Audit rows remain compact and readable on mobile',()=>{
  assert.match(styles,/\.trigger-audit-meta\{display:flex;align-items:center;gap:5px;flex-wrap:wrap/);
  assert.match(styles,/@media\(max-width:700px\)\{[\s\S]*?\.trigger-audit-row\{align-items:flex-start\}/);
  assert.match(styles,/@media\(max-width:420px\)\{[\s\S]*?\.trigger-audit-row\{flex-wrap:wrap\}/);
  assert.match(styles,/\.trigger-audit-outcome\{width:100%;justify-content:flex-start/);
  assert.match(styles,/@media\(max-width:700px\)\{[\s\S]*?\.trigger-audit-hash \.user-card-copy,\.trigger-audit-outcome \.ico-btn\{[\s\S]*?width:44px;height:44px;min-height:44px/);
});

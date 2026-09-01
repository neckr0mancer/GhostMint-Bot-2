const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'dashboard','src','App.jsx'),'utf8');
const shared=fs.readFileSync(path.join(root,'dashboard','src','shared.jsx'),'utf8');
const rules=fs.readFileSync(path.join(root,'AGENTS.md'),'utf8');
const mintPrototype=fs.readFileSync(path.join(root,'docs','prototype-pages','mint.html'),'utf8');
const historyPrototype=fs.readFileSync(path.join(root,'docs','prototype-pages','history.html'),'utf8');

function between(source,start,end){
  const from=source.indexOf(start);
  const to=source.indexOf(end,from);
  assert.notEqual(from,-1,`${start} must exist`);
  assert.notEqual(to,-1,`${end} must follow ${start}`);
  return source.slice(from,to);
}

test('every dashboard list uses the shared three-number no-ellipsis pager rule',()=>{
  const pager=between(shared,'export function Pager','/* ==========================================================================');
  assert.match(pager,/const WINDOW=3/);
  assert.match(pager,/aria-label="Previous page"/);
  assert.match(pager,/aria-label="Next page"/);
  assert.match(pager,/aria-label="Last page"/);
  assert.doesNotMatch(pager,/First page|&laquo;|…/);

  const history=between(app,'function HistoryPager','// history.html');
  assert.match(history,/return <Pager [^;]+visibleCount=\{shown\}/);
  assert.doesNotMatch(history,/end-gap|start-gap|history-page-gap|…/);
  assert.match(rules,/previous arrow, three sliding page numbers, next\s+arrow, then jump-to-last/);
  assert.doesNotMatch(mintPrototype,/aria-label="First page"|<button>…<\/button>/);
  assert.doesNotMatch(historyPrototype,/<button>…<\/button>/);
});

test('primary task-entry fields autofocus while search fields remain opt-in',()=>{
  assert.match(app,/id="link-code"[\s\S]{0,220}autoFocus autoComplete="one-time-code"/);
  assert.match(app,/id="login-username"[\s\S]{0,220}autoFocus autoComplete="username"/);
  assert.match(app,/const input=mode==='code'\?codeInputRef\.current:usernameInputRef\.current;\s*input\?\.focus\(\{preventScroll:true\}\)/,
    'switching sign-in methods must move focus into the newly rendered primary input');
  assert.match(app,/autoFocus=\{active\}/);
  assert.match(app,/useEffect\(\(\)=>\{if\(active\)contractInputRef\.current\?\.focus/);
  assert.match(app,/useEffect\(\(\)=>\{if\(active&&enoughSelected\)contractInputRef\.current\?\.focus/);
  assert.match(app,/name="label" required autoFocus placeholder="e\.g\. copy-whale-1"/);
  assert.match(app,/name="name" required autoFocus placeholder="e\.g\. azuki-announcements"/);
  assert.doesNotMatch(app,/<input[^>]*type="search"[^>]*autoFocus|<input[^>]*autoFocus[^>]*type="search"/);
});

test('Schedule pages three rows on phones and labels eligibility deferrals as rescheduled',()=>{
  const tasks=between(app,'function Tasks(','// One tone per outcome');
  assert.match(tasks,/const PAGE_SIZE=mobile\?3:10/);
  assert.match(tasks,/\[page,bucket,search,serverFilters,PAGE_SIZE\]/);
  assert.match(tasks,/setPage\(1\);setSelectedIds\(\[\]\);\},\[mobile\]\)/);
  assert.match(tasks,/status==='retry'&&task\.eligibilityDeadline&&Number\(task\.phaseWaitCount\|\|0\)>0\?'rescheduled'/);
  assert.match(tasks,/\['pause','resume','retry'\]/,'the real Retry action for failed tasks must remain');
});

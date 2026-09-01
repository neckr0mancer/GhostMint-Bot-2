const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const test=require('node:test');

const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'dashboard','src','App.jsx'),'utf8');
const css=fs.readFileSync(path.join(root,'dashboard','src','styles.css'),'utf8');
const shared=fs.readFileSync(path.join(root,'dashboard','src','shared.jsx'),'utf8');

test('scheduled timestamps are readable and countdowns retain useful precision',async()=>{
  const display=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleDisplay.js')));
  const at=new Date('2026-08-26T20:00:00.000Z');
  assert.equal(display.formatScheduleDateTime(at),'26 Aug 2026 · 20:00 UTC');
  assert.doesNotMatch(display.formatScheduleDateTime(at),/\dT\d|\.000Z|Z$/);
  assert.equal(display.scheduleCountdown(at,new Date('2026-08-26T18:33:00.000Z').getTime()),'1h 27m');
  assert.equal(display.scheduleCountdown(at,new Date('2026-08-25T17:00:00.000Z').getTime()),'1d 3h');
  assert.equal(display.scheduleCountdown(at,new Date('2026-08-26T20:01:00.000Z').getTime()),'');
});

test('phase eligibility deadline never exceeds 24 hours from the submitted minute',async()=>{
  const display=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleDisplay.js')));
  const mintTime='2026-09-01T10:00:00.000Z';
  const stageStart=Date.parse('2026-09-01T10:00:45.000Z')/1000;
  const deadline=display.scheduleEligibilityDeadline(mintTime,stageStart,[
    {startTime:stageStart,endTime:Date.parse('2026-09-03T10:00:45.000Z')/1000},
  ]);
  assert.equal(deadline,'2026-09-02T10:00:00.000Z');
  assert.equal(Date.parse(deadline)-Date.parse(mintTime),24*60*60*1000);
});

test('Schedule exposes its countdown and readable metadata on mobile',()=>{
  assert.match(app,/function rowCountdown\(task\)/);
  assert.match(app,/formatScheduleDateTime\(at\)/);
  assert.match(app,/className="rv schedule-row-right">\{rowCountdown\(task\)\}\{rowPill\(task\)\}/);
  assert.match(css,/\.app\[data-m\] \.schedule-list-card \.rs\.fold\{display:block/);
  assert.match(css,/\.app\[data-m\] \.schedule-countdown/);
});

test('Mint tabs and page changes preserve drafts and in-flight detection',()=>{
  for(const tab of ['now','schedule','batch','presets'])assert.match(app,new RegExp(`hidden=\\{active!==['"]${tab}['"]\\}`));
  assert.match(app,/const \[mintWorkspaceMounted,setMintWorkspaceMounted\]=useState/);
  assert.match(app,/hidden=\{page!=='Mint'\}/);
  assert.match(app,/ContractLookupStatus visible=\{detecting\}/g);
  assert.match(app,/const formLocked=busy\|\|submitting/);
  assert.match(app,/disabled=\{formLocked\|\|detecting\|\|!enoughSelected\}/);
});

test('mint workspace progress indicators never insert layout-shifting loader blocks',()=>{
  assert.ok((app.match(/<ContractLookupStatus visible=\{detecting\}\/\>/g)||[]).length>=3,
    'Mint now, Schedule, and Batch should keep contract progress inside the address field');
  assert.ok((app.match(/contract-input-shell\$\{detecting\?' is-loading':''\}/g)||[]).length>=3,
    'form progress must use its scoped modifier rather than the full-page loading class');
  assert.doesNotMatch(app,/contract-input-shell\$\{detecting\?' loading':''\}/,
    'the full-page loading class would give an input wrapper a 100vh minimum height');
  assert.match(css,/main\.loading\{min-height:100vh/,
    'the session loader geometry must be scoped to its main element');
  assert.match(css,/\.contract-lookup-status\{position:absolute;inset-block:0;inset-inline-end:10px/,
    'Reading status should stay vertically centred within the existing input height');
  assert.doesNotMatch(app,/\(detecting\|\|simulating\)&&<div aria-label=/,
    'Mint now must not append a second skeleton below its stable transaction ledger');
  assert.doesNotMatch(app,/busy\|\|detecting\|\|\(!walletsArrived&&!wallets\.error\)/,
    'Batch must not replace its result area with a loader during contract or simulation work');
  assert.match(app,/detecting\?'Reading contract…':busy\?'Simulating…'/,
    'Batch should report simulation progress in its existing action button');
});

test('consequential Mint workspace requests lock their complete participating controls',()=>{
  assert.match(shared,/function SubTabs\(\{tabs=\[\],active,onChange,label='Sections',badges=\{\},disabled=false\}\)/);
  assert.match(shared,/role="tab" aria-selected=\{active===tab\.id\} disabled=\{disabled\}/);
  assert.match(app,/<SubTabs tabs=\{MINT_TABS\}[\s\S]*disabled=\{commitLocked\}/);
  assert.match(app,/const trackCommit=useCallback\(locked=>setActiveCommits/);
  assert.ok((app.match(/onCommitChange\?\.\(true\)/g)||[]).length>=4,
    'mint, schedule create, schedule controls, and batch confirm must lock tab exits');
  assert.ok((app.match(/onCommitChange\?\.\(false\)/g)||[]).length>=4,
    'every consequential lock must be released');
  assert.match(app,/finally\{setSubmitting\(false\);onCommitChange\?\.\(false\);\}/);
  assert.match(app,/<form className="g" style=\{\{gap:'11px'\}\} onSubmit=\{create\} aria-busy=\{submitting\|\|undefined\}>[\s\S]*<fieldset disabled=\{submitting\}>/);
  assert.match(app,/const formLocked=busy\|\|submitting;[\s\S]*<fieldset disabled=\{formLocked\}>/);
  assert.match(app,/schedule-list-card" aria-busy=\{Boolean\(controlBusy\)\|\|undefined\}>[\s\S]*<fieldset disabled=\{Boolean\(controlBusy\)\}>/);
});

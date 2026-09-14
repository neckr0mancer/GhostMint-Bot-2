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
  assert.match(css,/\.app\[data-m\] \.schedule-row-right\{grid-column:2;[^}]*flex-wrap:wrap/);
});

test('Schedule details are discoverable without replacing single-click row selection',()=>{
  assert.match(app,/function TaskDetails\(\{summary,onClose\}\)/);
  assert.match(app,/`\/api\/tasks\/\$\{encodeURIComponent\(summary\.id\)\}`/);
  assert.match(app,/onClick=\{\(\)=>chooseRow\(task\)\}/,
    'single click must remain the existing row-selection gesture');
  assert.match(app,/onDoubleClick=\{event=>\{event\.preventDefault\(\);event\.stopPropagation\(\);setDetailTask\(task\);\}\}/);
  assert.match(app,/<\/button>\s*<button type="button" className="ico-btn schedule-detail-open"[\s\S]*aria-label=\{`View details for \$\{taskContext\}`\}[\s\S]*aria-haspopup="dialog"[\s\S]*onClick=\{\(\)=>setDetailTask\(task\)\}/,
    'selection and the circular detail action must be sibling buttons');
  assert.match(app,/const taskContext=`\$\{task\.name\} · \$\{rowMeta\(task\)\} · \$\{bucketOf\(task\)\}`/,
    'repeated task names must remain distinguishable by wallet, time, and state');
  assert.match(app,/disabled=\{noWallets\|\|!scheduleWallet\|\|detecting\|\|submitting/,
    'the custom wallet control must retain the old required submission guard');
  assert.doesNotMatch(app,/>Details<\/button>/);
  assert.match(css,/\.ico-btn\.schedule-detail-open\{[^}]*border-radius:50%/);
  assert.match(css,/\.app\[data-m\] \.ico-btn\.schedule-detail-open\{[^}]*width:44px[^}]*height:44px/);
  assert.match(css,/\.schedule-task-row\.on\{[^}]*var\(--accent-soft\)/);
  assert.match(app,/<CountdownRing target=\{countdownTarget\}/);
  assert.match(app,/Latest recorded reason/);
  assert.match(app,/Readiness checks/);
  assert.match(app,/5-minute check/);
  assert.match(app,/30-second check/);
  assert.match(app,/detail\.data\?\.preflights\|\|\[\]/,
    'task detail must render persisted checks returned by the shared task service');
  assert.match(app,/item\.notificationState==='failed'/,
    'task detail must disclose a terminal linked-platform alert failure without changing task state');
  assert.match(app,/Attempt history/);
  assert.match(css,/\.schedule-detail-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:700px\)[\s\S]*\.schedule-detail-grid\{grid-template-columns:1fr\}/);
});

test('Mint tabs and page changes preserve drafts and in-flight detection',()=>{
  for(const tab of ['now','schedule','batch','presets'])assert.match(app,new RegExp(`hidden=\\{active!==['"]${tab}['"]\\}`));
  assert.match(app,/const \[mintWorkspaceMounted,setMintWorkspaceMounted\]=useState/);
  assert.match(app,/hidden=\{page!=='Mint'\}/);
  assert.match(app,/visible=\{page==='Mint'\}/,
    'the mounted Mint workspace must still learn when a cross-page hand-off makes it visible');
  assert.match(app,/active=\{visible&&active==='now'\}/,
    'returning from Home to an already-selected Mint Now tab must re-run prefill consumption');
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

test('Automation offers destination-specific creation actions and no trigger action on Policies',()=>{
  assert.match(app,/active==='all'&&<>[\s\S]*?Create sniper<\/button>[\s\S]*?Create watch rule<\/button>/);
  assert.match(app,/active==='snipers'\?'Create sniper':'Create watch rule'/);
  assert.doesNotMatch(app,/>New trigger<\/button>/);
  assert.match(app,/active==='policies'&&<TargetPolicies/);
  assert.match(app,/Policies configure an existing trigger/);
});

test('Automation creation controls open the requested shared form instead of only changing tabs',()=>{
  assert.match(app,/function openCreate\(destination\)[\s\S]*setCreating\(true\)[\s\S]*onTab\?\.\(destination\)/);
  assert.match(app,/onClick=\{\(\)=>onCreate\?\.\('snipers'\)\}>Create a sniper/);
  assert.match(app,/onClick=\{\(\)=>onCreate\?\.\('social'\)\}>Create a watch rule/);
  assert.match(app,/create:'snipers',where:'Open sniper creation'/);
  assert.match(app,/create:'social',where:'Open watch-rule creation'/);
  assert.match(app,/ghostmint-open-automation-create/);
  assert.doesNotMatch(app,/useRef\(consumePendingAutomationCreate\(\)\)/,
    'StrictMode can discard a render, so render must never consume the one-shot hand-off');
  assert.match(app,/const \[creating,setCreating\]=useState\(\(\)=>initialCreate\.current===active\)/,
    'both StrictMode renders must derive the same initial open state from a non-destructive read');
  assert.match(app,/if\(previousActive\.current===active\)return;/,
    'the tab transition effect must be idempotent when StrictMode replays mount effects');
});

test('social watch-rule cards refresh from the canonical websocket event',()=>{
  assert.doesNotMatch(app,/useLoad\('\/api\/watch-rules',\[\],'watch\.changed'\)/);
  assert.ok((app.match(/useLoad\('\/api\/watch-rules',\[\],'watchrules\.changed'\)/g)||[]).length>=3);
});

test('Automation configuration editing is distinct from target-policy editing',()=>{
  assert.match(app,/function TriggerCard\(\{row,onEdit,onPolicy/);
  assert.match(app,/onClick=\{\(\)=>onEdit\?\.\(row\)\}>Edit<\/button>/);
  assert.match(app,/onClick=\{\(\)=>onPolicy\?\.\(row\)\}>Policy<\/button>/);
  assert.match(app,/function openEdit\(row\)[\s\S]*setEditing\(row\.source\)/);
  assert.match(app,/editing=\{editing\} key=\{editing\?\.id\|\|'new-sniper'\}/);
  assert.match(app,/editing=\{editing\} key=\{editing\?\.id\|\|'new-watch-rule'\}/);
  assert.match(app,/`\/api\/snipers\/\$\{editing\.id\}`/);
  assert.match(app,/`\/api\/watch-rules\/\$\{editing\.id\}`/);
});

test('sniper timing is scoped to the form while its future-sniper default lives in Settings',()=>{
  assert.match(app,/<label className="fl"><span>Copy timing for this sniper<\/span>/,
    'create and edit must make clear that the selection belongs to this sniper');
  const settingsStart=app.indexOf('function Settings({profile,onThemeChange,onProfileChange})');
  const settings=app.slice(settingsStart,app.indexOf('function Login(',settingsStart));
  assert.match(settings,/<SniperTimingSettingsPanel\/>/,
    'the account-level future-sniper default belongs with account preferences');
  assert.match(app,/function SniperTimingSettingsPanel\(\)[\s\S]*useLoad\('\/api\/snipers'/,
    'Settings must read the existing persisted per-user default');
  const automationStart=app.indexOf('function Automation({profile,tab,onTab,target})');
  const automation=app.slice(automationStart,app.indexOf('// Wallets = Wallets + P&L',automationStart));
  assert.doesNotMatch(automation,/<SniperDefaultControl/,
    'the Snipers list must not keep an always-visible global-default panel');
});

test('Automation has explicit loading, error, empty and locked-save states',()=>{
  assert.match(app,/scoped\.length===0[\s\S]*No copy snipers yet\.[\s\S]*No social watch rules yet\./);
  assert.match(app,/policyDetails\.error[\s\S]*Could not load this policy\./);
  assert.ok((app.match(/<fieldset disabled=\{busy\}>/g)||[]).length>=2,
    'both automation forms should lock every participating control during save');
  assert.match(app,/formError&&<Notice error=\{formError\.message\|\|'Could not save this sniper\.'/);
  assert.match(app,/formError&&<Notice error=\{formError\.message\|\|'Could not save this watch rule\.'/);
  assert.match(app,/function SniperTimingSettingsPanel\(\)[\s\S]*snipers\.error[\s\S]*Could not load your default copy timing\.[\s\S]*<Skeleton/);
});

test('an already-live schedule offers an emphasized Mint now hand-off with its draft intact',()=>{
  assert.match(app,/setScheduleError\(\{title:'This stage is already open\.',detail,action:'mint-now'\}\)/);
  assert.match(app,/scheduleError\.action==='mint-now'[\s\S]*className="b p sm"[\s\S]*>Mint now<\/button>/);
  assert.match(app,/setPendingMintPrefill\(\{contractAddress,quantity\}\);onSwitchToMint\?\.\(\)/);
  assert.match(app,/<Tasks profile=\{profile\}[\s\S]*onSwitchToMint=\{\(\)=>onTab\('now'\)\}/);
});

test('Schedule uses detected facts instead of asking the user to invent a task name',()=>{
  const start=app.indexOf('function Tasks(');
  const end=app.indexOf('function Activity(',start);
  const schedule=app.slice(start,end);
  assert.doesNotMatch(schedule,/name="name"/);
  assert.doesNotMatch(schedule,/>Name(?:<|\{)/);
  assert.match(schedule,/input\.name=String\(detectedName\|\|scheduledStage\?\.label\|\|`Mint \$\{shortHex\(currentAddress\)\}`\)\.slice\(0,100\)/);
  assert.match(schedule,/Detected <b>\{detectedName\|\|'contract'\}<\/b>/);
  assert.match(schedule,/price and eligibility checked at opening/);
  assert.match(schedule,/max \{maxPerWallet\}\/wallet/);
});

test('Schedule uses the server recommendation without pretending a future allowlist is already eligible',()=>{
  const start=app.indexOf('function Tasks(');
  const end=app.indexOf('function Activity(',start);
  const schedule=app.slice(start,end);
  assert.match(schedule,/const recommended=result\.schedulePlan/);
  assert.match(schedule,/recommended\?\.recommendedStageUuid/);
  assert.doesNotMatch(schedule,/future\.find\(s=>!scheduleStageRequiresOpenSeaBuilder\(s\)\)/,
    'the client must not skip an earlier stage merely because eligibility is checked later');
  assert.match(schedule,/A future allowlist cannot be verified from an address alone\./);
  assert.match(schedule,/s\.advancesIfIneligible\?'If this wallet is not eligible, the task moves to the next published stage/);
  assert.match(schedule,/No later stage is currently reachable within the 24-hour eligibility window/);
  assert.match(schedule,/eligibility checked at opening/);
});

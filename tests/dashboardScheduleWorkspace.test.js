const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const test=require('node:test');

const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'dashboard','src','App.jsx'),'utf8');
const css=fs.readFileSync(path.join(root,'dashboard','src','styles.css'),'utf8');
const shared=fs.readFileSync(path.join(root,'dashboard','src','shared.jsx'),'utf8');
const dashboardApi=fs.readFileSync(path.join(root,'src','dashboard','api.js'),'utf8');

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

test('initial detection and stage switching preserve provider seconds in scheduled mint time',()=>{
  assert.match(app,/setMintTime\(stageMintTimeLocalValue\(detectedStart\)\)/);
  assert.match(app,/setMintTime\(stageMintTimeLocalValue\(opening\)\)/);
  assert.match(app,/<DateTimePicker name="mintTime"/);
  assert.doesNotMatch(app,/type="datetime-local"/,
    'Schedule must use the themed picker rather than the browser-native calendar');
  assert.doesNotMatch(app,/setMintTime\(local\.toISOString\(\)\.slice\(0,16\)\)/);
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
  assert.match(app,/function TaskDetails\(\{summary,onClose,onChanged\}\)/);
  assert.match(app,/`\/api\/tasks\/\$\{encodeURIComponent\(summary\.id\)\}`/);
  assert.match(app,/onClick=\{\(\)=>chooseRow\(task\)\}/,
    'single click must remain the existing row-selection gesture');
  assert.match(app,/onDoubleClick=\{event=>\{event\.preventDefault\(\);event\.stopPropagation\(\);setDetailTask\(task\);\}\}/);
  assert.match(app,/<\/button>\s*<button type="button" className="ico-btn schedule-detail-open"[\s\S]*aria-label=\{`View details for \$\{taskContext\}`\}[\s\S]*aria-haspopup="dialog"[\s\S]*onClick=\{\(\)=>setDetailTask\(task\)\}/,
    'selection and the circular detail action must be sibling buttons');
  assert.match(app,/const taskContext=`\$\{task\.name\} · \$\{rowMeta\(task\)\} · \$\{bucketOf\(task\)\}`/,
    'repeated task names must remain distinguishable by wallet, time, and state');
  assert.match(app,/disabled=\{noWallets\|\|!scheduleWallet\|\|!mintTime\|\|detecting\|\|submitting/,
    'the custom wallet control must retain the required wallet and mint-time submission guards');
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
  const settingsStart=app.indexOf('function Settings({profile,onThemeChange,onProfileChange,target})');
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
  assert.match(app,/const choice=stageChoice\(scheduledStage\)/);
  assert.match(app,/if\(choice\.disabled\)/);
  assert.match(app,/title:choice\.state==='live'\?'This stage is already open\.'/);
  assert.match(app,/action:choice\.state==='live'\?'mint-now':undefined/);
  assert.match(app,/scheduleError\.action==='mint-now'[\s\S]*className="b p sm"[\s\S]*>Mint now<\/button>/);
  assert.match(app,/setPendingMintPrefill\(\{contractAddress,quantity,walletLabel:scheduleWallet\}\);onSwitchToMint\?\.\(\)/);
  assert.match(app,/<Tasks profile=\{profile\}[\s\S]*onSwitchToMint=\{\(\)=>onTab\('now'\)\}/);
  assert.match(app,/!detecting&&!scheduleTerminal&&liveMintStage[\s\S]*className="schedule-live-now"[\s\S]*There is nothing to schedule\.[\s\S]*>Mint now<\/button>/,
    'an authoritative live, non-sold-out stage must offer the Mint now hand-off');
  assert.match(app,/setPendingBatchPrefill\(\{contractAddress,quantity\}\);onSwitchToBatch\?\.\(\)/);
  assert.match(app,/<Tasks profile=\{profile\}[\s\S]*onSwitchToBatch=\{\(\)=>onTab\('batch'\)\}/);
  assert.match(app,/setStageType\(futureStage\?\.stageType\|\|''\)/,
    'a live stage must not be reused as a fake future schedule choice');
  assert.match(app,/liveOnlyStage=liveChoice\?\.tone!=='ineligible'[\s\S]*\?availability\.liveStage:null/,
    'a wallet-eligible live stage must keep its Mint now handoff even when a future stage is selected');
  assert.match(app,/scheduleFormAvailable=!scheduleTerminal&&!verifiedWindowEnded&&\(!liveMintStage\|\|Boolean\(selectedStageKey\)\)/,
    'a safely selected future stage must remain schedulable beside the live-stage handoff');
  assert.match(app,/selectedStageKey\?'Mint this live stage now, or keep the selected future stage scheduled below\.'/,
    'the simultaneous live and future-stage state must explain both available actions');
  assert.match(app,/liveOnlyStage=liveChoice\?\.tone!=='ineligible'/,
    'an explicitly ineligible wallet must never receive the live Mint now handoff');
});

test('a live stage keeps an unconfirmed future gated stage reachable for explicit selection',async()=>{
  const state=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleStageAvailability.mjs')));
  const now=Date.parse('2026-09-25T12:00:00Z');
  const live={uuid:'public-live',label:'Public',stageType:'public',startTime:now/1000-60,
    endTime:now/1000+1800,eligibilityState:'open_to_all'};
  const future={uuid:'allowlist-next',label:'Allowlist',stageType:'signed_presale',
    startTime:now/1000+3600,endTime:now/1000+7200,eligibilityState:'check_at_open'};
  const availability=state.scheduleStageAvailability({
    drop:{isMinting:true,activeStage:live,stages:[live,future]},now,
  });
  assert.equal(availability.liveStage,live);
  assert.deepEqual(availability.futureStages,[future]);
  assert.equal(state.scheduleStageChoiceState(future,now,{authoritativeLive:false}).disabled,false,
    'unknown-at-opening eligibility stays an explicit schedulable choice');
  assert.match(app,/const hasSelectableFutureStage=stages\.some\(stage=>\{/);
  assert.match(app,/!liveMintStage\|\|Boolean\(selectedStageKey\)\|\|hasSelectableFutureStage/,
    'the live handoff must not hide the picker before the user selects the gated future stage');
  assert.match(app,/hasSelectableFutureStage\?'Mint this live stage now, or choose a future stage below to schedule\.'/,
    'the live-state copy must explain the still-available future-stage choice');
});

test('a sold-out collection is terminal and keeps a non-blank read-only stage summary',async()=>{
  const state=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleStageAvailability.mjs')));
  const now=Date.parse('2026-09-25T12:00:00Z');
  const ended={uuid:'ended',label:'Allowlist',stageType:'allowlist',startTime:now/1000-7200,endTime:now/1000-3600};
  const final={uuid:'public',label:'Public',stageType:'public',startTime:now/1000-1800,endTime:now/1000+3600,
    eligibilityState:'open_to_all'};
  const availability=state.scheduleStageAvailability({
    drop:{isMinting:false,activeStage:null,stages:[ended,final],soldOut:true},now,
  });
  assert.equal(availability.soldOut,true);
  assert.equal(availability.liveStage,null,'sold out must never fall through to the live Mint now path');
  assert.deepEqual(availability.futureStages,[],'sold out must expose no schedulable stage');
  assert.equal(availability.soldOutStage,final,'the final started stage keeps the selector summary from going blank');
  assert.deepEqual(state.scheduleStageChoiceState(final,now,{authoritativeLive:false,authoritativeSoldOut:true}),{
    tag:'Eligible',tone:'open_to_all',eligibilityState:'open_to_all',stageStatus:'Sold Out',stageStatusTone:'ended',
    disabled:true,state:'sold_out',soldOut:true,
  });
  assert.match(app,/if\(!chosenStage&&availability\.soldOutStage\)chosenStage=availability\.soldOutStage/,
    'the terminal preview must retain the final stage instead of showing Choose a stage');
  assert.match(app,/scheduleTerminal[\s\S]*stageLiveness\.soldOut\?'is-sold-out':'is-ended'[\s\S]*All available items have been minted\.[\s\S]*Nothing can be scheduled or sent\./);
  assert.match(app,/scheduleFormAvailable&&<button className="b p"/,
    'sold out must remove the scheduling action rather than merely disabling it ambiguously');
});

test('an ended but not exhausted collection is terminal without claiming every item was minted',async()=>{
  const state=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleStageAvailability.mjs')));
  const now=Date.parse('2026-09-25T12:00:00Z');
  const ended={uuid:'public',label:'Public',stageType:'public',startTime:now/1000-7200,
    endTime:now/1000-3600,eligibilityState:'open_to_all'};
  const availability=state.scheduleStageAvailability({
    drop:{isMinting:false,activeStage:null,stages:[ended],soldOut:false},soldOut:false,now,
  });
  assert.equal(availability.soldOut,false);
  assert.equal(availability.liveStage,null);
  assert.equal(availability.endedStage,ended,'the final ended stage keeps the preview summary non-blank');
  assert.match(app,/if\(!chosenStage&&availability\.endedStage\)chosenStage=availability\.endedStage/);
  assert.match(app,/stageLiveness\.soldOut\?'All available items have been minted\.':'The published mint window is over\.'/,
    'ended and sold-out terminal copy must remain distinct');
});

test('an incomplete stage catalog scopes an ended public window without ending the whole drop',async()=>{
  const state=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleStageAvailability.mjs')));
  assert.deepEqual(state.scheduleDropEndState({soldOut:false,ended:true,stageCatalogComplete:false}),{
    terminal:false,verifiedWindowEnded:true,
  });
  assert.deepEqual(state.scheduleDropEndState({soldOut:false,ended:true,stageCatalogComplete:true}),{
    terminal:true,verifiedWindowEnded:false,
  });
  assert.deepEqual(state.scheduleDropEndState({soldOut:true,ended:true,stageCatalogComplete:false}),{
    terminal:true,verifiedWindowEnded:false,
  });
  assert.match(app,/No verified future stage is available right now\. Other collection stages may still exist, so GhostMint is not treating the whole drop as ended\./,
    'incomplete-catalog copy must stay scoped to the verified public window');
  assert.match(app,/scheduleDropEndState\(\{soldOut:stageLiveness\.soldOut,ended:stageLiveness\.ended,stageCatalogComplete\}\)/,
    'the UI terminal decision must include catalog completeness rather than assuming the verified window is the whole drop');
});

test('Schedule trusts provider liveness instead of declaring a postponed timestamp live',async()=>{
  const state=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleStageAvailability.mjs')));
  const now=Date.parse('2026-09-25T12:00:00Z');
  const delayed={uuid:'delayed',label:'Public',stageType:'public',schedulable:true,
    startTime:now/1000-600,endTime:now/1000+3600};
  const result=state.scheduleStageAvailability({drop:{isMinting:false,activeStage:null,stages:[delayed]},now});
  assert.equal(result.liveStage,null);
  assert.equal(result.futureStages.length,0);
});

test('Schedule recognizes an authoritative final live stage and safe on-chain fallback',async()=>{
  const state=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleStageAvailability.mjs')));
  const now=Date.parse('2026-09-25T12:00:00Z');
  const live={uuid:'live',label:'Public',stageType:'public',startTime:now/1000-60,endTime:now/1000+3600};
  assert.equal(state.scheduleStageAvailability({drop:{isMinting:true,activeStage:live,stages:[live]},now}).liveStage,live);
  assert.equal(state.scheduleStageAvailability({startTime:live.startTime,endTime:live.endTime,
    priceWeiPerItem:'0',now}).liveStage.label,'Public mint');
});

test('Schedule excludes stale future-stage records whose end has already passed',async()=>{
  const state=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleStageAvailability.mjs')));
  const now=Date.parse('2026-09-25T12:00:00Z');
  const stale={uuid:'stale',label:'Stale stage',stageType:'public',schedulable:true,
    startTime:now/1000+3600,endTime:now/1000-60};
  assert.deepEqual(state.scheduleStageAvailability({drop:{stages:[stale]},now}).futureStages,[]);
  const inverted={...stale,endTime:now/1000+1800};
  assert.deepEqual(state.scheduleStageAvailability({drop:{stages:[inverted]},now}).futureStages,[],
    'a stage cannot end before its advertised future start');
});

test('Schedule stage choices never invent allowlist eligibility',async()=>{
  const state=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleStageAvailability.mjs')));
  const now=Date.parse('2026-09-25T12:00:00Z');
  assert.equal(state.scheduleStageDisplayName({stageType:'signed_presale'}),'Signed Presale');
  assert.deepEqual(state.scheduleStageChoiceState({startTime:now/1000+3600,
    eligibilityState:'eligible'},now),{
    tag:'Eligible',tone:'eligible',eligibilityState:'eligible',stageStatus:'Not Started',stageStatusTone:'pending',
    disabled:false,state:'eligible'
  });
  assert.deepEqual(state.scheduleStageChoiceState({startTime:now/1000+3600,
    eligibilityState:'ineligible'},now),{
    tag:'Not eligible',tone:'ineligible',eligibilityState:'ineligible',stageStatus:'Not Started',stageStatusTone:'pending',
    disabled:true,state:'ineligible'
  });
  assert.deepEqual(state.scheduleStageChoiceState({startTime:now/1000+3600,
    eligibilityState:'check_at_open'},now),
  {tag:'Checked at opening',tone:'check_at_open',eligibilityState:'check_at_open',stageStatus:'Not Started',stageStatusTone:'pending',
    disabled:false,state:'check_at_open'});
  assert.deepEqual(state.scheduleStageChoiceState({startTime:now/1000+3600,
    eligibilityState:'open_to_all'},now),{
    tag:'Eligible',tone:'open_to_all',eligibilityState:'open_to_all',stageStatus:'Not Started',stageStatusTone:'pending',
    disabled:false,state:'open_to_all'
  });
  assert.deepEqual(state.scheduleStageChoiceState({startTime:now/1000-60,endTime:now/1000+3600,
    eligibilityState:'open_to_all'},now,{authoritativeLive:false}),
  {tag:'Eligible',tone:'open_to_all',eligibilityState:'open_to_all',stageStatus:'Not Active',stageStatusTone:'pending',
    disabled:true,state:'not_live'},
  'a provider-inactive stage whose advertised start passed must keep eligibility while saying Not Active');
  assert.deepEqual(state.scheduleStageChoiceState({startTime:now/1000-3600,endTime:now/1000-60,
    eligibilityState:'open_to_all'},now,{authoritativeLive:true}),
  {tag:'Eligible',tone:'open_to_all',eligibilityState:'open_to_all',stageStatus:'Live',stageStatusTone:'success',
    disabled:true,state:'live',live:true},
  'the provider active-stage signal must override stale published end timestamps without replacing eligibility');
  assert.deepEqual(state.scheduleStageChoiceState({startTime:now/1000-3600,endTime:now/1000+3600,
    eligibilityState:'ineligible'},now,{authoritativeLive:true}),
  {tag:'Not eligible',tone:'ineligible',eligibilityState:'ineligible',stageStatus:'Live',stageStatusTone:'success',
    disabled:true,state:'live',live:true},
  'a live stage must still say that this wallet is not eligible');
  assert.deepEqual(state.scheduleStageChoiceState({startTime:now/1000-7200,endTime:now/1000-3600,
    eligibilityState:'eligible'},now,{authoritativeLive:false}),
  {tag:'Eligible',tone:'eligible',eligibilityState:'eligible',stageStatus:'Ended',stageStatusTone:'ended',
    disabled:true,state:'ended'},
  'an ended stage must keep its wallet eligibility badge and put Ended beside the stage name');
});

test('Schedule notifications are deduplicated and deep-link to the durable task state',()=>{
  assert.match(app,/SEEN_SCHEDULE_NOTIFICATION_KEYS=new Set\(\)/);
  assert.match(app,/if\(SEEN_SCHEDULE_NOTIFICATION_KEYS\.has\(key\)\)return false/);
  assert.match(app,/SEEN_SCHEDULE_NOTIFICATION_KEYS\.add\(key\)/);
  assert.match(app,/firstScheduleNotification\(message\?\.notificationKey\)/);
  assert.match(app,/message\?\.type==='task\.change-review'/);
  assert.match(app,/tab=schedule&bucket=paused&task=\$\{encodeURIComponent\(message\.taskId\)\}/);
  assert.match(app,/message\?\.type==='task\.rescheduled'/);
  assert.match(app,/message\?\.type==='task\.change-accepted'/);
  assert.ok((app.match(/tab=schedule&bucket=pending&task=\$\{encodeURIComponent\(message\.taskId\)\}/g)||[]).length>=2,
    'automatic and accepted changes should both open the pending task');
  assert.match(app,/BUCKETS\.some\(\(\[key\]\)=>key===value\)\?value:'pending'/);
  assert.match(app,/requestedTaskId=useRef\(new URLSearchParams\(window\.location\.search\)\.get\('task'\)\)/);
  assert.match(app,/api\(`\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}`\)\.then\(setDetailTask\)/);
});

test('Admin mounts only one notification listener for the active responsive shell',()=>{
  const start=app.indexOf('function AdminShell(');
  const end=app.indexOf('function isAdminPath',start);
  const admin=app.slice(start,end);
  assert.match(admin,/const mobile=useIsMobile\(\)/);
  assert.match(admin,/\{mobile&&<NotificationBell\/>\}/);
  assert.match(admin,/\{!mobile&&<div className="notification-bell-desktop"><NotificationBell\/><\/div>\}/);
  assert.equal([...admin.matchAll(/<NotificationBell\/>/g)].length,2,
    'both responsive placements should remain, guarded by mutually exclusive breakpoints');
});

test('Schedule uses detected facts instead of asking the user to invent a task name',()=>{
  const start=app.indexOf('function Tasks(');
  const end=app.indexOf('function Activity(',start);
  const schedule=app.slice(start,end);
  assert.doesNotMatch(schedule,/name="name"/);
  assert.doesNotMatch(schedule,/>Name(?:<|\{)/);
  assert.match(schedule,/input\.name=String\(detectedName\|\|scheduledStage\?\.label\|\|`Mint \$\{shortHex\(currentAddress\)\}`\)\.slice\(0,100\)/);
  assert.match(schedule,/aria-label="Schedule preview"/);
  assert.match(schedule,/<span>Contract name<\/span><b>\{detectedName\|\|'Name unavailable'\}<\/b>/);
  assert.match(schedule,/current price, wallet eligibility, balance, and simulation again before sending/);
  assert.match(schedule,/Five minutes and 30 seconds before the attempt/);
  assert.match(schedule,/published max \$\{maxPerWallet\}\/wallet/);
});

test('Schedule change review displays exact values and locks every overlay exit while saving',()=>{
  assert.match(app,/function scheduleChangeFact\(change,chain\)/);
  assert.match(app,/Call target/);
  assert.match(app,/Mint method/);
  assert.match(app,/Fee recipient/);
  assert.match(app,/Authorization/);
  assert.match(app,/Opening: \$\{taskDetailTime\(change\.from\)\} → \$\{taskDetailTime\(change\.to\)\}/);
  assert.match(app,/Price: \$\{freeOrNativeAmount\(change\.from,nativeSymbolForChain\(chain\)\)\} →/);
  assert.match(app,/<Overlay open onClose=\{onClose\} wide busy=\{Boolean\(changeBusy\)\}/);
  assert.match(app,/if\(event\.key==='Escape'&&!busyRef\.current\)onCloseRef\.current\(\)/);
  assert.match(app,/event\.target===event\.currentTarget&&!busy/);
  assert.match(app,/aria-label="Close" disabled=\{busy\}/);
});

test('Schedule help stays available before contract detection and has a mobile-safe touch target',()=>{
  const start=app.indexOf('function Tasks(');
  const end=app.indexOf('function Activity(',start);
  const schedule=app.slice(start,end);
  const help=schedule.indexOf('className="ico-btn schedule-help-open"');
  const detected=schedule.indexOf('ADDRESS_SHAPE.test(contractAddress.trim())&&lastDetected.current');
  assert.ok(help>=0&&help<detected,'help must be reachable before a contract is detected');
  assert.match(css,/\.ico-btn\.schedule-help-open\{width:44px;height:44px/);
  assert.match(app,/onKeyDown=\{event=>\{if\(event\.key==='Escape'\)\{event\.stopPropagation\(\);setPinned\(false\);setDismissed\(true\);\}\}\}/,
    'Escape must close the focused popover without relying only on a document listener');
  assert.match(css,/\.schedule-preview-grid b\{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere\}/);
});

test('Schedule quantity controls obey the detected wallet cap',()=>{
  const start=app.indexOf('function Tasks(');
  const end=app.indexOf('function Activity(',start);
  const schedule=app.slice(start,end);
  assert.match(schedule,/const quantityMax=maxPerWallet\|\|100/);
  assert.match(schedule,/name="quantity" type="number" min=\{1\} max=\{quantityMax\}/);
  assert.match(schedule,/quantityPicks\(quantityMax\)/);
  assert.match(schedule,/Math\.min\(normalized,quantityPolicy\.max\)/,
    'a quantity entered before detection must be reduced to the detected legal maximum');
});

test('Schedule cannot submit until an explicit or detected mint time exists',()=>{
  const start=app.indexOf('function Tasks(');
  const end=app.indexOf('function Activity(',start);
  const schedule=app.slice(start,end);
  assert.match(schedule,/<DateTimePicker name="mintTime"[\s\S]*required disabled=\{noWallets\}/);
  assert.match(schedule,/disabled=\{noWallets\|\|!scheduleWallet\|\|!mintTime\|\|detecting\|\|submitting/);
  assert.match(schedule,/!detecting&&\(!liveMintStage\|\|Boolean\(selectedStageKey\)\|\|hasSelectableFutureStage\)&&ADDRESS_SHAPE\.test\(contractAddress\.trim\(\)\)&&lastDetected\.current===contractAddress\.trim\(\)\.toLowerCase\(\)/,
    'clearing a successful form must not leave an empty address looking like a detected contract');
});

test('Schedule uses the server recommendation without pretending a future allowlist is already eligible',()=>{
  const start=app.indexOf('function Tasks(');
  const end=app.indexOf('function Activity(',start);
  const schedule=app.slice(start,end);
  assert.match(schedule,/const recommended=result\.schedulePlan/);
  assert.match(schedule,/recommended\.recommendedStageUuid/);
  assert.match(schedule,/const selectable=future\.filter\(stage=>!stageChoice\(stage,detectedAt,detectedLiveness\)\.disabled\)/);
  assert.match(schedule,/selectable\.length===1&&stageChoice\(selectable\[0\],[^)]*\)\.eligibilityState!=='check_at_open'/,
    'an unknown gated stage must not become the automatic choice merely because it is the only one');
  assert.match(schedule,/liveOnlyStage=liveChoice\?\.tone!=='ineligible'[\s\S]*\?availability\.liveStage:null/,
    'a live phase must keep its handoff without hiding a safely selected future stage');
  assert.ok((schedule.match(/liveChoice\?\.tone!=='ineligible'/g)||[]).length>=2,
    'a live but explicitly ineligible phase must never become a Mint now hand-off');
  assert.match(schedule,/if\(choice\.disabled\)/,
    'submission must re-check that the chosen stage is still selectable');
  assert.match(schedule,/Boolean\(stages\.find\(stage=>scheduleStageSelectionKey\(stage\)===selectedStageKey\)&&stageChoice/,
    'the schedule action must disable when the selected stage becomes unavailable');
  assert.doesNotMatch(schedule,/\|\|future\[0\]\|\|null/,
    'a stale recommendation must not silently select the first of several stages');
  assert.match(schedule,/It never auto-selects a gated phase whose[\s\S]*wallet eligibility is still unknown/,
    'the client must explain why an unproven allowlist is not recommended automatically');
  assert.match(schedule,/Turn on the read-only eligibility check in Settings to confirm this wallet earlier\./,
    'an unconnected wallet must be directed to its durable Settings opt-in instead of being shown as eligible');
  assert.match(schedule,/const historicalDecisionMissing=providerDecisionMissing&&choice\.stageStatus==='Ended'/,
    'an omitted historical OpenSea result must remain distinct from an explicit ineligible decision');
  assert.match(schedule,/const eligibilityTag=choice\.eligibilityState==='open_to_all'\?'Eligible'[\s\S]*:needsEarlyAuthorization\?'Check not enabled'[\s\S]*:providerDecisionMissing\?\(authorizationUnavailable\?'Check unavailable'[\s\S]*:historicalDecisionMissing\?'Result unavailable':'Awaiting result'\)[\s\S]*:choice\.tag/,
    'public stages should use the same clear green Eligible state as OpenSea while remaining open to all');
  assert.match(schedule,/inlineStatus:choice\.stageStatus,inlineStatusTone:choice\.stageStatusTone/,
    'Live, Ended, and Not Started belong beside the stage name and time rather than replacing wallet eligibility');
  assert.match(schedule,/tag:eligibilityTag,tone:needsEarlyAuthorization\?'authorization_required':choice\.tone\|\|choice\.state,[\s\S]*disabled:choice\.disabled/,
    'every stage option must carry its authoritative eligibility state into the visual treatment');
  assert.match(schedule,/choice\.eligibilityState==='open_to_all'\?'Open to all wallets':null/,
    'the green public-stage eligibility must remain explicitly explained');
  assert.match(schedule,/label:`\$\{stageName\} · \$\{local\}`/);
  assert.match(schedule,/<SelectMenu label="Mint stage"/);
  assert.equal((schedule.match(/<SelectMenu label="Mint stage"/g)||[]).length,1,
    'the preview must expose one stage decision, not separate stage and eligibility controls');
  assert.doesNotMatch(schedule,/<div><span>Stage<\/span><b>/,
    'the selected stage belongs in the single stage selector, not a duplicate summary row');
  assert.doesNotMatch(schedule,/<div><span>Eligibility<\/span><b>/,
    'eligibility belongs on each stage option and the selected-stage tag, not a second field');
  assert.match(css,/\.schedule-preview-stage-control \.select-menu-option-copy b\{[^}]*font-size:\.94rem[^}]*font-weight:800/,
    'the stage name and date should be visually stronger than the supporting facts');
  assert.match(css,/\[data-option-tone="eligible"\] \.select-menu-tag[\s\S]*color:var\(--success\)/,
    'confirmed eligibility should be visibly green in both themes');
  assert.match(css,/\[data-option-tone="ineligible"\] \.select-menu-tag[\s\S]*color:var\(--muted\)/,
    'confirmed ineligibility should use the requested subdued treatment');
  assert.match(css,/\.schedule-preview-stage-control \.select-menu-inline-status\.success\{color:var\(--success\)\}/,
    'the inline Live status should be green in both themes');
  assert.match(css,/\.schedule-preview-stage-control \.select-menu-inline-status::before\{content:'·'/,
    'every stage state should read visually as stage name, date and time, then a separator and its timing');
  assert.match(css,/\.schedule-preview-stage-control \.select-menu-inline-status\.ended\{color:var\(--muted\)\}/);
  assert.match(css,/\.schedule-preview-stage-control \.select-menu-inline-status\.pending\{color:var\(--faint\)\}/);
  assert.match(schedule,/const compactFacts=\[stage\.maxPerWallet\?`Max \$\{stage\.maxPerWallet\}\/wallet`/,
    'mobile options should keep only useful max and price facts rather than repeating eligibility prose');
  assert.match(schedule,/className="schedule-stage-facts-full"/);
  assert.match(schedule,/className="schedule-stage-facts-mobile"/);
  assert.match(css,/@media\(max-width:700px\)\{[\s\S]*\.schedule-preview-stage-control \.select-menu-panel\{[^}]*max-height:min\(13\.25rem,36dvh\)[^}]*overscroll-behavior:contain/,
    'the mobile stage menu must use a bounded internally scrolling panel');
  assert.match(css,/\.schedule-preview-stage-control \.select-menu-option\{[^}]*min-height:44px[^}]*padding:\.38rem \.45rem/,
    'compact mobile options must retain a 44px touch target');
  assert.match(css,/\.schedule-preview-stage-control \.select-menu-group-label\{display:none\}/,
    'the mobile menu must not repeat its Mint stage label as a second panel heading');
  assert.match(css,/\.schedule-stage-facts-full\{display:none\}/);
  assert.match(css,/\.schedule-stage-facts-mobile\{display:block/);
  assert.match(css,/\.schedule-stage-facts-mobile\{display:none\}/,
    'desktop keeps the full stage facts and hides the mobile-only summary');
  assert.match(schedule,/walletLabel=\$\{encodeURIComponent\(normalizedWallet\)\}/,
    'the planner request must be tied to the selected owned wallet');
  assert.match(schedule,/lastEligibilityWallet\.current!==scheduleWallet/,
    'submission must remain disabled until the selected wallet owns the current eligibility read');
  assert.match(schedule,/onChange=\{e=>changeScheduleWallet\(e\.target\.value\)\}/,
    'changing wallets must synchronously invalidate the previous wallet plan');
  assert.match(schedule,/setStages\(\[\]\);setStageCatalogComplete\(null\);setSelectedStageKey\(''\);setRecommendedStageKey\(''\)/,
    'wallet switching must remove the previous wallet stage decision before any network wait');
  assert.match(schedule,/detectionSequence\.current\+=1;detectionAbort\.current\?\.abort\(\)/,
    'wallet switching must invalidate and abort an older eligibility request');
  assert.match(schedule,/detect\(address,\{walletLabel:nextWallet,walletRefresh:true,silent:true,force:true\}\)/,
    'wallet switching must force a fresh read for the newly selected wallet');
  assert.match(schedule,/\{signal:controller\.signal\}/,
    'the wallet-scoped detection request must be abortable');
  assert.match(schedule,/sequence!==detectionSequence\.current\|\|detectingKey\.current!==requestKey[\s\S]*scheduleWalletRef\.current!==normalizedWallet[\s\S]*contractAddressRef\.current\.trim\(\)\.toLowerCase\(\)!==trimmed\.toLowerCase\(\)/,
    'a stale response must not overwrite a newer wallet or contract selection');
  assert.match(schedule,/`No historical eligibility result is available for \$\{scheduleWallet\|\|'this wallet'\}`/,
    'an ended stage omitted from the provider response must use clear historical-result copy without inventing ineligibility');
  assert.match(schedule,/`OpenSea has not returned an eligibility result for \$\{scheduleWallet\|\|'this wallet'\} yet`/,
    'a future stage with a pending provider result must stay distinct from a historical omission');
  assert.match(schedule,/'OpenSea could not check this wallet right now'/,
    'a provider outage must be distinct from a wallet that has not enabled the check');
  assert.match(schedule,/authorizationNeedsReconnect=walletEligibilityAuthorization\?\.status==='reauthorize'/);
  assert.match(schedule,/Reconnect to check/);
  assert.match(schedule,/Reconnect eligibility check/,
    'an expired read-only authorization must direct the wallet back to Settings');
  assert.match(schedule,/Only the public stage could be verified right now\./,
    'an on-chain one-stage fallback must not masquerade as a complete project stage catalog');
  assert.doesNotMatch(schedule,/stages\.length>1&&<SelectMenu className="fl" label="Stage"/,
    'the stage picker belongs inside the schedule preview, including when only one stage exists');
});

test('dashboard contract detection requests authoritative supply facts',()=>{
  assert.match(dashboardApi,/detectMint:action[\s\S]*walletLabel:req\.query\.walletLabel,includeDrop:true,includeSupply:true/,
    'Schedule needs provider and on-chain supply facts to distinguish live from sold out');
});

test('Settings owns the persistent per-wallet eligibility permission while Schedule only links to it',()=>{
  const taskStart=app.indexOf('function Tasks(');
  const taskEnd=app.indexOf('function Activity(',taskStart);
  const schedule=app.slice(taskStart,taskEnd);
  const panelStart=app.indexOf('function OpenSeaEligibilitySettingsPanel(');
  const panelEnd=app.indexOf('function Settings(',panelStart);
  const panel=app.slice(panelStart,panelEnd);
  assert.ok(panelStart>=0&&panelEnd>panelStart);
  assert.match(panel,/api\(`\/api\/wallets\/\$\{encodeURIComponent\(wallet\.label\)\}\/opensea-eligibility`\)/,
    'Settings must load the permission separately for every owned wallet');
  assert.match(panel,/opensea-eligibility\/authorize/);
  assert.match(panel,/confirmation:'CONFIRM'/,
    'turning the Settings switch on is explicit consent and must satisfy the server boundary');
  assert.match(panel,/method:'DELETE'/);
  assert.match(panel,/safely renews its encrypted, read-only permission while the switch stays on/);
  assert.match(panel,/cannot mint, transfer, approve, or spend funds/);
  assert.doesNotMatch(schedule,/function authorizeWalletEligibility|function revokeWalletEligibility/,
    'Schedule must not own a second authorization flow');
  assert.match(schedule,/Eligibility check not enabled/);
  assert.match(schedule,/Check not enabled/);
  assert.match(schedule,/hasGatedStages&&!eligibilityEnabled&&<div className="schedule-eligibility-access"/,
    'the selected wallet opt-in prompt must disappear after that wallet has approved automatic checks');
  assert.doesNotMatch(schedule,/Automatic eligibility checks are on/,
    'approved wallets should not retain a success banner that becomes permanent visual noise');
  assert.doesNotMatch(schedule,/eligibilityBusy|setEligibilityBusy/,
    'opening Settings is synchronous navigation and must not leave an ignored wallet prompt permanently disabled');
  assert.match(schedule,/onOpenSettings\?\.\(\)/);
  assert.match(app,/onOpenSettings=\{\(\)=>go\('Settings',null,'opensea-eligibility'\)\}/,
    'the Schedule action must deep-link to the exact Settings panel');
});

test('Schedule change controls use plain-language safety copy and a stable switch animation',()=>{
  const start=app.indexOf('function Tasks(');
  const end=app.indexOf('function Activity(',start);
  const schedule=app.slice(start,end);
  assert.match(schedule,/Follow time changes automatically/);
  assert.match(schedule,/Turn this off to approve each time change/);
  assert.match(schedule,/same stage moves earlier or later/);
  assert.match(schedule,/Allow a higher mint price/);
  assert.match(schedule,/A higher price pauses the task and asks first\./);
  assert.match(schedule,/Allowed increase/);
  assert.match(schedule,/latestQuotes\?\.displayCurrency===displayCurrency/,
    'the enforceable native cap must use a freshly fetched quote for the saved display currency');
  assert.match(app,/role="switch" aria-checked=\{checked\}/);
  assert.match(css,/\.schedule-switch-thumb\{[^}]*width:16px;height:16px/);
  assert.match(css,/\.schedule-switch\[aria-checked="true"\] \.schedule-switch-thumb\{transform:translateX\(16px\)\}/);
  assert.doesNotMatch(schedule,/maxOpeningDelayMinutes/);
  assert.match(css,/\.info-popover-card\{position:absolute/,
    'toggle help must overlay instead of moving later fields');
});

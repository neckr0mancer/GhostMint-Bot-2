const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const {mintPriceStep}=require('../src/discord/menus');
const {pathToFileURL}=require('node:url');

const appSource=fs.readFileSync(path.join(__dirname,'..','dashboard','src','App.jsx'),'utf8');
const serverSource=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
const apiSource=fs.readFileSync(path.join(__dirname,'..','src','dashboard','api.js'),'utf8');
const botCommandSource=fs.readFileSync(path.join(__dirname,'..','src','commands','botCommandService.js'),'utf8');
const discordSource=fs.readFileSync(path.join(__dirname,'..','src','discord','discordBot.js'),'utf8');
const openSeaScheduleDraftSource=fs.readFileSync(path.join(__dirname,'..','src','mint','openSeaScheduleDraft.js'),'utf8');
const transactionEngineSource=fs.readFileSync(path.join(__dirname,'..','src','transactions','transactionEngine.js'),'utf8');
const batchPreviewSource=fs.readFileSync(path.join(__dirname,'..','dashboard','src','mintBatchPreview.mjs'),'utf8');
const stylesSource=fs.readFileSync(path.join(__dirname,'..','dashboard','src','styles.css'),'utf8');
const singlePreviewSource=appSource.slice(appSource.indexOf('function MintTransactionPreview'),appSource.indexOf('function batchAggregateAmount'));
const batchComponentSource=appSource.slice(appSource.indexOf('function BatchTransactionPreview'),appSource.indexOf('// Batch. Its own panel'));

test('dashboard address detection deduplicates overlapping paste and blur requests',()=>{
  assert.match(appSource,/requestKey===lastDetected\.current\|\|requestKey===detectingKey\.current/);
  assert.match(appSource,/detectingKey\.current=requestKey;[\s\S]*await api\(`\/api\/mints\/detect/);
});

test('dashboard waits for an unknown price instead of raising a red simulation error',()=>{
  assert.match(appSource,/!activePresetName&&\(!methodSignature\|\|\(!viaOpenSea&&priceEth===''\)\)/);
  assert.match(appSource,/if\(!activePresetName&&!viaOpenSea&&priceEth===''\)[\s\S]*Mint price needed\.[\s\S]*setMintError\(warning\)/,
    'pressing Enter must not bypass an unresolved mint price or fail without a persistent explanation');
  assert.match(appSource,/Mint price needed\.<\/b> Enter the price per NFT to continue/);
  assert.doesNotMatch(appSource,/Price \(ETH\) must be a plain non-negative number/);
});

test('notification bell records toast messages without rendering a second pop-up',()=>{
  assert.match(appSource,/subscribeNotificationLog\(setLog\)/);
  assert.doesNotMatch(appSource,/bell-auto-preview/);
});

test('dashboard mint completion records the chain actually prepared, not the wallet default chain',()=>{
  assert.match(serverSource,/async function recordMintActivity\([\s\S]*if \(intent\?\.state !== 'confirmed'\) return false/,
    'the shared success-side-effect helper must reject every non-confirmed intent');
  assert.match(serverSource,/async function recordMintActivitySafely\([\s\S]*Confirmed mint accounting update failed/,
    'a post-confirmation accounting write must be isolated from chain-derived success');
  assert.match(serverSource,/executePreparedMint:async\([\s\S]*if\(intent\.state==='confirmed'\)\{[\s\S]*recordMintActivitySafely/,
    'the dashboard adapter must not call success accounting for reverted or non-final intents');
  assert.match(serverSource,/recordMintActivitySafely\(\{ userId, wallet, quantity: previewQuantity\(prepared\.preview\), intent, chain: prepared\.chain \}\)/);
  assert.doesNotMatch(serverSource,/recordMintActivitySafely\(\{ userId, wallet, quantity: previewQuantity\(prepared\.preview\), intent, chain: wallet\.chain \}\)/);
});

test('History exposes durable mint records and Robinhood links use its own explorer',()=>{
  assert.match(appSource,/api\/mints\/history/);
  assert.match(appSource,/robinhood:'https:\/\/robinhoodchain\.blockscout\.com\/tx\/'/);
  assert.match(appSource,/All \$\{total\} mints were successful\./);
  assert.match(appSource,/Mint successful\./);
});

test('Discord uses the same calm manual-price guidance',()=>{
  const payload=mintPriceStep({chainSym:'ETH'});
  assert.equal(payload.content,'Enter the mint price per item in ETH to continue. Use 0 only if the mint is free.');
  assert.equal(/recognized price function/i.test(payload.content),false);
});

test('wallet rail badge counts every wallet and still refreshes from wallets.changed',()=>{
  assert.match(appSource,/Wallets:Array\.isArray\(wallets\.data\)\?wallets\.data\.length:0/);
  assert.match(appSource,/useLoad\('\/api\/wallets',\[\],'wallets\.changed'\)/);
  assert.match(appSource,/item==='Wallets'\?`\$\{badge\} wallets`/);
});

test('dashboard and guided bot batches preserve the OpenSea preparation decision',()=>{
  assert.doesNotMatch(appSource,/batch cannot encode/);
  assert.match(appSource,/chain:detectedChain,viaOpenSea,methodSignature:viaOpenSea\?undefined:methodSignature/);
  assert.match(appSource,/arguments:viaOpenSea\?\[\]:detectedArguments,valueWei/);
  assert.match(serverSource,/viaOpenSea: flowData\.viaOpenSea === true/);
  assert.match(discordSource,/viaOpenSea: flowData\.viaOpenSea === true/);
});

test('batch simulation waits for contract detection and uses the detected per-wallet maximum',()=>{
  assert.match(appSource,/const formLocked=busy\|\|submitting/);
  assert.match(appSource,/disabled=\{formLocked\|\|detecting\|\|!enoughSelected\}/);
  assert.match(appSource,/detecting\?'Reading contract…'/);
  assert.match(appSource,/requestKey===lastDetected\.current\|\|requestKey===detectingKey\.current/);
  assert.match(appSource,/const message=mintDetectionMessage\(error\)/);
  assert.doesNotMatch(appSource,/result\.drop\?\.activeStage\?\.maxPerWallet/);
  // Any argument shape counts: Schedule legitimately probes the policy with stage data merged
  // over the detect result, while Mint-now and Batch pass the raw response. What matters is
  // that all three surfaces resolve their cap through the one shared function.
  assert.ok((appSource.match(/mintQuantityPolicy\(/g)||[]).length>=3,
    'single, schedule, and batch must share the same quantity policy');
  assert.match(appSource,/const quantityMax=maxPerWallet\|\|100/);
  assert.match(appSource,/max=\{quantityMax\}/);
  assert.match(appSource,/quantityPicks\(quantityMax\)/);
  assert.doesNotMatch(appSource,/quantityPicks\(3\)/);
});

test('scheduled mint detection uses the shared max and reads a one-item price',()=>{
  assert.match(appSource,/api\/mints\/detect\?contractAddress=\$\{encodeURIComponent\(trimmed\)\}&quantity=1/);
  assert.match(appSource,/name="quantity" type="number" min=\{1\} max=\{quantityMax\}/);
  // detected?max:null is deliberate: an unproven cap stays null so the UI can say "checked in
  // preview" and disable Max, instead of presenting the fallback 100 as if the contract said it.
  assert.match(appSource,/setMaxPerWallet\(quantityPolicy\.detected\?quantityPolicy\.max:null\)/);
});

test('dashboard pins the chosen phase identity through scheduled-task creation',()=>{
  assert.match(appSource,/function scheduleStageSelectionKey\(stage\)/);
  assert.match(appSource,/if\(uuid\)return `uuid:\$\{uuid\}`/);
  assert.match(appSource,/Number\(stage\?\.startTime\)[\s\S]*Number\(stage\?\.endTime\)/,
    'UUID-less repeated phases need their advertised times to remain distinct in the selector');
  assert.match(appSource,/const scheduledStage=stages\.find\(stage=>scheduleStageSelectionKey\(stage\)===selectedStageKey\)/);
  assert.match(appSource,/input\.stageUuid=scheduledStage\.uuid/);
  assert.match(appSource,/input\.stageLabel=scheduledStage\.label/);
  assert.match(appSource,/input\.stageType=scheduledStage\.stageType/);
  assert.match(appSource,/input\.eligibilityMode=scheduledStage\?\.eligibilityMode/);
  assert.match(appSource,/scheduleEligibilityDeadline\(input\.mintTime,scheduledStage\?\.startTime,stages\)/);
  assert.match(appSource,/saved time is the earliest attempt, not a blind launch/i);
  assert.match(appSource,/checks the live phase, current price, wallet eligibility, balance, and simulation again before sending/i);
  assert.match(appSource,/scheduleStageRequiresOpenSeaBuilder\(scheduledStage\)/);
  assert.match(appSource,/\(!detectedSeaDrop\|\|scheduleStageRequiresOpenSeaBuilder\(scheduledStage\)\)/);
  assert.match(appSource,/<SelectMenu label="Earliest attempt" value=\{selectedStageKey\}/);
  assert.match(appSource,/return \{value:scheduleStageSelectionKey\(stage\),label:`\$\{stageName\} · \$\{local\}`/);
  assert.match(openSeaScheduleDraftSource,/const requiresEligibilityCheck = stageRequiresEligibilityCheck\(stage\)/);
  assert.match(openSeaScheduleDraftSource,/eligibilityMode: requiresEligibilityCheck \? 'earliest_eligible' : 'specific_stage'/,
    'Telegram and Discord must both use the shared schedule-draft policy instead of duplicating it');
});

test('scheduled phases are checked again at the last safe pre-broadcast boundary',()=>{
  assert.match(serverSource,/function enforceEligibilityDeadline\(task, now = Date\.now\(\)\)/);
  assert.match(serverSource,/refreshScheduledPublicPhase\(task, executionChain, expectedPublicPhaseIdentity,\s*wallet\.address, resolvedFeeRecipient, livePublicDrop\.mintPriceWei\)/,
    'the final guard must re-check the same wallet, fee recipient, and price, not only the phase label');
  assert.match(serverSource,/preBroadcastGuard: expectedPhaseIdentity\s*\? async \(\) => \{/);
  assert.match(serverSource,/preBroadcastGuard: expectedPublicPhaseIdentity\s*\? async \(\) => \{/);
  assert.match(serverSource,/await governance\.checkAccountStatus\(task\.userId\)/);
  assert.match(transactionEngineSource,/if \(request\.preBroadcastGuard\) \{[\s\S]*await request\.preBroadcastGuard/);
  assert.ok(transactionEngineSource.indexOf('await request.preBroadcastGuard')
    < transactionEngineSource.indexOf('intent = await intentRepository.createSubmitted'),
  'phase deferral must happen before intent persistence so it cannot strand a fake submitted transaction');
});

test('a transient SeaDrop discovery failure does not move a schedule on unknown evidence',()=>{
  assert.match(serverSource,
    /try \{ seaDrop = await seaDropDiscoveryService\.resolve\(chain,task\.contract\); \}\s*catch \{ throw scheduleAllowanceRefreshError\(\); \}/,
    'temporary provider failure must preserve the previous stage and retry instead of weakening its allowance evidence');
});

test('a completely successful batch clears its mint draft while failed results retain it',()=>{
  assert.match(appSource,/if\(failed===0\)\{[\s\S]*setSelected\(\[\]\);setContractAddress\(''\);setQuantity\('1'\)/);
  assert.match(appSource,/Failed\/partial batches[\s\S]*deliberately keep their inputs/);
  assert.match(appSource,/completed batch was cleared to prevent an accidental repeat mint/);
  assert.match(appSource,/This drop allows one mint per wallet/);
  assert.doesNotMatch(appSource,/Run again/);
});

test('batch preview keeps eligible wallets when another wallet fails simulation',()=>{
  assert.match(appSource,/const passed=nextPreview\.items\.length/);
  assert.match(appSource,/preview\.failures\|\|\[\]/);
  assert.match(appSource,/batchPreviewModel\.canConfirm/);
  assert.match(appSource,/`Confirm and mint · \$\{batchPreviewModel\.readyCount\} \$\{batchPreviewModel\.readyCount===1\?'wallet':'wallets'\}`/);
  assert.match(appSource,/No wallet is ready to mint\./);
  assert.match(appSource,/preview\.previewToken&&<PreviewExpiry/);
});

test('scheduled lists resync after socket recovery and every scheduler retry transition',()=>{
  const sharedSource=fs.readFileSync(path.join(__dirname,'..','dashboard','src','shared.jsx'),'utf8');
  const workerSource=fs.readFileSync(path.join(__dirname,'..','src','scheduler','schedulerWorker.js'),'utf8');
  assert.match(sharedSource,/type==='ws\.reconnected'/);
  assert.match(sharedSource,/connectedOnce\|\|needsResync/);
  assert.match(sharedSource,/setTimeout\(connect,delay\)/);
  assert.equal((workerSource.match(/outcome: 'retry'/g)||[]).length>=2,true);
  assert.match(serverSource,/\['starting','retry','paused','success','failure','failed'\]\.includes\(event\.outcome\)[\s\S]*type:'tasks\.changed'/);
});

test('scheduled countdown labels advance without polling the API',()=>{
  assert.match(appSource,/setInterval\(\(\)=>setScheduleNow\(Date\.now\(\)\),15_000\)/);
  assert.match(appSource,/scheduleCountdown\(task\.mintTime,scheduleNow\)/);
});

test('mint preview turns insufficient balance diagnostics into a short actionable message',async()=>{
  const feedback=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  const result=feedback.mintPreviewError({code:'SIMULATION_FAILED',message:'This wallet cannot cover the mint price plus the network fee on robinhood (0xabc). Both are paid together.'},{chain:'robinhood',quantity:1});
  assert.deepEqual(result,{title:'Not enough ETH for this mint.',detail:'Fund this wallet or use another wallet with enough balance.'});
  assert.equal(JSON.stringify(result).includes('400'),false);
  assert.equal(JSON.stringify(result).includes('0xabc'),false);
});

test('mint preview only suggests lowering quantity when that is possible',async()=>{
  const {mintPreviewError}=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  const error={code:'INSUFFICIENT_BALANCE'};
  assert.equal(mintPreviewError(error,{chain:'ethereum',quantity:2}).detail,'Fund this wallet, use another wallet with enough balance, or lower the quantity.');
  assert.equal(mintPreviewError(error,{chain:'ethereum',quantity:1}).detail,'Fund this wallet or use another wallet with enough balance.');
  assert.equal(mintPreviewError({code:'VALUE_CEILING_EXCEEDED'},{quantity:1}).detail,'Increase the wallet limit before trying again.');
  assert.equal(mintPreviewError({code:'VALUE_CEILING_EXCEEDED'},{quantity:2}).detail,'Lower the quantity or increase the wallet limit.');
  assert.equal(mintPreviewError({code:'DAILY_BUDGET_EXCEEDED'},{quantity:1}).detail,'Wait for the limit to reset or use another wallet.');
  assert.equal(mintPreviewError({code:'DAILY_BUDGET_EXCEEDED'},{quantity:2}).detail,'Lower the quantity, wait for the limit to reset, or use another wallet.');
});

test('mint preview explains a wallet-specific mint allowance concisely',async()=>{
  const {mintPreviewError}=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  assert.deepEqual(mintPreviewError({code:'SIMULATION_FAILED',message:'This wallet would hold 3, exceeding the 2 allowed per wallet.'},{quantity:2}),
    {title:'This wallet can mint 1 more.',detail:'Lower its quantity to 1 or use another wallet.'});
  assert.deepEqual(mintPreviewError({code:'SIMULATION_FAILED',message:'This wallet would hold 3, exceeding the 2 allowed per wallet.'},{quantity:1}),
    {title:"This wallet has reached this mint's limit.",detail:'Use another eligible wallet.'});
});

test('mint preview uses OpenSea exhaustion codes instead of a generic failure',async()=>{
  const {mintPreviewError}=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  assert.deepEqual(mintPreviewError({code:'WALLET_MINT_LIMIT_REACHED',message:'wallet mint limit reached'}),
    {title:"This wallet has reached this mint's limit.",detail:'Use another eligible wallet. No transaction was sent.'});
  assert.deepEqual(mintPreviewError({code:'STAGE_SUPPLY_EXHAUSTED',message:'stage supply exhausted'}),
    {title:'This mint stage is sold out.',detail:'No transaction was sent.'});
  assert.deepEqual(mintPreviewError({code:'MINT_SOLD_OUT',message:'collection sold out'}),
    {title:'This mint is sold out.',detail:'No transaction was sent.'});
});

test('mint preview gives concise next steps for common safety failures',async()=>{
  const {mintPreviewError}=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  assert.deepEqual(mintPreviewError({code:'GAS_CEILING_EXCEEDED'},{chain:'robinhood'}),{title:'Gas is above your limit.',detail:'Raise the wallet gas limit before trying again.'});
  assert.deepEqual(mintPreviewError({code:'SIMULATION_FAILED',message:'execution reverted'},{chain:'robinhood'}),{title:'This mint would fail.',detail:'Check the price, quantity, mint method, and opening time, then try again.'});
});

test('Mint now invalidates stale previews and ignores out-of-order simulation responses',()=>{
  assert.match(appSource,/const simulationSequence=useRef\(0\)/);
  assert.match(appSource,/function invalidateMintPreview[\s\S]*simulationSequence\.current\+=1[\s\S]*setPreview\(null\)/);
  assert.match(appSource,/if\(simulationSequence\.current!==requestSequence\)return;[\s\S]*setPreview\(nextPreview\)/);
  assert.match(appSource,/onChange=\{e=>\{setWalletLabel\(e\.target\.value\);invalidateMintPreview\(\);\}\}/);
  assert.match(appSource,/setQuantity\(e\.target\.value\);invalidateMintPreview\(\);autoDetectIfReady/);
  assert.match(appSource,/setPriceEth\(e\.target\.value\);invalidateMintPreview\(\)/);
});

test('Mint now shows the exact wallet balance and preserves an expired preview for re-simulation',()=>{
  assert.match(transactionEngineSource,/balanceWei:BigInt\(balance\),estimatedGasCostWei,estimatedCostWei/);
  assert.match(appSource,/function MintTransactionPreview[\s\S]*<tr><td>Wallet balance<\/td><td style=\{\{color:metrics\.balanceInsufficient\?'var\(--loss-text\)'/);
  assert.match(appSource,/previewExpired\?'Expired'/);
  assert.match(appSource,/Quote expired · re-simulate above/);
  assert.match(appSource,/onExpire=\{\(\)=>\{setPreviewExpired\(true\)/);
});

test('transaction previews keep decision data compact and move technical details behind disclosure',()=>{
  assert.match(appSource,/function MintTransactionPreview/);
  for(const label of ['Name','Chain','Quantity','Mint price','Est. gas','Wallet balance','Simulation','Total debit']){
    assert.match(singlePreviewSource,new RegExp(`<tr(?:\\s[^>]*)?><td>${label.replace('.','\\.')}`));
  }
  assert.doesNotMatch(singlePreviewSource,/<tr><td>Method<\/td>/,
    'the contract method is technical context, not a primary mint decision row');
  assert.match(singlePreviewSource,/<summary>Technical details<\/summary>/);
  assert.match(singlePreviewSource,/mint-technical-row[\s\S]*<span>Method<\/span>/);
  assert.equal((appSource.match(/<MintTransactionPreview/g)||[]).length,1,
    'Batch must not repeat the full transaction ledger for every wallet');
  assert.match(batchComponentSource,/Batch transaction preview/);
  assert.match(batchComponentSource,/aria-label=\{`Simulation: \$\{statusLabel\}`\}/);
  assert.match(batchComponentSource,/sharedIssue\.scope==='system'\?'Network check unavailable':'Mint needs attention'/,
    'a shared mint or network cause must replace a misleading all-wallets-blocked label');
  assert.match(batchComponentSource,/sharedIssue\?'wn':model\.readyCount===0\?'bad':model\.blockedCount\?'wn':'ok'/,
    'a partially-ready batch is a warning, not a total failure');
  for(const label of ['Name','Chain','Quantity per wallet','Mint value · ready','Total estimated gas','Combined balance','Total estimated debit']){
    assert.match(batchComponentSource,new RegExp(label));
  }
  assert.doesNotMatch(batchComponentSource,/<tr><td>Wallets<\/td>/);
  assert.doesNotMatch(batchComponentSource,/<tr><td>Simulation<\/td>/,
    'the ready/blocked header is the batch simulation summary');
  assert.match(batchComponentSource,/One wallet cannot pay another wallet’s mint/);
  assert.match(batchComponentSource,/aria-label="Why wallet balances are separate"[\s\S]*aria-describedby="batch-balance-help-primary"/,
    'the no-pooling explanation must work from a real keyboard and touch-friendly button');
  assert.match(batchComponentSource,/detectedMethods=\[\.\.\.new Set\(model\.rows\.map\(row=>row\.methodSignature\)/,
    'the aggregate reads the prepared call method even when OpenSea detection has no form-level method');
  assert.match(batchComponentSource,/zeroLabel:'Free'/);
  assert.match(batchComponentSource,/aria-expanded=\{detailsOpen\}/);
  assert.match(batchComponentSource,/className="batch-detail-panel"[^>]*role="region"[^>]*tabIndex="0"[^>]*aria-label="Wallet preview details"/,
    'the internally scrolling details region must be keyboard-focusable');
  assert.match(batchComponentSource,/batch-technical-line[\s\S]*<span>Method<\/span>/);
  assert.match(batchComponentSource,/batch-wallet-technical[\s\S]*chainMeta\(row\.chain\)[\s\S]*row\.methodSignature/,
    'mixed chains or methods promised by the summary must be visible inside wallet details');
  assert.match(batchComponentSource,/batch-wallet-detail-card \$\{stateClass\}/);
  assert.match(batchComponentSource,/reasonIsGrouped[\s\S]*row\.reason&&!reasonIsGrouped/,
    'a safely classified common issue is explained once, not repeated on every wallet');
  assert.match(batchComponentSource,/batch-wallet-detail-balance/);
  assert.doesNotMatch(batchComponentSource,/batch-wallet-detail-metrics/,
    'the glanceable wallet cards show name and balance without repeating debit on every wallet');
  assert.doesNotMatch(batchComponentSource,/batch-wallet-table/,
    'wallet details must wrap as cards instead of requiring a horizontally scrolling table');
  assert.match(stylesSource,/\.batch-wallet-details\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,9rem\),1fr\)\)/);
  assert.match(stylesSource,/\.batch-detail-panel\{[^}]*overflow-y:auto;overflow-x:hidden/);
  assert.doesNotMatch(stylesSource,/\.batch-wallet-table\{[^}]*min-width:32rem/);
  assert.match(stylesSource,/\.batch-wallet-detail-card\.is-ready\{border-left-color:var\(--success\)/);
  assert.match(stylesSource,/\.batch-wallet-detail-card\.is-blocked\{border-left-color:var\(--warn\)/);
  assert.match(stylesSource,/\.batch-wallet-detail-card\.is-shared\{border-left-color:var\(--info\)/);
  assert.match(batchPreviewSource,/BigInt\(value\)/);
  assert.match(batchPreviewSource,/const key=`\$\{row\.chain\|\|'unknown'\}:\$\{row\.symbol\}`/);
  assert.match(appSource,/nativeBalance\(wallet,detectedChain,preferredChain\)/,
    'before detection Batch uses the funded headline, then switches to the detected-chain balance');
});

test('mobile wallet selectors stay anchored beside the taller quantity control',()=>{
  assert.ok((appSource.match(/mint-wallet-quantity-row/g)||[]).length>=2,
    'Mint now and Schedule must use the same anti-stretch row');
  assert.match(stylesSource,/\.app\[data-m\] \.mint-wallet-quantity-row>\.select-menu\{align-self:start\}/);
  assert.match(stylesSource,/\.select-menu-panel\{position:absolute;top:calc\(100% \+ \.4rem\)/,
    'the normal popup offset stays intact once the stretched grid item is fixed');
});

test('Batch result rows preserve broadcast truth instead of calling every non-success a failure',()=>{
  for(const outcome of ['skipped_preflight','failed_prebroadcast','reverted','replaced','unknown','pending','submitted']){
    assert.match(appSource,new RegExp(outcome));
  }
  assert.match(appSource,/label:'Checking'/);
  assert.match(appSource,/label:'Not submitted'/);
  assert.match(appSource,/be checked before retrying/);
  assert.match(appSource,/explorerForChain\(entry\.chain\|\|detectedChain\)/);
  assert.match(appSource,/>View transaction<\/a>/);
  assert.match(appSource,/batch-result-row/);
  assert.match(apiSource,/mapWithConcurrency\(value\.entries,DASHBOARD_BATCH_CONCURRENCY/);
  assert.match(apiSource,/for\(const value of completed\)void Promise\.resolve/);
  assert.doesNotMatch(appSource,/The \$\{resultCount-succeeded===1\?'other':'others'\} never left the server/);
});

test('Batch keeps an expired quote visible and blocks confirmation until it is re-simulated',()=>{
  assert.match(appSource,/function MintBatch[\s\S]*const \[previewExpired,setPreviewExpired\]=useState\(false\)/);
  assert.match(appSource,/if\(busy\|\|submitting\|\|previewExpired\)return/);
  assert.match(appSource,/Batch preview expired\. Re-simulate before confirming\./);
  assert.match(appSource,/disabled=\{formLocked\|\|previewExpired\}/);
  assert.doesNotMatch(appSource,/onExpire=\{\(\)=>setPreview\(null\)\}/);
});

test('money surfaces use adaptive precision so a real non-zero value never displays as zero',()=>{
  const pnlBars=fs.readFileSync(path.join(__dirname,'..','dashboard','src','PnlBars.jsx'),'utf8');
  assert.match(appSource,/function weiAmountText[\s\S]*formatAdaptiveAmount/);
  assert.match(appSource,/Confirm and mint · \$\{weiAmountText\(totalDebitWei\)\}/);
  assert.match(pnlBars,/formatSignedAdaptiveAmount/);
  assert.doesNotMatch(pnlBars,/toFixed\(/);
});

test('a clamped mint quantity is detected again before its calldata can be previewed',()=>{
  assert.match(appSource,/if\(quantityPolicy\.detected&&Number\(effectiveQuantity\)>quantityPolicy\.max\)[\s\S]*await detect\(trimmed,legalQuantity\)/);
  assert.match(appSource,/if\(quantityPolicy\.detected&&Number\(quantityOverride\)>quantityPolicy\.max\)[\s\S]*await detectPrice\(trimmed,legalQuantity\)/);
});

test('all dashboard mint surfaces use a per-item detected price',()=>{
  assert.match(appSource,/mintDetectionPricePerItem\(result,effectiveQuantity\)/);
  assert.match(appSource,/mintDetectionPricePerItem\(result,quantityOverride\)/);
  assert.match(appSource,/mintDetectionPricePerItem\(result,1\)/);
  assert.match(botCommandSource,/priceWeiPerItem:/);
});

test('paid Mint now and Batch requests convert per-item price to total value exactly once',()=>{
  assert.ok((appSource.match(/mintTotalValueWei\(perItemValueWei,quantity\)/g)||[]).length>=2);
  assert.match(appSource,/const valueWei=activePresetName\|\|viaOpenSea\?'0':mintTotalValueWei/);
  assert.match(appSource,/const valueWei=viaOpenSea\?'0':mintTotalValueWei/);
  assert.match(appSource,/valueWei===null[\s\S]*Check the quantity and mint price\.[\s\S]*setMintError\(warning\)/,
    'invalid numeric values must remain visible in the preview surface instead of only flashing a toast');
});

test('using a saved preset reuses its validated payload instead of only copying the address',()=>{
  assert.match(appSource,/setPendingMintPrefill\(\{\.\.\.preset,presetName:preset\.name\}\)/);
  assert.match(appSource,/setActivePresetName\(prefill\.presetName\)/);
  assert.match(appSource,/activePresetName\?\{walletLabel:raw\.walletLabel,presetName:activePresetName\}/);
});

test('Batch exposes unknown-price entry and persistent simulation or confirmation errors',()=>{
  assert.match(appSource,/priceEntryRequired&&<label className="fl"><span>Price per mint/);
  assert.match(appSource,/batchError&&<div className="nt w" role="status">/);
  assert.match(appSource,/setPreview\(null\);setPreviewExpired\(false\);setBatchError\(friendly\)/);
});

test('Schedule requires current detection and leaves allowance enforcement to the atomic server reservation',()=>{
  assert.match(appSource,/lastDetected\.current!==currentAddress\.toLowerCase\(\)/);
  assert.doesNotMatch(appSource,/pendingSum\+requestedQuantity>maxPerWallet/);
  assert.doesNotMatch(appSource,/api\(`\/api\/tasks\?status=pending&pageSize=50`\)/);
  assert.match(appSource,/input\.stageStartAt=new Date\(scheduledStage\.startTime\*1000\)\.toISOString\(\)/);
  assert.match(appSource,/const hasPhaseIdentity=Boolean\(input\.stageUuid\|\|input\.stageLabel\|\|input\.stageType\)/);
  assert.match(appSource,/if\(input\.mintTime&&hasPhaseIdentity\)/);
  assert.match(appSource,/scheduleError&&<div className="nt w" role="status">/);
  assert.doesNotMatch(appSource,/mintQuantityPolicy\(chosenStage\?\.maxPerWallet/);
});

test('Schedule shows specific reservation outcomes and never echoes the generic 500 text',async()=>{
  const {scheduleSubmitError}=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  assert.deepEqual(scheduleSubmitError({code:'SCHEDULE_STAGE_DUPLICATE',
    issues:[{field:'stageUuid',message:'this wallet already has an active mint scheduled for this stage'}]}),{
    title:'This mint is already scheduled.',
    detail:'this wallet already has an active mint scheduled for this stage'
  });
  assert.deepEqual(scheduleSubmitError({code:'SCHEDULE_ALLOWANCE_EXCEEDED',
    details:{remaining:'1'}}),{
    title:'This quantity is above the wallet limit.',
    detail:'This wallet can schedule 1 more for the selected mint stages.'
  });
  assert.deepEqual(scheduleSubmitError({status:500,code:'INTERNAL_ERROR',
    message:'Request failed safely',requestId:'abc123'}),{
    title:'Scheduling is temporarily unavailable.',
    detail:'Try again in a moment. Nothing was scheduled. Reference: abc123.'
  });
  assert.match(appSource,/scheduleSubmitError\(value\)/);
});

test('Schedule translates a stage-time mismatch into a useful instruction',async()=>{
  const {scheduleSubmitError}=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  assert.deepEqual(scheduleSubmitError({issues:[{field:'stageStartAt',message:'must not be after mintTime'}]}),{
    title:'The mint time is before this stage opens.',
    detail:'Use the detected opening time or choose a later time.'
  });
});

test('scheduled auxiliary reads and activity use the persisted execution chain',()=>{
  assert.match(serverSource,/function taskExecutionChain\(task, wallet = null\)/);
  assert.match(serverSource,/detectMintContract\(task\.userId,\{contractAddress:task\.contract,[\s\S]*chain:taskExecutionChain\(task,wallet\)\}/);
  assert.match(serverSource,/getBalance:\s*\(task,\s*wallet\)\s*=>\s*providerService\.perform\(taskExecutionChain\(task,\s*wallet\)/);
  assert.match(serverSource,/SCHEDULE_REMINDER_GAS_UNITS\s*\*\s*BigInt\(feePerGas\)/);
});

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const {mintPriceStep}=require('../src/discord/menus');
const {pathToFileURL}=require('node:url');

const appSource=fs.readFileSync(path.join(__dirname,'..','dashboard','src','App.jsx'),'utf8');
const serverSource=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
const discordSource=fs.readFileSync(path.join(__dirname,'..','src','discord','discordBot.js'),'utf8');
const transactionEngineSource=fs.readFileSync(path.join(__dirname,'..','src','transactions','transactionEngine.js'),'utf8');

test('dashboard address detection deduplicates overlapping paste and blur requests',()=>{
  assert.match(appSource,/requestKey===lastDetected\.current\|\|requestKey===detectingKey\.current/);
  assert.match(appSource,/detectingKey\.current=requestKey;[\s\S]*await api\(`\/api\/mints\/detect/);
});

test('dashboard waits for an unknown price instead of raising a red simulation error',()=>{
  assert.match(appSource,/\(!viaOpenSea&&priceEth===''\)\)return/);
  assert.match(appSource,/Mint price needed\.<\/b> Enter the price per NFT to continue/);
  assert.doesNotMatch(appSource,/Price \(ETH\) must be a plain non-negative number/);
});

test('notification bell records toast messages without rendering a second pop-up',()=>{
  assert.match(appSource,/subscribeNotificationLog\(setLog\)/);
  assert.doesNotMatch(appSource,/bell-auto-preview/);
});

test('dashboard mint completion records the chain actually prepared, not the wallet default chain',()=>{
  assert.match(serverSource,/recordMintActivity\(\{ userId, wallet, quantity: previewQuantity\(prepared\.preview\), intent, chain: prepared\.chain \}\)/);
  assert.doesNotMatch(serverSource,/recordMintActivity\(\{ userId, wallet, quantity: previewQuantity\(prepared\.preview\), intent, chain: wallet\.chain \}\)/);
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
  assert.match(appSource,/arguments:viaOpenSea\?\[\]:detectedArguments,valueWei:viaOpenSea\?'0'/);
  assert.match(serverSource,/viaOpenSea: flowData\.viaOpenSea === true/);
  assert.match(discordSource,/viaOpenSea: flowData\.viaOpenSea === true/);
});

test('batch simulation waits for contract detection and uses the detected per-wallet maximum',()=>{
  assert.match(appSource,/disabled=\{busy\|\|detecting\|\|!enoughSelected\}/);
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
  assert.match(appSource,/input\.eligibilityMode=scheduledViaOpenSea\?'earliest_eligible':'specific_stage'/);
  assert.match(appSource,/const notBeforeMs=Number\.isFinite\(selectedStageStart\)\?Math\.max\(startMs,selectedStageStart\):startMs/);
  assert.match(appSource,/const deadlineCap=notBeforeMs\+24\*60\*60\*1000/);
  assert.match(appSource,/Math\.min\(latestAdvertisedEnd,deadlineCap\)/);
  assert.match(appSource,/scheduled time is the earliest attempt, not a blind launch/i);
  assert.match(appSource,/scheduleStageRequiresOpenSeaBuilder\(scheduledStage\)/);
  assert.match(appSource,/\(!detectedSeaDrop\|\|scheduleStageRequiresOpenSeaBuilder\(scheduledStage\)\)/);
  assert.match(appSource,/value=\{selectionKey\}/);
  assert.match(serverSource,/const viaOpenSea = !mintFlowData\.isSeaDrop \|\| needsOpenSeaEligibility\(stage\.stageType\)/);
  assert.match(serverSource,/eligibilityMode: viaOpenSea \? 'earliest_eligible' : 'specific_stage'/);
  assert.match(discordSource,/eligibilityMode: viaOpenSea \? 'earliest_eligible' : 'specific_stage'/);
});

test('scheduled phases are checked again at the last safe pre-broadcast boundary',()=>{
  assert.match(serverSource,/function enforceEligibilityDeadline\(task, now = Date\.now\(\)\)/);
  assert.match(serverSource,/refreshScheduledPublicPhase\(task, executionChain, expectedPublicPhaseIdentity\)/);
  assert.match(serverSource,/preBroadcastGuard: expectedPhaseIdentity/);
  assert.match(serverSource,/preBroadcastGuard: expectedPublicPhaseIdentity/);
  assert.match(transactionEngineSource,/if \(request\.preBroadcastGuard\) \{[\s\S]*await request\.preBroadcastGuard/);
  assert.ok(transactionEngineSource.indexOf('await request.preBroadcastGuard')
    < transactionEngineSource.indexOf('intent = await intentRepository.createSubmitted'),
  'phase deferral must happen before intent persistence so it cannot strand a fake submitted transaction');
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
  assert.match(appSource,/Confirm and mint · \{preview\.items\.length\}/);
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
  assert.match(serverSource,/\['starting','retry','success','failure','failed'\]\.includes\(event\.outcome\)[\s\S]*type:'tasks\.changed'/);
});

test('scheduled countdown labels advance without polling the API',()=>{
  assert.match(appSource,/setInterval\(\(\)=>setScheduleNow\(Date\.now\(\)\),15_000\)/);
  assert.match(appSource,/const ms=at\.getTime\(\)-scheduleNow/);
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

test('mint preview gives concise next steps for common safety failures',async()=>{
  const {mintPreviewError}=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  assert.deepEqual(mintPreviewError({code:'GAS_CEILING_EXCEEDED'},{chain:'robinhood'}),{title:'Gas is above your limit.',detail:'Raise the wallet gas limit before trying again.'});
  assert.deepEqual(mintPreviewError({code:'SIMULATION_FAILED',message:'execution reverted'},{chain:'robinhood'}),{title:'This mint would fail.',detail:'Check the price, quantity, mint method, and opening time, then try again.'});
});

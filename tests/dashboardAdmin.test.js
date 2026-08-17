const assert=require('node:assert/strict');
const http=require('node:http');
const test=require('node:test');
const express=require('express');
const {createDashboardApi,mountDashboardRoutes}=require('../src/dashboard/api');
const {createAdminCommandService}=require('../src/governance/adminCommandService');
const {createGovernanceService}=require('../src/governance/governanceService');
const {createCommandRateLimiter}=require('../src/security/botSecurity');
const {defaultPolicy}=require('../src/transactions/defaults');

function fixture(){const users=new Map([['owner',{userId:'owner',isOwner:true,platform:'telegram',platformUserId:'1'}],['member',{userId:'member',isOwner:false,platform:'telegram',platformUserId:'2'}]]);const groups=new Map();const rules=new Map();const presets=[{key:'ultra_fast',displayName:'Ultra Fast',simulationMode:'off',confirmationCount:1,humanVerification:'bypass'}];const repository={
  isOwner:async id=>users.get(id)?.isOwner===true,isRootOwner:async id=>users.get(id)?.isOwner===true,findUserByPlatform:async(platform,id)=>[...users.values()].find(user=>user.platform===platform&&user.platformUserId===String(id))?.userId||null,
  async setOwner(id,enabled){const current=users.get(id);if(!enabled&&current.isOwner&&[...users.values()].filter(user=>user.isOwner).length<=1)throw new Error('Cannot remove the last owner');current.isOwner=enabled;return current;},
  async upsertGroup(value){groups.set(value.name.toLowerCase(),{...value});return value;},async deleteGroup(name){return groups.delete(name.toLowerCase());},
  async assignGroup(userId,name){if(!groups.has(name.toLowerCase()))throw new Error('Group not found');rules.set(userId,{...(rules.get(userId)||{}),groupName:name.toLowerCase()});},async removeGroup(userId){rules.set(userId,{...(rules.get(userId)||{}),groupName:null});},
  async setUserCeilings(value){rules.set(value.userId,{...(rules.get(value.userId)||{}),...value});},async setUserSimulation(value){rules.set(value.userId,{...(rules.get(value.userId)||{}),simulationForced:value.simulationForced});},
  async setGroupSimulation(name,value){const group=groups.get(name.toLowerCase());if(!group)throw new Error('Group not found');group.simulationForced=value;},async updatePreset(value){return value;},async selectPreset(){},async listPresets(){return presets;},
  async listGroups(){return [...groups.values()].map(group=>({name:group.name,maxTransactionValueWei:String(group.maxTransactionValueWei),dailySpendingBudgetWei:String(group.dailySpendingBudgetWei),gasCeilingGwei:group.gasCeilingGwei,simulationForced:group.simulationForced}));},
  async listGovernedUsers(){return [...users.values()].map(user=>({userId:user.userId,isOwner:user.isOwner,groupName:rules.get(user.userId)?.groupName||null,linkedAccounts:[{platform:user.platform,platformUserId:user.platformUserId}]}));},
  async getAdminOverviewMetrics(){return {totalUsers:users.size,activeUsers:1,activeAnyPlatform24h:1,linkedAccounts:users.size,groups:groups.size,owners:[...users.values()].filter(user=>user.isOwner).length,activeWindowMinutes:15};},
  async getEffectiveGovernance(userId,chain){const user=users.get(userId);const rule=rules.get(userId)||{};const group=groups.get(rule.groupName);const defaults=defaultPolicy(chain);return {isOwner:user.isOwner,maxTransactionValueWei:BigInt(rule.maxTransactionValueWei??group?.maxTransactionValueWei??defaults.maxTransactionValueWei),dailySpendingBudgetWei:BigInt(rule.dailySpendingBudgetWei??group?.dailySpendingBudgetWei??defaults.dailySpendingBudgetWei),gasCeilingGwei:Number(rule.gasCeilingGwei??group?.gasCeilingGwei??defaults.gasCeilingGwei),simulationForced:rule.simulationForced??group?.simulationForced??true,preset:null};},
 };return {repository,users,groups,rules};}

async function server(t){const data=fixture();const governance=createGovernanceService(data.repository);const admin=createAdminCommandService(governance);const audits=[];const broadcasts=[];const sessions=new Map([['owner',{userId:'owner',sessionId:'session-owner'}],['member',{userId:'member',sessionId:'session-member'}]]);const commands={admin:(id,input)=>admin.execute(id,input),adminOverview:id=>governance.dashboardOverview(id),adminEffective:(id,input)=>governance.effectiveForLinkedUser(id,input),isOwner:id=>data.repository.isOwner(id)};const auth={authenticate:async header=>sessions.get(String(header||'').split('=')[1])||null,verifyCsrf:({headerToken})=>headerToken==='csrf',sessionCookies:()=>[],clearCookies:()=>[],revoke:async()=>{},revokeAll:async()=>{}};const api=createDashboardApi({auth,commands,securityAudit:{record:async value=>audits.push(value)},broadcast:(userId,message)=>broadcasts.push({userId,message}),broadcastToUsers:(userIds,message)=>userIds.forEach(userId=>broadcasts.push({userId,message})),supportedChains:['ethereum'],identityRepository:{listLinkedAccounts:async()=>[],getTheme:async()=>'ghost-mint'},loginRateLimiter:createCommandRateLimiter()});const app=express();app.use(express.json());app.use(api.securityHeaders);mountDashboardRoutes(app,api);app.use(api.error);const httpServer=http.createServer(app);await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>httpServer.close(resolve)));return {...data,audits,broadcasts,base:`http://127.0.0.1:${httpServer.address().port}`};}
function headers(user='owner'){return {cookie:`ghostmint_session=${user}`,'content-type':'application/json','x-csrf-token':'csrf'};}
async function write(base,user,action,body){return fetch(`${base}/api/admin/${action}`,{method:'POST',headers:headers(user),body:JSON.stringify(body)});}

test('every dashboard admin write rejects a non-owner session',async t=>{const {base}=await server(t);const cases=[['group-set',{name:'G',maxWei:'1',dailyWei:'2',gasGwei:'3',simulation:'forced'}],['group-delete',{name:'G',confirmation:'CONFIRM'}],['assign',{platform:'telegram',platformUserId:'2',group:'G'}],['unassign',{platform:'telegram',platformUserId:'2'}],['user-ceilings',{platform:'telegram',platformUserId:'2',maxWei:'1',dailyWei:'2',gasGwei:'3'}],['user-ceilings-clear',{platform:'telegram',platformUserId:'2'}],['user-simulation',{platform:'telegram',platformUserId:'2',simulation:'forced'}],['group-simulation',{group:'G',simulation:'forced'}],['preset-set',{preset:'safe',simulation:'on',confirmations:'12',verification:'on'}],['owner',{platform:'telegram',platformUserId:'2',enabled:'on',confirmation:'CONFIRM'}]];for(const [action,body] of cases)assert.equal((await write(base,'member',action,body)).status,403,action);});

test('owner overview returns truthful database-backed identity and activity metrics',async t=>{const {base}=await server(t);const response=await fetch(`${base}/api/admin`,{headers:headers()});assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.metrics,{totalUsers:2,activeUsers:1,activeAnyPlatform24h:1,linkedAccounts:2,groups:0,owners:1,activeWindowMinutes:15});assert.equal(body.users.length,2);});

test('last owner cannot be removed through the dashboard API',async t=>{const {base}=await server(t);const response=await write(base,'owner','owner',{platform:'telegram',platformUserId:'1',enabled:'off',confirmation:'CONFIRM'});assert.equal(response.status,400);assert.match(JSON.stringify(await response.json()),/last owner/i);});

// Regression test: unban/unsuspend/reactivate could previously be called with no confirmation field
// at all, unlike their forward counterparts ban/suspend/deactivate (and owner/group-delete/merge-account),
// which all required an explicit CONFIRM. Restoring an account's access is not obviously lower-stakes
// than restricting it, so the confirmation gate is now symmetric. group-delete (already gated, and
// fully mocked in this fixture) establishes what a missing-confirmation rejection actually looks like;
// the three lifecycle-restore actions must be rejected the same way, before ever reaching adminCommandService
// (whose mock repository here has no unbanUser/unsuspendUser/reactivateUser -- if confirmation weren't
// enforced first, these calls would throw for an unrelated reason and this test would still pass for
// the wrong reason, so the status code is compared directly against the known-gated baseline).
test('unban, unsuspend, and reactivate require the same explicit CONFIRM as ban, suspend, and deactivate',async t=>{
  const {base}=await server(t);
  const baseline=await write(base,'owner','group-delete',{name:'nonexistent'});
  assert.notEqual(baseline.status,200,'sanity check: a known-gated action without confirmation must not succeed');
  for(const action of ['unban','unsuspend','reactivate']){
    const response=await write(base,'owner',action,{platform:'telegram',platformUserId:'2',reason:'test'});
    assert.equal(response.status,baseline.status,`${action} without confirmation must be rejected the same way group-delete is`);
  }
});

// Regression test: adminInput() re-encodes the dashboard's structured JSON body into the same
// whitespace-joined command string Telegram/Discord raw text produces, then adminCommandService
// re-splits it on whitespace. A group name submitted as "VIP Members" used to silently become
// name="VIP" with every field after it (the real ceiling values) shifted one slot to the right --
// gasGwei's value landing in simulation, etc. -- surfacing only as a confusing, unrelated validation
// error deep in governanceService (or worse, if the shifted values happened to all still parse as
// valid numbers, succeeding with silently wrong ceilings). This must now be rejected immediately,
// naming the actual field, before the join ever happens. A hyphenated name must still work exactly
// as before -- this isn't a ban on the characters just typing rendered as spaces.
test('a group name containing a space is rejected before it can corrupt the fields after it, but a hyphenated name still works',async t=>{
  const {base}=await server(t);
  const spaced=await write(base,'owner','group-set',{name:'VIP Members',maxWei:'100',dailyWei:'200',gasGwei:'10',simulation:'optional'});
  assert.equal(spaced.status,400);
  const spacedBody=await spaced.json();
  assert.equal(spacedBody.issues?.[0]?.field,'name');
  assert.doesNotMatch(JSON.stringify(spacedBody),/non-negative integer/i,
    'must fail as a clear "no spaces" error on the name field, not a confusing downstream wei-parsing error');

  const hyphenated=await write(base,'owner','group-set',{name:'VIP-Members',maxWei:'100',dailyWei:'200',gasGwei:'10',simulation:'optional',advancedModes:'not-allowed'});
  assert.equal(hyphenated.status,200);
});

test('group edits immediately change an assigned user effective ceiling and successful writes are audited',async t=>{const {base,audits}=await server(t);assert.equal((await write(base,'owner','group-set',{name:'Standard',maxWei:'100',dailyWei:'200',gasGwei:'10',simulation:'optional',advancedModes:'not-allowed'})).status,200);assert.equal((await write(base,'owner','assign',{platform:'telegram',platformUserId:'2',group:'Standard'})).status,200);let effective=await (await fetch(`${base}/api/admin/effective?platform=telegram&platformUserId=2&chain=ethereum`,{headers:headers()})).json();assert.equal(effective.gasCeilingGwei,10);assert.equal((await write(base,'owner','group-set',{name:'standard',maxWei:'100',dailyWei:'200',gasGwei:'25',simulation:'optional',advancedModes:'not-allowed'})).status,200);effective=await (await fetch(`${base}/api/admin/effective?platform=telegram&platformUserId=2&chain=ethereum`,{headers:headers()})).json();assert.equal(effective.gasCeilingGwei,25);assert.equal(audits.length,3);assert.ok(audits.every(value=>value.platform==='dashboard'&&value.outcome==='success'));});

test('effective governance reports owners as exempt instead of numeric ceilings',async t=>{const {base}=await server(t);const effective=await (await fetch(`${base}/api/admin/effective?platform=telegram&platformUserId=1&chain=ethereum`,{headers:headers()})).json();assert.equal(effective.isOwner,true);assert.equal(effective.ceilingExempt,true);assert.equal(effective.maxTransactionValueWei,null);assert.equal(effective.dailySpendingBudgetWei,null);assert.equal(effective.gasCeilingGwei,null);});

test('a successful admin write broadcasts admin.changed to the acting owner so open admin tabs can live-refresh',async t=>{const {base,broadcasts}=await server(t);assert.equal((await write(base,'owner','group-set',{name:'Standard',maxWei:'100',dailyWei:'200',gasGwei:'10',simulation:'optional',advancedModes:'not-allowed'})).status,200);assert.equal(broadcasts.length,1);assert.equal(broadcasts[0].userId,'owner');assert.deepEqual(broadcasts[0].message,{type:'admin.changed'});});

test('a failed admin write does not broadcast a change',async t=>{const {base,broadcasts}=await server(t);assert.equal((await write(base,'owner','assign',{platform:'telegram',platformUserId:'2',group:'NoSuchGroup'})).status,400);assert.equal(broadcasts.length,0);});

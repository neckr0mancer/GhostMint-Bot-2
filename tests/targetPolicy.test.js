const assert=require('node:assert/strict');
const test=require('node:test');
const {createTargetPolicyService}=require('../src/triggers/targetPolicyService');
const {createTriggerExecutionService}=require('../src/triggers/triggerExecutionService');

const A='123e4567-e89b-42d3-a456-426614174000';
const B='223e4567-e89b-42d3-a456-426614174000';
function fixture(){
 const policies=new Map(),challenges=new Map(),requests=new Map(),audits=[];
 const key=(u,t,id)=>`${u}:${t}:${id}`;
 const repository={
  async get(u,t,id){return policies.get(key(u,t,id))||null;},async save(v){policies.set(key(v.userId,v.targetType,v.targetId),{...v});return{...v};},
  async reset(u,t,id){policies.delete(key(u,t,id));for(const [challengeId,c] of challenges)if(c.userId===u&&c.targetType===t&&c.targetId===id)challenges.delete(challengeId);},async createChallenge(v){const id=`c-${challenges.size}`;challenges.set(id,{...v,target_type:v.targetType,target_id:v.targetId,dont_ask_again:v.dontAskAgain});return id;},
  async consumeChallenge(u,id){const c=challenges.get(id);if(!c||c.userId!==u||c.used)return null;c.used=true;return c;},
  async createRequest(v){const value={...v,id:`r-${requests.size}`,executionPayload:v.executionPayload};requests.set(value.id,value);return value;},
  async claimRequest(u,id){const r=requests.get(id);return r&&r.userId===u?r:null;},async finishRequest(){},async addAudit(v){audits.push(v);},async listAudit(){return audits;},
 };
 const governanceCalls=[];
 const policyService=createTargetPolicyService({repository,targetExists:async()=>true,
  governanceRepository:{getEffectiveGovernance:async(...args)=>{governanceCalls.push(args);return{};}},now:()=>1_000});
 return{repository,policyService,policies,audits,governanceCalls};
}

test('blockchain auto executes without verification while social auto defaults to confirmation',async()=>{
 const f=fixture(),executed=[];
 const service=createTriggerExecutionService({repository:f.repository,policyService:f.policyService,
  prepareExecution:async e=>({preview:{address:e.address},executionPayload:e}),execute:async e=>{executed.push(e);return{state:'confirmed',intentId:'i'};},notify:async()=>{}});
 assert.equal((await service.handle({id:'b',userId:'u',targetType:'sniper',targetId:A,triggerSource:'blockchain-triggered'})).action,'executed');
 await f.policyService.save('u',{targetType:'social_rule',targetId:A,socialTrigger:'auto'});
 assert.equal((await service.handle({id:'s',userId:'u',targetType:'social_rule',targetId:A,triggerSource:'social-triggered'})).action,'confirmation_required');
 assert.equal(executed.length,1);
});

test('social auto with confirmed bypass executes immediately and unconfirmed bypass never applies',async()=>{
 const f=fixture(),executed=[];
 await f.policyService.save('u',{targetType:'social_rule',targetId:A,socialTrigger:'auto'});
 await assert.rejects(f.policyService.save('u',{targetType:'social_rule',targetId:A,humanVerification:'bypassed'}),error=>error.issues?.[0]?.message.includes('confirmation challenge'));
 const challenge=await f.policyService.requestBypass('u',{targetType:'social_rule',targetId:A});
 await assert.rejects(f.policyService.confirmBypass('u',{challengeId:challenge.challengeId,confirmation:'yes'}),error=>error.issues?.[0]?.message.includes('CONFIRM'));
 await f.policyService.confirmBypass('u',{challengeId:challenge.challengeId,confirmation:'CONFIRM'});
 const service=createTriggerExecutionService({repository:f.repository,policyService:f.policyService,prepareExecution:async()=>{},
  execute:async e=>{executed.push(e);return{state:'confirmed'};},notify:async()=>{}});
 assert.equal((await service.handle({id:'s',userId:'u',targetType:'social_rule',targetId:A,triggerSource:'social-triggered'})).action,'executed');
 assert.equal(executed.length,1);
});

test("don't ask again is target-only and reset clears it",async()=>{
 const f=fixture();
 let challenge=await f.policyService.requestBypass('u',{targetType:'social_rule',targetId:A,dontAskAgain:true});
 await f.policyService.confirmBypass('u',{challengeId:challenge.challengeId,confirmation:'CONFIRM'});
 const fast=await f.policyService.requestBypass('u',{targetType:'social_rule',targetId:A});assert.equal(fast.humanVerification,'bypassed');
 const other=await f.policyService.requestBypass('u',{targetType:'social_rule',targetId:B});assert.equal(other.requiresConfirmation,true);
 const reset=await f.policyService.reset('u',{targetType:'social_rule',targetId:A});assert.equal(reset.dontAskAgain,false);
 challenge=await f.policyService.requestBypass('u',{targetType:'social_rule',targetId:A});assert.equal(challenge.requiresConfirmation,true);
 await f.policyService.reset('u',{targetType:'social_rule',targetId:A});
 await assert.rejects(f.policyService.confirmBypass('u',{challengeId:challenge.challengeId,confirmation:'CONFIRM'}),error=>error.issues?.[0]?.message.includes('invalid'));
});

test('verification can be restored to on after an acknowledged bypass',async()=>{
 const f=fixture();
 const challenge=await f.policyService.requestBypass('u',{targetType:'social_rule',targetId:A});
 await f.policyService.confirmBypass('u',{challengeId:challenge.challengeId,confirmation:'CONFIRM'});
 const policy=await f.policyService.save('u',{targetType:'social_rule',targetId:A,humanVerification:'on'});
 assert.equal(policy.humanVerification,'on');
 await assert.rejects(f.policyService.save('u',{targetType:'social_rule',targetId:A,humanVerification:'sometimes'}),error=>error.issues?.[0]?.message.includes('on or bypassed'));
});

test('target policy cannot carry ceiling overrides and valid saves consult M7a governance',async()=>{
 const f=fixture();
 await assert.rejects(f.policyService.save('u',{targetType:'sniper',targetId:A,maxTransactionValueWei:'999'}),error=>error.issues?.[0]?.message.includes('M7a'));
 await f.policyService.save('u',{targetType:'sniper',targetId:A,blockchainTrigger:'manual'});
 assert.equal(f.governanceCalls.length,1);
});

test('execution audit records trigger and verification state including acknowledgement',async()=>{
 const f=fixture();
 await f.repository.save({userId:'u',targetType:'social_rule',targetId:A,blockchainTrigger:'auto',socialTrigger:'auto',humanVerification:'bypassed',dontAskAgain:true});
 const service=createTriggerExecutionService({repository:f.repository,policyService:f.policyService,prepareExecution:async()=>{},execute:async()=>({state:'confirmed',intentId:'i',txHash:'0x1'}),notify:async()=>{}});
 await service.handle({id:'source',userId:'u',targetType:'social_rule',targetId:A,triggerSource:'social-triggered'});
 assert.deepEqual(f.audits[0],{userId:'u',targetType:'social_rule',targetId:A,triggerSource:'social-triggered',sourceEventId:'source',verificationState:'bypassed',dontAskAgain:true,confirmationShown:false,intentId:'i',txHash:'0x1',outcome:'confirmed'});
});

test('manual verification executes only after confirmation and audits that the prompt was shown',async()=>{
 const f=fixture();
 await f.policyService.save('u',{targetType:'social_rule',targetId:A,socialTrigger:'auto'});
 const service=createTriggerExecutionService({repository:f.repository,policyService:f.policyService,
  prepareExecution:async e=>({preview:{contractAddress:e.address},executionPayload:e}),
  execute:async()=>({state:'confirmed',intentId:'i2',txHash:'0x2'}),notify:async()=>{}});
 const pending=await service.handle({id:'source-2',userId:'u',targetType:'social_rule',targetId:A,triggerSource:'social-triggered'});
 await assert.rejects(service.confirm('u',pending.request.id,'yes'),/CONFIRM/);
 await service.confirm('u',pending.request.id,'CONFIRM');
 assert.equal(f.audits[0].verificationState,'on');
 assert.equal(f.audits[0].confirmationShown,true);
});

test('a bypass-valued mode preset still creates the target confirmation challenge',async()=>{
 const f=fixture();
 const result=await f.policyService.applyPreset('u',{targetType:'social_rule',targetId:A,socialTrigger:'auto'},
  {key:'ultra_fast',humanVerification:'bypass'});
  assert.equal(result.requiresConfirmation,true);
  assert.match(result.warning,/HIGHEST-RISK/);
 assert.equal((await f.policyService.get('u','social_rule',A)).modePresetKey,'ultra_fast');
});

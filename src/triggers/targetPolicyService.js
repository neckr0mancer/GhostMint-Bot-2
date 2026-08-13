const { ValidationError, requestSchemas } = require('../validation/domain');

const WARNING = 'HIGHEST-RISK CONFIGURATION: matching social triggers will execute immediately with no manual check. Reply CONFIRM explicitly to enable verification bypass.';

function target(value) {
  const targetType=String(value.targetType||'').toLowerCase();
  if (!['sniper','social_rule'].includes(targetType)) throw new ValidationError({field:'targetType',message:'must be sniper or social_rule'});
  return {targetType,targetId:requestSchemas.sniperDeletion({id:value.targetId}).id};
}
function mode(value,field) {
  const normalized=String(value||'').toLowerCase();
  if (!['auto','manual'].includes(normalized)) throw new ValidationError({field,message:'must be auto or manual'});
  return normalized;
}
function verification(value) {
  const normalized=String(value||'').toLowerCase();
  if (!['on','bypassed'].includes(normalized)) throw new ValidationError({field:'humanVerification',message:'must be on or bypassed'});
  return normalized;
}
function createTargetPolicyService({repository,targetExists,governanceRepository,now=()=>Date.now()}) {
  const defaults=(userId,targetType,targetId)=>({userId,targetType,targetId,blockchainTrigger:'auto',
    socialTrigger:'manual',humanVerification:'on',dontAskAgain:false,walletLabel:null,mintPresetName:null,modePresetKey:null});
  async function get(userId,targetType,targetId) { const key=target({targetType,targetId});
    return await repository.get(userId,key.targetType,key.targetId)||defaults(userId,key.targetType,key.targetId); }
  async function save(userId,input) {
    const allowed=new Set(['targetType','targetId','blockchainTrigger','socialTrigger','humanVerification','walletLabel','mintPresetName']);
    const invalid=Object.keys(input).find(key=>!allowed.has(key));
    if(invalid) throw new ValidationError({field:invalid,message:'cannot be configured on a target policy; transaction limits remain governed by M7a'});
    const key=target(input); if (!await targetExists(userId,key.targetType,key.targetId)) throw new ValidationError({field:'targetId',message:'was not found'});
    const current=await get(userId,key.targetType,key.targetId);
    if (String(input.humanVerification||current.humanVerification).toLowerCase()==='bypassed' && current.humanVerification!=='bypassed') {
      throw new ValidationError({field:'humanVerification',message:'bypass requires an explicit confirmation challenge'});
    }
    const value={...current,blockchainTrigger:input.blockchainTrigger===undefined?current.blockchainTrigger:mode(input.blockchainTrigger,'blockchainTrigger'),
      socialTrigger:input.socialTrigger===undefined?current.socialTrigger:mode(input.socialTrigger,'socialTrigger'),
      humanVerification:input.humanVerification===undefined?current.humanVerification:verification(input.humanVerification),
      walletLabel:input.walletLabel===undefined?current.walletLabel:String(input.walletLabel||'').trim()||null,
      mintPresetName:input.mintPresetName===undefined?current.mintPresetName:String(input.mintPresetName||'').trim()||null};
    await governanceRepository.getEffectiveGovernance(userId,'ethereum');
    return repository.save(value);
  }
  async function requestBypass(userId,input) {
    const key=target(input); const current=await get(userId,key.targetType,key.targetId);
    if (!await targetExists(userId,key.targetType,key.targetId)) throw new ValidationError({field:'targetId',message:'was not found'});
    if (current.dontAskAgain) return repository.save({...current,humanVerification:'bypassed'});
    const challengeId=await repository.createChallenge({userId,...key,dontAskAgain:input.dontAskAgain===true,expiresAt:now()+5*60_000});
    return {challengeId,warning:WARNING,requiresConfirmation:true};
  }
  async function confirmBypass(userId,input) {
    if (input.confirmation!=='CONFIRM') throw new ValidationError({field:'confirmation',message:'must exactly equal CONFIRM'});
    const challenge=await repository.consumeChallenge(userId,input.challengeId,now());
    if (!challenge) throw new ValidationError({field:'challengeId',message:'is invalid, expired, or already used'});
    const current=await get(userId,challenge.target_type,challenge.target_id);
    return repository.save({...current,humanVerification:'bypassed',dontAskAgain:challenge.dont_ask_again});
  }
  async function reset(userId,input) { const key=target(input); await repository.reset(userId,key.targetType,key.targetId); return get(userId,key.targetType,key.targetId); }
  async function applyPreset(userId,input,preset) {
    const saved=await save(userId,{targetType:input.targetType,targetId:input.targetId,
      blockchainTrigger:input.blockchainTrigger,socialTrigger:input.socialTrigger,
      humanVerification:preset.humanVerification==='on'?'on':undefined,
      walletLabel:input.walletLabel,mintPresetName:input.mintPresetName});
    const presetPolicy=await repository.save({...saved,modePresetKey:preset.key});
    if (preset.humanVerification==='bypass' && presetPolicy.humanVerification!=='bypassed') return requestBypass(userId,input);
    return presetPolicy;
  }
  return {applyPreset,confirmBypass,get,requestBypass,reset,save,warning:WARNING};
}
module.exports={WARNING,createTargetPolicyService};

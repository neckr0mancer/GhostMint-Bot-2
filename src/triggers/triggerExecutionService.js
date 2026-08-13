function createTriggerExecutionService({repository,policyService,prepareExecution,execute,notify,
  onPending=()=>{},onResolved=()=>{},now=()=>Date.now()}) {
  async function executeAndAudit(event,policy,{confirmationShown=false}={}) {
    try {
      const result=await execute(event,policy);
      await repository.addAudit({userId:event.userId,targetType:event.targetType,targetId:event.targetId,
        triggerSource:event.triggerSource,sourceEventId:event.id,verificationState:policy.humanVerification,
        dontAskAgain:policy.dontAskAgain,confirmationShown,intentId:result.intentId,txHash:result.txHash,
        outcome:result.state==='confirmed'?'confirmed':'submitted'});
      return {action:'executed',result};
    } catch(error) {
      await repository.addAudit({userId:event.userId,targetType:event.targetType,targetId:event.targetId,
        triggerSource:event.triggerSource,sourceEventId:event.id,verificationState:policy.humanVerification,
        dontAskAgain:policy.dontAskAgain,confirmationShown,outcome:'failed'}); throw error;
    }
  }
  async function handle(event) {
    const policy=await policyService.get(event.userId,event.targetType,event.targetId);
    const social=event.triggerSource==='social-triggered';
    const mode=social?policy.socialTrigger:policy.blockchainTrigger;
    const immediate=mode==='auto'&&(!social||policy.humanVerification==='bypassed');
    if (immediate) return executeAndAudit(event,policy);
    const prepared=await prepareExecution(event,policy);
    const request=await repository.createRequest({userId:event.userId,targetType:event.targetType,
      targetId:event.targetId,triggerSource:event.triggerSource,sourceEventId:event.id,
      preview:prepared.preview,executionPayload:prepared.executionPayload,expiresAt:now()+10*60_000});
    await Promise.resolve(onPending(event.userId,request)).catch(()=>{});
    await Promise.resolve(notify(event.userId,{requestId:request.id,preview:prepared.preview,
      triggerSource:event.triggerSource})).catch(()=>{});
    return {action:'confirmation_required',request};
  }
  async function confirm(userId,requestId,confirmation) {
    if (confirmation==='REJECT') {
      const rejected=await repository.rejectRequest(userId,requestId,now());
      if(!rejected) throw new Error('Confirmation request is invalid, expired, or already used');
      await Promise.resolve(onResolved(userId,{requestId,status:'rejected'})).catch(()=>{});
      return {action:'rejected',request:rejected};
    }
    if (confirmation!=='CONFIRM') throw new Error('Confirmation must exactly equal CONFIRM or REJECT');
    const request=await repository.claimRequest(userId,requestId,now()); if(!request) throw new Error('Confirmation request is invalid, expired, or already used');
    const policy=await policyService.get(userId,request.targetType,request.targetId);
    try { const outcome=await executeAndAudit({...request.executionPayload,id:request.sourceEventId,userId,
      targetType:request.targetType,targetId:request.targetId,triggerSource:request.triggerSource},policy,{confirmationShown:true});
      await repository.finishRequest(request.id,'executed');
      await Promise.resolve(onResolved(userId,{requestId,status:'executed',outcome})).catch(()=>{}); return outcome; }
    catch(error){await repository.finishRequest(request.id,'failed');
      await Promise.resolve(onResolved(userId,{requestId,status:'failed'})).catch(()=>{});throw error;}
  }
  return {confirm,handle};
}
module.exports={createTriggerExecutionService};

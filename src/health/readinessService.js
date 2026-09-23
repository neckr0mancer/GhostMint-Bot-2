async function check(name,operation) {try {const detail=await operation();return {name,status:'up',detail};}catch{return {name,status:'down',error:`${name} dependency is unavailable`};}}
function createReadinessService({database,providerService,chains,schedulerWorker,scheduledPreflightWorker,
  socialWatchWorker,retentionWorker,sniperHealth=()=>({status:'up'}),workersDisabled=false}) {
  return {async inspect(){const databaseResult=await check('database',()=>database.health());
    const rpcResults=await Promise.all(chains.map(chain=>check(chain,()=>providerService.perform(chain,'health',provider=>provider.getBlockNumber()))));
    const disabled={status:'disabled',detail:'dashboard-only test mode'};
    const dependencies={database:databaseResult,rpc:Object.fromEntries(rpcResults.map(item=>[item.name,item])),
      scheduler:workersDisabled?disabled:schedulerWorker.health(),
      scheduledPreflights:workersDisabled?disabled:scheduledPreflightWorker?.health?.()||{status:'up'},
      socialWatcher:workersDisabled?disabled:socialWatchWorker.health(),
      retentionWorker:workersDisabled?disabled:retentionWorker?retentionWorker.health():{status:'up'},
      sniperWatchers:workersDisabled?disabled:sniperHealth()};
    const healthy=databaseResult.status==='up'&&rpcResults.every(item=>item.status==='up')&&
      (workersDisabled||(dependencies.scheduler.status==='up'&&dependencies.scheduledPreflights.status==='up'&&dependencies.socialWatcher.status==='up'&&
      dependencies.retentionWorker.status==='up'&&dependencies.sniperWatchers.status!=='down'));
    return {status:healthy?'ok':'degraded',dependencies};}};
}
module.exports={createReadinessService};

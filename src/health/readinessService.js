async function check(name,operation) {try {const detail=await operation();return {name,status:'up',detail};}catch{return {name,status:'down',error:`${name} dependency is unavailable`};}}
function createReadinessService({database,providerService,chains,schedulerWorker,socialWatchWorker,sniperHealth=()=>({status:'up'})}) {
  return {async inspect(){const databaseResult=await check('database',()=>database.health());
    const rpcResults=await Promise.all(chains.map(chain=>check(chain,()=>providerService.perform(chain,'health',provider=>provider.getBlockNumber()))));
    const dependencies={database:databaseResult,rpc:Object.fromEntries(rpcResults.map(item=>[item.name,item])),
      scheduler:schedulerWorker.health(),socialWatcher:socialWatchWorker.health(),sniperWatchers:sniperHealth()};
    const healthy=databaseResult.status==='up'&&rpcResults.every(item=>item.status==='up')&&
      dependencies.scheduler.status==='up'&&dependencies.socialWatcher.status==='up'&&dependencies.sniperWatchers.status!=='down';
    return {status:healthy?'ok':'degraded',dependencies};}};
}
module.exports={createReadinessService};

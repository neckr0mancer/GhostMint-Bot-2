function createGracefulShutdown({getHttpServer=()=>null,telegramBot,discordBot,schedulerWorker,socialWatchWorker,stopWatchers,pool,log=()=>{}}) {
  let stopping=null;
  return async function shutdown(signal='shutdown') {
    if(stopping)return stopping;
    stopping=(async()=>{
      log(`Graceful shutdown started (${signal})`);
      schedulerWorker?.stop();socialWatchWorker?.stop();stopWatchers?.();
      await Promise.allSettled([
        telegramBot?.stopPolling?.({cancel:true}),discordBot?.stop?.(),
        getHttpServer()?new Promise(resolve=>getHttpServer().close(()=>resolve())):Promise.resolve(),
      ]);
      await pool?.end?.();
      log('Graceful shutdown complete');
    })();
    return stopping;
  };
}
module.exports={createGracefulShutdown};

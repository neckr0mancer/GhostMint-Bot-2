function createGracefulShutdown({getHttpServer=()=>null,telegramBot,discordBot,schedulerWorker,socialWatchWorker,retentionWorker,webSocketHub,stopWatchers,releasePollingLock,pool,log=()=>{}}) {
  let stopping=null;
  return async function shutdown(signal='shutdown') {
    if(stopping)return stopping;
    stopping=(async()=>{
      log(`Graceful shutdown started (${signal})`);
      schedulerWorker?.stop();socialWatchWorker?.stop();retentionWorker?.stop();stopWatchers?.();
      await Promise.allSettled([
        telegramBot?.stopPolling?.({cancel:true}),discordBot?.stop?.(),
        webSocketHub?.close?.(),
        getHttpServer()?new Promise(resolve=>getHttpServer().close(()=>resolve())):Promise.resolve(),
      ]);
      // Releases the Telegram single-instance advisory lock (see telegramSingleInstanceLock.js)
      // before the pool closes -- a new deploy's instance is blocked on this same lock, so
      // releasing it here is what lets the replacement start polling right after this one truly
      // stops, instead of both ever being active at once.
      await releasePollingLock?.();
      await pool?.end?.();
      log('Graceful shutdown complete');
    })();
    return stopping;
  };
}
module.exports={createGracefulShutdown};

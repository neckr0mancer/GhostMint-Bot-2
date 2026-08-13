function createSocialWatchWorker({ service, intervalMs = 30_000, log = () => {} }) {
  let timer = null;
  let running = false;
  let lastTickAt=null;let lastSuccessAt=null;let lastError=null;
  async function tick() {
    if (running) return;
    running = true;
    lastTickAt=Date.now();
    try { await service.pollOnce();lastSuccessAt=Date.now();lastError=null; }
    catch (error) { lastError=String(error?.message||'poll failed').slice(0,200);log(`Social watcher poll failed safely: ${error.message}`); }
    finally { running = false; }
  }
  return {
    start() { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    health() {return {status:timer&&(!lastError||lastSuccessAt>=lastTickAt)?'up':'down',running:Boolean(timer),active:running,lastTickAt,lastSuccessAt,lastError};},
    tick,
  };
}

module.exports = { createSocialWatchWorker };

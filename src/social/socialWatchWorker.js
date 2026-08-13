function createSocialWatchWorker({ service, intervalMs = 30_000, log = () => {} }) {
  let timer = null;
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try { await service.pollOnce(); }
    catch (error) { log(`Social watcher poll failed safely: ${error.message}`); }
    finally { running = false; }
  }
  return {
    start() { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
  };
}

module.exports = { createSocialWatchWorker };

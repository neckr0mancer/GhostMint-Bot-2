function createChainWatcher({ chain, rpcUrls, wsUrl, providerFactory, wsProviderFactory, onBlock,
  log = () => {}, pollingIntervalMs = 2500, reconnectDelayMs = 5000 }) {
  let provider = null;
  let mode = null;
  let stopped = true;
  let wsReconnectTimer = null;
  let httpRetryTimer = null;
  let rpcUrlIndex = 0;

  function blockHandler(blockNumber) {
    Promise.resolve(onBlock(blockNumber, provider)).catch(error =>
      log(`chain watcher block handling failed (${chain}): ${error?.message || error}`));
  }

  function teardown() {
    if (!provider) return;
    provider.removeAllListeners?.();
    provider.destroy?.();
    provider = null;
  }

  function scheduleHttpRetry() {
    if (httpRetryTimer) return;
    httpRetryTimer = setTimeout(() => { httpRetryTimer = null; if (!stopped) startHttp(); }, reconnectDelayMs);
    httpRetryTimer.unref?.();
  }

  function handleHttpDrop(reason) {
    if (stopped || mode !== 'http') return;
    log(`chain watcher HTTP provider ${reason} (${chain}); rotating to the next configured RPC endpoint`);
    startHttp();
  }

  // Tries every configured RPC URL in rotation (starting from wherever the last attempt left off,
  // so a single bad endpoint doesn't get retried first forever) before giving up for this cycle. A
  // dead primary endpoint used to mean the sniper watcher for a whole chain never started -- despite
  // *_RPC_URLS failover already existing for every other RPC-calling path in the app.
  function startHttp() {
    teardown();
    const attempts = rpcUrls.length;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const url = rpcUrls[rpcUrlIndex];
      rpcUrlIndex = (rpcUrlIndex + 1) % rpcUrls.length;
      try {
        provider = providerFactory(url);
        provider.pollingInterval = pollingIntervalMs;
        mode = 'http';
        provider.on('block', blockHandler);
        provider.on('error', () => handleHttpDrop('error'));
        return;
      } catch (error) {
        log(`chain watcher HTTP provider failed (${chain}, ${url}): ${error?.message || error}`);
        provider = null;
        mode = null;
      }
    }
    // Every configured endpoint failed synchronously (e.g. all misconfigured, or a full outage at
    // boot) -- retry the whole rotation after a delay instead of leaving the chain unwatched until
    // the next server restart.
    if (!stopped) scheduleHttpRetry();
  }

  function scheduleWsReconnect() {
    if (!wsUrl || wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => { wsReconnectTimer = null; if (!stopped) startWs(); }, reconnectDelayMs);
    wsReconnectTimer.unref?.();
  }

  function handleWsDrop(reason) {
    if (stopped || mode !== 'ws') return;
    log(`chain watcher WebSocket ${reason} (${chain}); falling back to HTTP polling and retrying`);
    startHttp();
    scheduleWsReconnect();
  }

  function startWs() {
    teardown();
    let socket;
    try { socket = wsProviderFactory(wsUrl); }
    catch (error) { log(`chain watcher WebSocket connect failed (${chain}): ${error?.message || error}`); startHttp(); scheduleWsReconnect(); return; }
    provider = socket;
    mode = 'ws';
    provider.on('block', blockHandler);
    provider.on('error', () => handleWsDrop('error'));
  }

  return {
    start() { if (!stopped) return; stopped = false; if (wsUrl) startWs(); else startHttp(); },
    stop() {
      stopped = true;
      clearTimeout(wsReconnectTimer); wsReconnectTimer = null;
      clearTimeout(httpRetryTimer); httpRetryTimer = null;
      teardown(); mode = null;
    },
    mode: () => mode,
    getProvider: () => provider,
  };
}

module.exports = { createChainWatcher };

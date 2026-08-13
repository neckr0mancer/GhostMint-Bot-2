function createChainWatcher({ chain, rpcUrl, wsUrl, providerFactory, wsProviderFactory, onBlock,
  log = () => {}, pollingIntervalMs = 2500, reconnectDelayMs = 5000 }) {
  let provider = null;
  let mode = null;
  let stopped = true;
  let reconnectTimer = null;

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

  function startHttp() {
    teardown();
    try {
      provider = providerFactory(rpcUrl);
      provider.pollingInterval = pollingIntervalMs;
      mode = 'http';
      provider.on('block', blockHandler);
    } catch (error) {
      log(`chain watcher HTTP provider failed (${chain}): ${error?.message || error}`);
      provider = null;
      mode = null;
    }
  }

  function scheduleReconnect() {
    if (!wsUrl || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!stopped) startWs(); }, reconnectDelayMs);
    reconnectTimer.unref?.();
  }

  function handleWsDrop(reason) {
    if (stopped || mode !== 'ws') return;
    log(`chain watcher WebSocket ${reason} (${chain}); falling back to HTTP polling and retrying`);
    startHttp();
    scheduleReconnect();
  }

  function startWs() {
    teardown();
    let socket;
    try { socket = wsProviderFactory(wsUrl); }
    catch (error) { log(`chain watcher WebSocket connect failed (${chain}): ${error?.message || error}`); startHttp(); scheduleReconnect(); return; }
    provider = socket;
    mode = 'ws';
    provider.on('block', blockHandler);
    provider.on('error', () => handleWsDrop('error'));
  }

  return {
    start() { if (!stopped) return; stopped = false; if (wsUrl) startWs(); else startHttp(); },
    stop() { stopped = true; if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; teardown(); mode = null; },
    mode: () => mode,
    getProvider: () => provider,
  };
}

module.exports = { createChainWatcher };

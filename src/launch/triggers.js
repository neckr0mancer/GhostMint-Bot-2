// Event triggers for launch squads -- the front-running edge over clock-based bots.
//
//   block   : fire the moment a chain header reaches a target height. Works on every chain with a
//             WebSocket endpoint (newHeads is universal).
//   pending : fire on the FIRST pending transaction touching the mint contract. This uses
//             alchemy_pendingTransactions (address-filtered mempool push) and therefore requires an
//             Alchemy-class endpoint; arming fails loudly on providers that reject it so the squad
//             can fall back to manual/timer instead of silently never firing.
//
// Subscriptions are short-lived by design: they exist to catch one moment, fire once, and close.
// The WebSocket constructor is injectable for tests; production passes the global WebSocket.
function createLaunchTriggers({ wsUrlFor, makeSocket = url => new globalThis.WebSocket(url), log = () => {} }) {
  const armed = new Map(); // squadId -> entry {socket, disposed}

  function dispose(squadId) {
    const entry = armed.get(squadId);
    if (!entry) return false;
    armed.delete(squadId);
    entry.disposed = true;
    try { entry.socket.close(); } catch {}
    return true;
  }
  function disarmAll() { for (const id of [...armed.keys()]) dispose(id); }
  function has(squadId) { return armed.has(squadId); }

  // Resolves once subscribed; rejects if the socket cannot be established or the provider refuses
  // the subscription. onFire runs at most once per arm, after which the subscription closes.
  function arm({ squadId, kind, chain, contractAddress, targetBlock }, onFire) {
    if (kind !== 'block' && kind !== 'pending') {
      return Promise.reject(new Error(`unknown launch trigger kind: ${kind}`));
    }
    if (kind === 'block' && !Number.isFinite(targetBlock)) {
      return Promise.reject(new Error('block trigger needs a target block number'));
    }
    if (armed.has(squadId)) dispose(squadId);
    const url = wsUrlFor(chain);
    if (!url) return Promise.reject(new Error(`no WebSocket endpoint configured for ${chain} -- cannot arm a ${kind} trigger`));

    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try { socket = makeSocket(url); } catch (error) { return reject(error); }
      const entry = { socket, disposed: false };
      const fail = message => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { socket.close(); } catch {}
        reject(new Error(message));
      };
      const timeout = setTimeout(() => fail(`${kind} trigger subscription timed out for ${chain}`), 10_000);

      const fireOnce = () => {
        if (entry.disposed || !settled) return;
        // Mark disposed BEFORE any callback/teardown so a frame arriving mid-fire can't re-enter.
        entry.disposed = true;
        try { socket.close(); } catch {}
        armed.delete(squadId);
        log(`Launch trigger '${kind}' fired for squad ${squadId}`);
        onFire();
      };

      socket.onopen = () => {
        const [method, params] = kind === 'block'
          ? ['newHeads', []]
          : ['alchemy_pendingTransactions', [{ toAddress: contractAddress }]];
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: [method, ...params] }));
      };
      socket.onmessage = event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id === 1) {
          clearTimeout(timeout);
          if (message.error) return fail(`${kind} trigger subscribe rejected: ${message.error.message || 'unknown provider error'}`);
          settled = true;
          armed.set(squadId, entry);
          resolve(entry);
          return;
        }
        if (entry.disposed || !settled) return;
        if (kind === 'block') {
          const number = parseInt(message.params?.result?.number ?? '', 16);
          if (Number.isFinite(number) && number >= targetBlock) fireOnce();
        } else {
          fireOnce();
        }
      };
      socket.onerror = () => fail(`${kind} trigger websocket error for ${chain}`);
      socket.onclose = () => { if (!settled) fail(`${kind} trigger websocket closed before subscribing`); };
    });
  }

  return { arm, dispose, has, disarmAll };
}

module.exports = { createLaunchTriggers };

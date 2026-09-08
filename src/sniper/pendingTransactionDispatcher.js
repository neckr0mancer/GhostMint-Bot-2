function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// Public mempool subscriptions can emit thousands of hashes in a burst. This dispatcher keeps
// that stream bounded and isolated: at most `concurrency` transaction lookups run at once, the
// queue has a hard cap, duplicate hashes are ignored, and a bad lookup never escapes into the
// provider event emitter or stops another pending transaction from being examined.
function createPendingTransactionDispatcher({ chain, onTransaction, log = () => {}, now = () => Date.now(),
  wait = delay, maxQueue = 1000, concurrency = 4, retries = 2, retryDelayMs = 150,
  recentTtlMs = 60_000 } = {}) {
  if (typeof onTransaction !== 'function') throw new TypeError('onTransaction is required');
  const queue = [];
  const queued = new Set();
  const recent = new Map();
  let active = 0;
  let stopped = false;
  let dropped = 0;
  let processed = 0;
  let failed = 0;

  function pruneRecent() {
    const cutoff = now() - recentTtlMs;
    for (const [hash, seenAt] of recent) if (seenAt < cutoff) recent.delete(hash);
  }

  async function resolveTransaction(item) {
    if (item.value && typeof item.value === 'object') return item.value;
    if (!item.provider?.getTransaction) throw new Error('pending provider cannot fetch transactions');
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const transaction = await item.provider.getTransaction(item.hash);
        if (transaction) return transaction;
        lastError = new Error('pending transaction is not available yet');
      } catch (error) {
        lastError = error;
      }
      if (attempt < retries) await wait(retryDelayMs * (attempt + 1));
    }
    throw lastError || new Error('pending transaction could not be fetched');
  }

  function drain() {
    while (!stopped && active < concurrency && queue.length) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(() => resolveTransaction(item))
        .then(transaction => {
          // A provider lookup cannot always be cancelled, but shutdown must still be a hard
          // boundary for value-moving work. Recheck after the lookup resolves so stop() can never
          // begin a new sniper execution while the database/provider services are closing.
          if (stopped) return false;
          return Promise.resolve(onTransaction(transaction, item.provider)).then(() => true);
        })
        .then(handled => { if (handled) processed += 1; })
        .catch(error => {
          failed += 1;
          log(`pending transaction handling failed (${chain}, ${item.hash}): ${error?.message || error}`);
        })
        .finally(() => {
          active -= 1;
          queued.delete(item.hash);
          recent.set(item.hash, now());
          drain();
        });
    }
  }

  function enqueue(value, provider) {
    if (stopped) return false;
    const hash = typeof value === 'string' ? value : value?.hash;
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return false;
    pruneRecent();
    if (queued.has(hash) || recent.has(hash)) return false;
    if (queue.length >= maxQueue) {
      dropped += 1;
      log(`pending transaction queue full (${chain}); dropped ${hash}`);
      return false;
    }
    queued.add(hash);
    queue.push({ value, provider, hash });
    drain();
    return true;
  }

  return {
    enqueue,
    stop() { stopped = true; queue.splice(0).forEach(item => queued.delete(item.hash)); },
    health: () => ({ chain, queued:queue.length, active, processed, failed, dropped, stopped }),
  };
}

module.exports = { createPendingTransactionDispatcher };

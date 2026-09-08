const WebSocket = require('ws');
const { isAddress } = require('ethers');
const { URL } = require('node:url');

// Alchemy's address-filtered pending subscription is intentionally used instead of the standard
// all-mempool `newPendingTransactions` stream. The latter can deliver every transaction on a busy
// chain, which is both costly and impossible for a small application queue to inspect reliably.
// Keep this list fail-closed: it reflects the networks Alchemy documents for the filtered method,
// not every network on which an Alchemy WebSocket happens to connect.
const FILTERED_PENDING_CHAINS = Object.freeze(new Set(['ethereum', 'polygon']));
const MAX_FILTER_ADDRESSES = 1000;

function isAlchemyUrl(value) {
  try { return /(^|\.)alchemy\.com$/i.test(new URL(value).hostname); }
  catch { return false; }
}

function supportsAlchemyPendingSource(chain, wsUrl) {
  return FILTERED_PENDING_CHAINS.has(chain) && isAlchemyUrl(wsUrl);
}

function quantity(value) {
  if (value === null || value === undefined) return null;
  try { return BigInt(value); } catch { return null; }
}

function normalizeTransaction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.hash)
    || !isAddress(raw.from) || !isAddress(raw.to)) return null;
  const calldata = raw.input || raw.data || '0x';
  if (typeof calldata !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(calldata)) return null;
  const numericFields = ['value','nonce','gas','gasLimit','gasPrice','maxFeePerGas','maxPriorityFeePerGas'];
  if (numericFields.some(field => raw[field] !== null && raw[field] !== undefined && quantity(raw[field]) === null)) {
    return null;
  }
  return {
    hash:raw.hash,
    from:raw.from,
    to:raw.to,
    data:calldata,
    value:quantity(raw.value) ?? 0n,
    nonce:quantity(raw.nonce)?.toString(),
    gasLimit:quantity(raw.gas || raw.gasLimit),
    gasPrice:quantity(raw.gasPrice),
    maxFeePerGas:quantity(raw.maxFeePerGas),
    maxPriorityFeePerGas:quantity(raw.maxPriorityFeePerGas),
    blockNumber:null,
    blockHash:null,
  };
}

function normalizeTargets(values) {
  return [...new Set((values || []).filter(isAddress).map(value => String(value).toLowerCase()))].sort();
}

function targetBatches(addresses) {
  const result = [];
  for (let index = 0; index < addresses.length; index += MAX_FILTER_ADDRESSES) {
    result.push(addresses.slice(index, index + MAX_FILTER_ADDRESSES));
  }
  return result;
}

function permanentSubscriptionError(error) {
  const code = Number(error?.code);
  const message = String(error?.message || '').toLowerCase();
  return code === -32601 || code === -32602
    || /method not found|invalid params|not supported|unsupported/.test(message);
}

function createAlchemyPendingSource({ chain, wsUrl, targets = [], onTransaction,
  log = () => {}, WebSocketImpl = WebSocket, reconnectDelayMs = 5000 } = {}) {
  if (!supportsAlchemyPendingSource(chain, wsUrl)) {
    throw new Error(`address-filtered pending subscriptions are not supported on ${chain}`);
  }
  if (typeof onTransaction !== 'function') throw new TypeError('onTransaction is required');
  let addresses = normalizeTargets(targets);
  let socket = null;
  let reconnectTimer = null;
  let stopped = true;
  let incompatible = false;
  const subscriptionIds = new Set();
  const subscribeRequests = new Set();
  let requestId = 0;
  let received = 0;
  let failures = 0;

  function safeClose() {
    const current = socket;
    socket = null;
    subscriptionIds.clear();
    subscribeRequests.clear();
    if (!current) return;
    current.removeAllListeners?.();
    try { current.close(); } catch { /* already closed */ }
  }

  function scheduleReconnect() {
    if (stopped || incompatible || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function subscribe() {
    if (!addresses.length) return;
    for (const batch of targetBatches(addresses)) {
      const id = ++requestId;
      subscribeRequests.add(id);
      send({ jsonrpc:'2.0', id, method:'eth_subscribe', params:[
        'alchemy_pendingTransactions', { fromAddress:batch, hashesOnly:false },
      ] });
    }
  }

  function resubscribe() {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) return;
    for (const subscriptionId of subscriptionIds) {
      send({ jsonrpc:'2.0', id:++requestId, method:'eth_unsubscribe', params:[subscriptionId] });
    }
    subscriptionIds.clear();
    subscribeRequests.clear();
    subscribe();
  }

  function connect() {
    if (stopped || incompatible || !addresses.length) return;
    safeClose();
    let next;
    try { next = new WebSocketImpl(wsUrl); }
    catch (error) {
      failures += 1;
      log(`filtered pending WebSocket connect failed (${chain}): ${error?.message || error}`);
      scheduleReconnect();
      return;
    }
    socket = next;
    next.on('open', subscribe);
    next.on('message', value => {
      let message;
      try { message = JSON.parse(String(value)); }
      catch { return; }
      if (subscribeRequests.has(message.id)) {
        subscribeRequests.delete(message.id);
        if (message.error) {
          failures += 1;
          incompatible = permanentSubscriptionError(message.error);
          log(`filtered pending subscription rejected (${chain}): ${message.error.message || 'provider rejected the request'}`);
          safeClose();
          if (!incompatible) scheduleReconnect();
          return;
        }
        if (typeof message.result !== 'string' || !message.result) {
          failures += 1;
          safeClose();
          scheduleReconnect();
          return;
        }
        subscriptionIds.add(message.result);
        return;
      }
      if (message.method !== 'eth_subscription' || !subscriptionIds.has(message.params?.subscription)) return;
      const transaction = normalizeTransaction(message.params?.result);
      if (!transaction?.hash) return;
      received += 1;
      Promise.resolve(onTransaction(transaction)).catch(error => {
        failures += 1;
        log(`filtered pending transaction handling failed (${chain}): ${error?.message || error}`);
      });
    });
    next.on('error', error => {
      failures += 1;
      log(`filtered pending WebSocket error (${chain}): ${error?.message || error}`);
    });
    next.on('close', () => {
      if (socket === next) socket = null;
      subscriptionIds.clear();
      subscribeRequests.clear();
      scheduleReconnect();
    });
  }

  return {
    start() { if (!stopped) return; stopped = false; connect(); },
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer); reconnectTimer = null;
      safeClose();
    },
    updateTargets(values) {
      const next = normalizeTargets(values);
      if (next.join(',') === addresses.join(',')) return;
      addresses = next;
      if (!addresses.length) { safeClose(); return; }
      if (stopped) return;
      if (!socket) connect(); else resubscribe();
    },
    health:() => ({ chain, connected:Boolean(socket && addresses.length
      && subscriptionIds.size === targetBatches(addresses).length), incompatible,
      targets:addresses.length, received, failures, stopped }),
  };
}

module.exports = { FILTERED_PENDING_CHAINS, MAX_FILTER_ADDRESSES, createAlchemyPendingSource,
  normalizeTransaction, permanentSubscriptionError, supportsAlchemyPendingSource, targetBatches };

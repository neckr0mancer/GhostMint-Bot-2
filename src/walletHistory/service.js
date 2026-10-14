const { isAddress } = require('ethers');
const { ValidationError } = require('../validation/domain');
const { createRedactor } = require('../security/redaction');

const redact = createRedactor();

function positiveInteger(value, fallback, maximum, field) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ValidationError({ field, message: `must be between 1 and ${maximum}` });
  }
  return parsed;
}

function optionalChoice(value, choices, field) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!choices.includes(normalized)) {
    throw new ValidationError({ field, message: `must be one of: ${choices.join(', ')}` });
  }
  return normalized;
}

function optionalText(value, field, maximum) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ValidationError({ field, message: `must contain 1-${maximum} safe characters` });
  }
  return normalized;
}

function walletAddress(wallet) {
  if (!wallet || !isAddress(wallet.address)) {
    throw new ValidationError({ field: 'walletId', message: 'was not found' });
  }
  return wallet.address.toLowerCase();
}

function retryAfterFor(error, now) {
  const permanent = new Set([
    'GOLDRUSH_AUTH_FAILED','GOLDRUSH_RESPONSE_INVALID','GOLDRUSH_CHAIN_UNSUPPORTED',
    'GOLDRUSH_CURSOR_INVALID','GOLDRUSH_RANGE_UNSUPPORTED',
  ]);
  if (permanent.has(error?.code)) return null;
  const explicit = Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 0
    ? Math.min(error.retryAfterMs, 86_400_000) : null;
  const fallback = error?.code === 'GOLDRUSH_RATE_LIMITED' ? 60_000 : 30_000;
  return new Date(now() + (explicit ?? fallback));
}

function createWalletHistoryService({ repository, providerRegistry, defaultProviderKey = null,
  supportedChains = [], syncEnabled = true, now = () => Date.now() }) {
  if (!repository) throw new TypeError('wallet history repository is required');
  if (!providerRegistry) throw new TypeError('wallet history provider registry is required');
  const allowedChains = [...new Set(supportedChains.map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean))];

  function resolveChain(wallet, value, { optional = false } = {}) {
    const requested = value === undefined || value === null || value === ''
      ? null : String(value).trim().toLowerCase();
    if (!requested && optional) return null;
    const chain = requested || String(wallet?.chain || '').trim().toLowerCase();
    if (!chain || (allowedChains.length && !allowedChains.includes(chain))) {
      throw new ValidationError({ field: 'chain', message: allowedChains.length
        ? `must be one of: ${allowedChains.join(', ')}` : 'is not available' });
    }
    return chain;
  }

  async function listHistory(userId, wallet, input = {}) {
    const key = { chain:resolveChain(wallet, input.chain, { optional:true }),
      walletAddress:walletAddress(wallet) };
    const page = positiveInteger(input.page, 1, 1_000_000, 'page');
    const pageSize = positiveInteger(input.pageSize, 20, 100, 'pageSize');
    const source = optionalChoice(input.source, ['ghostmint', 'external', 'source_unknown'], 'source');
    const status = optionalChoice(input.status, ['success', 'reverted', 'unknown'], 'status');
    const direction = optionalChoice(input.direction, ['in', 'out', 'self', 'unknown'], 'direction');
    const type = optionalText(input.type, 'type', 32);
    const txHash = optionalText(input.txHash, 'txHash', 66);
    const address = optionalText(input.address, 'address', 42);
    if (address && !isAddress(address)) {
      throw new ValidationError({ field: 'address', message: 'must be a valid Ethereum address' });
    }
    if (txHash && !/^0x[0-9a-f]{1,64}$/.test(txHash)) {
      throw new ValidationError({ field: 'txHash', message: 'must be a transaction hash or hash prefix' });
    }
    let snapshotAt = null;
    if (input.snapshotAt) {
      const parsed = new Date(input.snapshotAt);
      if (!Number.isFinite(parsed.getTime())) {
        throw new ValidationError({ field: 'snapshotAt', message: 'must be a valid timestamp' });
      }
      snapshotAt = parsed;
    }
    const result = await repository.listPage(userId, { ...key, limit: pageSize,
      offset: (page - 1) * pageSize, snapshotAt, source, status, direction, type, txHash, address });
    return { page, pageSize, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
      snapshotAt: result.snapshotAt, snapshotScope: result.snapshotScope,
      coverage: result.coverage, items: result.items };
  }

  async function requestSync(userId, wallet, input = {}) {
    const address = walletAddress(wallet);
    const providerKey = input.providerKey === undefined && defaultProviderKey === null ? null
      : optionalText(input.providerKey ?? defaultProviderKey, 'providerKey', 64);
    const chains = input.chain ? [resolveChain(wallet, input.chain)]
      : allowedChains.length ? allowedChains : [resolveChain(wallet, null)];
    if (!syncEnabled) {
      return { accepted:false, supported:false, state:'disabled',
        message:'Wallet history sync is not enabled on this server.' };
    }
    const results = [];
    for (const chain of chains) {
      const key = { chain, walletAddress:address };
      const descriptor = providerRegistry.describe({ chain, providerKey });
      const trackingStartBlock = descriptor.supported && descriptor.currentHeadBlock !== undefined
        ? descriptor.currentHeadBlock : null;
      await repository.registerSubject({ userId, ...key, trackingStartBlock });
      if (!descriptor.supported) {
        const sync = await repository.setSyncState({ userId, ...key, providerKey:descriptor.providerKey,
          state: 'unsupported', errorCode: null, errorMessage: null });
        results.push({ chain, supported:false, state:sync.state, providerKey:descriptor.providerKey,
          message:descriptor.reason || `Wallet history is not configured for ${chain} yet.` });
      } else {
        const sync = await repository.queueSync({ userId, ...key,
          providerKey:descriptor.providerKey });
        results.push({ chain, supported:true, state:sync.state, providerKey:descriptor.providerKey,
          message:'Wallet history sync is queued.' });
      }
    }
    if (results.length === 1) return { accepted:true, ...results[0] };
    const supportedCount = results.filter(result => result.supported).length;
    const states = [...new Set(results.map(result => result.state))];
    return { accepted:true, supported:supportedCount > 0,
      state:states.length === 1 ? states[0] : 'partial',
      requestedChains:results.length, supportedChains:supportedCount, chains:results,
      message:supportedCount
        ? `${supportedCount} of ${results.length} chain history syncs are queued.`
        : 'Wallet history is not configured for any supported chain yet.' };
  }

  async function runSyncPage(userId, wallet, input = {}) {
    const key = { chain:resolveChain(wallet, input.chain), walletAddress:walletAddress(wallet) };
    const providerKey = input.providerKey === undefined && defaultProviderKey === null ? null
      : optionalText(input.providerKey ?? defaultProviderKey, 'providerKey', 64);
    const workerId = optionalText(input.workerId, 'workerId', 128);
    const descriptor = providerRegistry.describe({ chain: key.chain, providerKey });
    if (!descriptor.supported) return requestSync(userId, wallet, {
      chain:key.chain,
      providerKey,
    });
    if (!workerId) await repository.registerSubject({ userId, ...key,
      trackingStartBlock: descriptor.currentHeadBlock ?? null });
    const selectedProviderKey = descriptor.providerKey;
    const subject = await repository.getSubject({ userId, ...key });
    const resumable = subject?.sync
      && subject.sync.providerKey === selectedProviderKey
      && ['backfilling', 'error'].includes(subject.sync.state)
      && Number.isSafeInteger(subject.sync.generation)
      && subject.sync.generation > 0;
    if (workerId && (!resumable || subject.sync.claimedBy !== workerId)) {
      return { accepted:true, supported:true, stale:true,
        state:subject?.sync?.state || 'queued', providerKey:selectedProviderKey,
        generation:subject?.sync?.generation ?? 0, cursor:subject?.sync?.cursor ?? null };
    }
    const sync = resumable ? subject.sync
      : await repository.beginSync({ userId, ...key, providerKey:selectedProviderKey });
    const requestedCursor = input.cursor ?? sync.cursor ?? null;
    try {
      const page = await providerRegistry.fetchPage({ chain: key.chain, providerKey:selectedProviderKey, walletAddress: key.walletAddress,
        cursor: requestedCursor,
        fromBlock: input.fromBlock ?? null, throughBlock: input.throughBlock ?? null });
      if (!page.supported) {
        const unsupported = await repository.setSyncState({ userId, ...key, providerKey:page.providerKey,
          state: 'unsupported', errorCode: null, errorMessage: null });
        return { accepted: true, supported: false, state: unsupported.state, providerKey:page.providerKey,
          message: page.reason || `Wallet history is not configured for ${key.chain} yet.` };
      }
      const next = await repository.applyProviderPage({ userId, ...key, providerKey:selectedProviderKey,
        generation: sync.generation, expectedCursor: requestedCursor, workerId, page });
      return { accepted: true, supported: true, state: next.state, providerKey:selectedProviderKey,
        generation: next.generation, cursor: next.cursor };
    } catch (error) {
      if (error?.code === 'WALLET_HISTORY_SYNC_STALE') {
        const latest = await repository.getSubject({ userId, ...key });
        return { accepted: true, supported: true, state: latest?.sync?.state || 'queued',
          providerKey:selectedProviderKey, generation:latest?.sync?.generation ?? sync.generation,
          cursor:latest?.sync?.cursor ?? null };
      }
      await repository.markSyncError({ userId, ...key, providerKey:selectedProviderKey,
        generation:sync.generation, expectedCursor:requestedCursor, workerId,
        errorCode: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
          ? error.code : 'PROVIDER_SYNC_FAILED',
        errorMessage:redact(error?.message || 'Wallet history sync failed')
          .replace(/[\r\n\t]+/g, ' ').slice(0, 500),
        retryAfter:retryAfterFor(error, now) });
      throw error;
    }
  }

  async function forgetWallet(userId, wallet) {
    const address = walletAddress(wallet);
    const chains = allowedChains.length ? allowedChains : [resolveChain(wallet, null)];
    const results = await Promise.all(chains.map(chain => repository.deleteSubject({ userId, chain,
      walletAddress:address })));
    return results.some(Boolean);
  }

  return { listHistory, requestSync, runSyncPage, forgetWallet };
}

module.exports = { createWalletHistoryService };

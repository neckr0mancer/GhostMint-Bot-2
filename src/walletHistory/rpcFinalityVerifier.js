'use strict';

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const GOLDRUSH_PAGE_SIZE = 100;

class WalletHistoryFinalityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletHistoryFinalityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WalletHistoryFinalityError(code, message);
}

function pageBlockNumber(value, field) {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    fail('WALLET_HISTORY_FINALITY_INVALID',
      `Wallet-history ${field} must be a canonical unsigned decimal string.`);
  }
  const result = BigInt(value);
  if (result > PG_BIGINT_MAX) {
    fail('WALLET_HISTORY_FINALITY_INVALID',
      `Wallet-history ${field} exceeds the supported block range.`);
  }
  return result;
}

function rpcUnsignedInteger(value, field) {
  let result;
  if (typeof value === 'bigint' && value >= 0n) result = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    result = BigInt(value);
  } else if (typeof value === 'string' && DECIMAL_PATTERN.test(value)) {
    result = BigInt(value);
  } else {
    fail('WALLET_HISTORY_FINALITY_INVALID', `RPC returned an invalid ${field}.`);
  }
  if (result > PG_BIGINT_MAX) {
    fail('WALLET_HISTORY_FINALITY_INVALID', `RPC returned an out-of-range ${field}.`);
  }
  return result;
}

function pageBlockHash(value, field) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail('WALLET_HISTORY_FINALITY_INVALID',
      `Wallet-history ${field} must be a 32-byte hexadecimal hash.`);
  }
  return value.toLowerCase();
}

function rpcBlockHash(value, field) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail('WALLET_HISTORY_FINALITY_INVALID', `RPC returned an invalid ${field}.`);
  }
  return value.toLowerCase();
}

function validatePageBeforeRpc(observedHeadBlock, transactions) {
  if (transactions.length > GOLDRUSH_PAGE_SIZE) {
    fail('WALLET_HISTORY_FINALITY_INVALID',
      `Wallet-history finality accepts at most ${GOLDRUSH_PAGE_SIZE} transactions per page.`);
  }

  const observedHead = pageBlockNumber(observedHeadBlock, 'observed head block');
  const expectedHashes = new Map();
  const transactionBlocks = [];
  for (let index = 0; index < transactions.length; index += 1) {
    const transaction = transactions[index];
    if (!transaction || typeof transaction !== 'object' || transaction.canonical === false) {
      fail('WALLET_HISTORY_FINALITY_INVALID',
        `Wallet-history transaction ${index} is not canonical.`);
    }
    const number = pageBlockNumber(transaction?.blockNumber,
      `transaction ${index} block number`);
    if (number > observedHead) {
      fail('WALLET_HISTORY_FINALITY_INVALID',
        `Wallet-history transaction ${index} is above the observed head block.`);
    }
    const expectedHash = pageBlockHash(transaction?.blockHash,
      `transaction ${index} block hash`);
    const key = number.toString();
    const prior = expectedHashes.get(key);
    if (prior && prior !== expectedHash) {
      fail('WALLET_HISTORY_CANONICALITY_MISMATCH',
        'Wallet-history provider returned conflicting block hashes for one block.');
    }
    expectedHashes.set(key, expectedHash);
    transactionBlocks.push(number);
  }
  if (expectedHashes.size > GOLDRUSH_PAGE_SIZE) {
    fail('WALLET_HISTORY_FINALITY_INVALID',
      `Wallet-history finality accepts at most ${GOLDRUSH_PAGE_SIZE} unique blocks per page.`);
  }
  return { expectedHashes, observedHead, transactionBlocks };
}

async function mapConcurrent(values, limit, operation) {
  let next = 0;
  const workers = Array.from({ length:Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await operation(values[index]);
    }
  });
  await Promise.all(workers);
}

function createRpcFinalityVerifier({ providerService, maxConcurrentBlocks = 4 } = {}) {
  if (!providerService || typeof providerService.perform !== 'function'
    || typeof providerService.expectedChainId !== 'function') {
    throw new TypeError('wallet history finality requires a provider service');
  }
  if (!Number.isInteger(maxConcurrentBlocks) || maxConcurrentBlocks < 1
    || maxConcurrentBlocks > 16) {
    throw new TypeError('maxConcurrentBlocks must be between 1 and 16');
  }

  async function verifyPage({ chain, observedHeadBlock, transactions } = {}) {
    if (typeof chain !== 'string' || !Array.isArray(transactions)) {
      throw new TypeError('wallet history finality page is invalid');
    }

    // Validate every provider-controlled field before opening an RPC request. Besides failing
    // cheaply, this prevents an oversized or malformed GoldRush page from driving arbitrary RPC
    // fan-out. GoldRush's configured page size is fixed at 100.
    const { expectedHashes, observedHead, transactionBlocks } = validatePageBeforeRpc(
      observedHeadBlock, transactions);

    const configuredChainId = providerService.expectedChainId(chain);
    if (configuredChainId === null || configuredChainId === undefined) {
      fail('WALLET_HISTORY_CHAIN_UNSUPPORTED',
        `RPC finality is not configured for ${chain}.`);
    }
    const expectedChainId = rpcUnsignedInteger(configuredChainId, 'configured chain identifier');
    const blockEntries = [...expectedHashes.entries()];

    // Keep the entire page observation on one provider. The callback deliberately performs only
    // raw RPC reads. Domain validation happens after perform() returns so provider failover cannot
    // swallow a precise chain/finality/canonicality error into a generic RPC_UNAVAILABLE error.
    const observations = await providerService.perform(chain, 'walletHistoryFinalityPage',
      async provider => {
        const network = await provider.getNetwork();
        const finalizedBlock = await provider.getBlock('finalized');
        const canonicalBlocks = new Map();
        await mapConcurrent(blockEntries, maxConcurrentBlocks, async ([number]) => {
          canonicalBlocks.set(number, await provider.getBlock(`0x${BigInt(number).toString(16)}`));
        });
        return { canonicalBlocks, finalizedBlock, network };
      }, { retries:0 });

    const actualChainId = rpcUnsignedInteger(observations?.network?.chainId,
      'chain identifier');
    if (actualChainId !== expectedChainId) {
      fail('WALLET_HISTORY_CHAIN_MISMATCH',
        `RPC finality returned the wrong chain for ${chain}.`);
    }

    const finalizedBlock = observations?.finalizedBlock;
    if (!finalizedBlock) {
      fail('WALLET_HISTORY_FINALITY_UNAVAILABLE',
        `RPC finality is temporarily unavailable for ${chain}.`);
    }
    const rpcFinalized = rpcUnsignedInteger(finalizedBlock.number, 'finalized block number');
    rpcBlockHash(finalizedBlock.hash, 'finalized block hash');
    const finalizedThrough = rpcFinalized < observedHead ? rpcFinalized : observedHead;

    const canonicalBlocks = observations?.canonicalBlocks;
    if (!(canonicalBlocks instanceof Map)) {
      fail('WALLET_HISTORY_FINALITY_INVALID',
        'RPC returned an invalid canonical-block observation set.');
    }
    for (const [number, expectedHash] of blockEntries) {
      const canonicalBlock = canonicalBlocks.get(number);
      if (!canonicalBlock) {
        fail('WALLET_HISTORY_FINALITY_UNAVAILABLE',
          `RPC could not verify a ${chain} wallet-history block.`);
      }
      const canonicalNumber = rpcUnsignedInteger(canonicalBlock.number,
        'canonical block number');
      const canonicalHash = rpcBlockHash(canonicalBlock.hash, 'canonical block hash');
      if (canonicalNumber !== BigInt(number) || canonicalHash !== expectedHash) {
        fail('WALLET_HISTORY_CANONICALITY_MISMATCH',
          `RPC canonicality did not match wallet history for ${chain}.`);
      }
    }

    return Object.freeze({
      finalizedThroughBlock:finalizedThrough.toString(),
      transactions:Object.freeze(transactions.map((transaction, index) => Object.freeze({
        ...transaction,
        finalityStatus:transactionBlocks[index] <= finalizedThrough
          ? 'finalized' : 'unfinalized',
      }))),
    });
  }

  return Object.freeze({ verifyPage });
}

module.exports = {
  WalletHistoryFinalityError,
  createRpcFinalityVerifier,
};

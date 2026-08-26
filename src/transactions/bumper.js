const { Wallet, keccak256 } = require('ethers');

// The bump ladder -- stuck-transaction recovery. A pending broadcast that sits below the
// inclusion floor used to just time out after the transaction timeout (10 minutes by default),
// surfacing as "unknown" with gas already spent. Dedicated bots re-bid instead: same nonce, same
// bytes, higher fee -- Ethereum replacement semantics make that safe even under uncertainty (if
// the original mined, the replacement is rejected; if it did not, the higher bid wins inclusion).
//
// One sweep pass:
//   1. candidates = pending intents past the staleness window, scoped to enabled trigger sources,
//      below the max-bump ceiling;
//   2. skip any whose nonce has moved on-chain (something else consumed it -- reconciliation owns
//      that story);
//   3. recompute fees fresh, take the HIGHER of bumped-old vs current floor, cap at the optional
//      per-user ceiling, re-sign, and race the re-bid across the fast pool exactly like launch
//      broadcasts;
//   4. persist via attachBump (new hash primary, old preserved in bumped_from_tx_hash, pending_at
//      reset so the next rung gets a full staleness window).
function createBumpSweeper({ intentRepository, findWalletById, decryptPrivateKey, providerService,
  fastProviderService = null, resolveFeeCapGwei = null,
  bumpAfterMs = 45_000, incrementPct = 15, maxAttempts = 3,
  sources = ['launch', 'scheduled'],
  intervalMs = 10_000, log = () => {}, now = () => Date.now() }) {

  let timer = null;
  let scanning = false;

  async function feeFor(intent, fresh) {
    const bumpFactor = BigInt(Math.round(100 + incrementPct));
    const is1559 = intent.maxFeePerGasWei !== null && intent.maxFeePerGasWei !== undefined;
    // The ceiling hook may be async (server wires it to the governance lookup); a failed lookup
    // means "uncapped this pass" -- refusing every bump because governance blinked would strand
    // the transaction exactly what this ladder exists to rescue.
    let capLimit = null;
    try {
      if (resolveFeeCapGwei) {
        const capWei = await resolveFeeCapGwei(intent.userId);
        if (capWei !== null && capWei !== undefined) capLimit = BigInt(Math.round(Number(capWei) * 1e9));
      }
    } catch { capLimit = null; }
    if (is1559) {
      // Ceiling division, not truncation: a truncated product can land less than 10% above the
      // old fee on small values, and nodes reject replacements that didn't rise enough.
      let maxFee = (intent.maxFeePerGasWei * bumpFactor + 99n) / 100n;
      const floor = fresh?.maxFeePerGas ? BigInt(fresh.maxFeePerGas) : 0n;
      if (floor > maxFee) maxFee = floor;
      if (capLimit !== null && maxFee > capLimit) return { is1559: true, capped: true, gasPrice: null, maxFeePerGas: null, maxPriorityFeePerGas: null };
      // Replacement rule: nodes reject a same-nonce replacement whose priority fee did not also
      // rise -- raising maxFee alone gets "replacement transaction underpriced". Both climb.
      let priority = ((intent.maxPriorityFeePerGasWei ?? 0n) * bumpFactor + 99n) / 100n;
      const freshPriority = fresh?.maxPriorityFeePerGas ? BigInt(fresh.maxPriorityFeePerGas) : 0n;
      if (freshPriority > priority) priority = freshPriority;
      return { is1559: true, capped: false, gasPrice: null,
        maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
    }
    let gasPrice = ((intent.gasPriceWei ?? 0n) * bumpFactor + 99n) / 100n;
    const floor = fresh?.gasPrice ? BigInt(fresh.gasPrice) : 0n;
    if (floor > gasPrice) gasPrice = floor;
    if (capLimit !== null && gasPrice > capLimit) return { is1559: false, capped: true, gasPrice: null, maxFeePerGas: null, maxPriorityFeePerGas: null };
    return { is1559: false, capped: false, gasPrice, maxFeePerGas: null, maxPriorityFeePerGas: null };
  }

  async function attempt(intent) {
    const wallet = findWalletById(intent.userId, intent.walletId);
    if (!wallet) { log(`Bump skipped for ${intent.intentId}: wallet ${intent.walletId} no longer exists`); return 'skipped'; }

    // Nonce consumed on MINED count means the original landed -- reconciliation owns that
    // outcome. Deliberately 'latest', NOT 'pending': the pending count INCLUDES our own stuck
    // transaction sitting in the pool, so a pending check reads one above intent.nonce for
    // exactly the transaction this ladder exists to rescue and would skip it forever.
    const minedCount = await providerService.perform(intent.chain, 'bumpNonceCheck',
      provider => provider.getTransactionCount(wallet.address, 'latest'));
    if (Number(minedCount) > intent.nonce) {
      log(`Bump skipped for ${intent.intentId}: nonce already consumed by a mined transaction`);
      return 'skipped';
    }

    const fresh = await providerService.perform(intent.chain, 'bumpFeeData',
      provider => provider.getFeeData()).catch(() => null);
    const fee = await feeFor(intent, fresh);
    if (fee.capped) {
      log(`Bump skipped for ${intent.intentId}: next rung exceeds the fee ceiling`);
      return 'capped';
    }

    const expectedChainId = providerService.expectedChainId?.(intent.chain);
    const transaction = {
      to: intent.to, data: intent.data || '0x', value: BigInt(intent.valueWei), nonce: intent.nonce,
      gasLimit: BigInt(intent.gasLimit),
      chainId: expectedChainId !== null && expectedChainId !== undefined ? BigInt(expectedChainId) : undefined,
      ...(fee.is1559
        ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2 }
        : { gasPrice: fee.gasPrice }),
    };
    const signer = new Wallet(decryptPrivateKey(wallet));
    const signed = await signer.signTransaction(transaction);
    const txHash = keccak256(signed);

    // TX-021: record the replacement hash BEFORE broadcast so restart reconciliation finds
    // it even if the process dies or the broadcast outcome is ambiguous.
    if (intentRepository.recordBroadcastHash) {
      await intentRepository.recordBroadcastHash(intent.intentId, txHash);
    }

    // Same race semantics as launch broadcasts: identical nonce+signature everywhere.
    const racing = fastProviderService || providerService;
    await racing.performAll(intent.chain, 'broadcastTransaction',
      provider => provider.broadcastTransaction(signed));

    await intentRepository.attachBump(intent.intentId, {
      txHash, bumpedFromTxHash: intent.txHash,
      gasPriceWei: fee.gasPrice, maxFeePerGasWei: fee.maxFeePerGas, maxPriorityFeePerGasWei: fee.maxPriorityFeePerGas,
    });
    log(`Bumped ${intent.triggerSource} intent ${intent.intentId} to rung ${(intent.bumpCount || 0) + 1}`);
    return 'bumped';
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const cutoff = now() - bumpAfterMs;
      const candidates = await intentRepository.listBumpCandidates({
        sources, cutoffMs: cutoff, maxBumpCount: maxAttempts,
      });
      for (const intent of candidates) {
        try { await attempt(intent); }
        catch (error) { log(`Bump attempt failed for ${intent.intentId}: ${error.message}`); }
      }
    } catch (error) {
      log(`Bump scan failed: ${error.message}`);
    } finally {
      scanning = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { scan(); }, intervalMs);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { scan, start, stop };
}

module.exports = { createBumpSweeper };

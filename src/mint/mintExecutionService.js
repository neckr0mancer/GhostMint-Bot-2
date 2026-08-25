function createMintExecutionService({ mintService, transactionEngine }) {
  async function executePrepared({ userId, wallet, prepared, triggerSource = 'manual', gasPriceWei, maxGasGwei, onPreview,
    idempotencyKey, onIntentPersisted, preBroadcastGuard }) {
    // Fire-and-forget, deliberately not awaited: the preview notification is informational, and an
    // await here sat directly between "launch moment arrived" and "submit()" -- meaning Telegram's
    // or Discord's full HTTPS round trip was on the critical path of every scheduled and sniper
    // fire (and an exception in the send aborted the mint outright). The send still starts before
    // submit() does, so delivery ordering is preserved best-effort; only the blocking is gone.
    if (onPreview) Promise.resolve().then(() => onPreview(prepared.preview)).catch(() => {});
    return transactionEngine.submit({
      userId,
      wallet,
      chain: prepared.chain,
      triggerSource,
      to: prepared.preview.callTarget ?? prepared.preview.contractAddress,
      data: prepared.calldata,
      valueWei: prepared.valueWei,
      methodSignature: prepared.method.signature,
      callPreview: prepared.preview,
      gasPriceWei,
      maxGasGwei,
      idempotencyKey,
      onIntentPersisted,
      preBroadcastGuard,
    });
  }

  return {
    preview({userId,wallet,prepared,triggerSource='manual',gasPriceWei}) {
      return transactionEngine.preview({userId,wallet,chain:prepared.chain,triggerSource,to:prepared.preview.callTarget ?? prepared.preview.contractAddress,
        data:prepared.calldata,valueWei:prepared.valueWei,methodSignature:prepared.method.signature,
        callPreview:prepared.preview,gasPriceWei,forceSimulation:true});
    },
    executePrepared,
    async execute({ userId, wallet, input, triggerSource, gasPriceWei, maxGasGwei, onPreview, idempotencyKey, onIntentPersisted,
      preBroadcastGuard }) {
      const prepared = await mintService.prepare({ ...input, walletAddress: wallet.address });
      return executePrepared({ userId, wallet, prepared, triggerSource, gasPriceWei, maxGasGwei, onPreview, idempotencyKey,
        onIntentPersisted, preBroadcastGuard });
    },
  };
}

module.exports = { createMintExecutionService };

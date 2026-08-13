function createMintExecutionService({ mintService, transactionEngine }) {
  async function executePrepared({ userId, wallet, prepared, triggerSource = 'manual', gasPriceWei, onPreview,
    idempotencyKey, onIntentPersisted }) {
    if (onPreview) await onPreview(prepared.preview);
    return transactionEngine.submit({
      userId,
      wallet,
      chain: prepared.chain,
      triggerSource,
      to: prepared.preview.contractAddress,
      data: prepared.calldata,
      valueWei: prepared.valueWei,
      methodSignature: prepared.method.signature,
      callPreview: prepared.preview,
      gasPriceWei,
      idempotencyKey,
      onIntentPersisted,
    });
  }

  return {
    executePrepared,
    async execute({ userId, wallet, input, triggerSource, gasPriceWei, onPreview, idempotencyKey, onIntentPersisted }) {
      const prepared = await mintService.prepare({ ...input, walletAddress: wallet.address });
      return executePrepared({ userId, wallet, prepared, triggerSource, gasPriceWei, onPreview, idempotencyKey, onIntentPersisted });
    },
  };
}

module.exports = { createMintExecutionService };

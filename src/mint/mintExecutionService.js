function createMintExecutionService({ mintService, transactionEngine }) {
  async function executePrepared({ userId, wallet, prepared, triggerSource = 'manual', gasPriceWei, maxGasGwei, onPreview,
    idempotencyKey, onIntentPersisted }) {
    if (onPreview) await onPreview(prepared.preview);
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
    });
  }

  return {
    preview({userId,wallet,prepared,triggerSource='manual',gasPriceWei}) {
      return transactionEngine.preview({userId,wallet,chain:prepared.chain,triggerSource,to:prepared.preview.callTarget ?? prepared.preview.contractAddress,
        data:prepared.calldata,valueWei:prepared.valueWei,methodSignature:prepared.method.signature,
        callPreview:prepared.preview,gasPriceWei,forceSimulation:true});
    },
    executePrepared,
    async execute({ userId, wallet, input, triggerSource, gasPriceWei, maxGasGwei, onPreview, idempotencyKey, onIntentPersisted }) {
      const prepared = await mintService.prepare({ ...input, walletAddress: wallet.address });
      return executePrepared({ userId, wallet, prepared, triggerSource, gasPriceWei, maxGasGwei, onPreview, idempotencyKey, onIntentPersisted });
    },
  };
}

module.exports = { createMintExecutionService };

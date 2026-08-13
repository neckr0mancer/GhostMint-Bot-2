function createMintExecutionService({ mintService, transactionEngine }) {
  async function executePrepared({ userId, wallet, prepared, triggerSource = 'manual', gasPriceWei, onPreview }) {
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
    });
  }

  return {
    executePrepared,
    async execute({ userId, wallet, input, triggerSource, gasPriceWei, onPreview }) {
      const prepared = await mintService.prepare({ ...input, walletAddress: wallet.address });
      return executePrepared({ userId, wallet, prepared, triggerSource, gasPriceWei, onPreview });
    },
  };
}

module.exports = { createMintExecutionService };

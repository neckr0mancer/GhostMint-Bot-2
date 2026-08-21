-- Section T (docs/WORKLIST.md): a mint receipt has always told this app gasUsed/effectiveGasPrice/
-- blockNumber (018_supporting_feature_cleanup.sql), never which token ID it actually minted --
-- the ERC-721 Transfer / ERC-1155 TransferSingle/TransferBatch event(s) the NFT contract itself
-- emits were never read. Blocks P&L sales-detection entirely (no (chain, contractAddress, tokenId)
-- triple exists to later ask "did this specific token sell?").
--
-- TEXT[], not a single column: a batch mint (quantity > 1) or an ERC-1155 TransferBatch can land
-- more than one token ID in a single confirmed transaction.
ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS token_ids TEXT[];

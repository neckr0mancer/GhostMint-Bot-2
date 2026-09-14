-- The original dashboard preference constraint predated Ink, Robinhood Chain, HyperEVM, and
-- the temporarily opt-in Sepolia acceptance network. The HTTP boundary still validates every
-- write against the process's configured SUPPORTED_CHAINS; this constraint protects direct SQL
-- writes without rejecting chains the application already supports.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_default_chain_check;
ALTER TABLE users ADD CONSTRAINT users_default_chain_check
  CHECK (default_chain IS NULL OR default_chain IN (
    'ethereum', 'base', 'arbitrum', 'polygon', 'ink', 'robinhood', 'hyperevm', 'sepolia'
  ));

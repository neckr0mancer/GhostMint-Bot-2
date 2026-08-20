-- Section AF -- scheduling an OpenSea-backed mint (allowlist/GTD/FCFS stages this app has no
-- on-chain proof for): the scheduler needs to know, at execution time, to ask OpenSea's own
-- /drops/{slug}/mint endpoint to build the calldata instead of this app's own prepareMintCall.
-- price_eth stays 0 for these tasks -- OpenSea's own response determines the real value, never
-- anything scheduled up front -- so this flag is what tells executeTask which path to take, not
-- a price of 0 (which a genuinely free public mint could also have).
ALTER TABLE mint_tasks ADD COLUMN IF NOT EXISTS via_opensea BOOLEAN NOT NULL DEFAULT false;

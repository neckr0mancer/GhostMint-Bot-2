-- Migration 059 may already be present in deployed databases. Expand its display-only choice
-- constraint without rewriting the stored preference or touching transaction-policy ceilings.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_low_balance_threshold_native_check;

ALTER TABLE users
  ADD CONSTRAINT users_low_balance_threshold_native_check
  CHECK (low_balance_threshold_native IN
    (0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1));

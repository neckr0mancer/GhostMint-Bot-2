-- Display-only warning preference. It never participates in transaction authorization or
-- balance enforcement; those continue to use the real estimated debit in transactionEngine.
ALTER TABLE users
  ADD COLUMN low_balance_threshold_native NUMERIC(30,18) NOT NULL DEFAULT 0.01
  CHECK (low_balance_threshold_native IN (0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1));

ALTER TABLE transaction_intents
  DROP CONSTRAINT transaction_intents_wallet_fkey;

ALTER TABLE transaction_intents
  ALTER COLUMN wallet_id DROP NOT NULL;

ALTER TABLE transaction_intents
  ADD CONSTRAINT transaction_intents_user_fkey
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  ADD CONSTRAINT transaction_intents_wallet_fkey
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE SET NULL;

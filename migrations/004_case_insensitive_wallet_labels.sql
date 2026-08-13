ALTER TABLE wallets DROP CONSTRAINT wallets_user_label_key;
CREATE UNIQUE INDEX wallets_user_label_ci_key ON wallets (user_id, LOWER(label));

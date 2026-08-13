CREATE UNIQUE INDEX transaction_intents_chain_sender_nonce_key
  ON transaction_intents (chain, LOWER(from_address), nonce);

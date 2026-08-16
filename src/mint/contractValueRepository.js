function mapRow(row) {
  if (!row) return null;
  return {
    price: row.price_wei === null ? null : { value: row.price_wei, source: row.price_source },
    maxSupply: row.max_supply === null ? null : { value: row.max_supply, source: row.supply_source },
    maxPerWallet: row.max_per_wallet === null ? null : { value: row.max_per_wallet, source: row.per_wallet_source },
    resolvedAt: row.resolved_at,
  };
}

function createContractValueRepository(pool) {
  return {
    async get(chain, contractAddress) {
      const result = await pool.query(
        'SELECT * FROM contract_value_cache WHERE chain=$1 AND contract_address=$2',
        [chain, contractAddress.toLowerCase()],
      );
      return mapRow(result.rows[0]);
    },

    async save(chain, contractAddress, { price, maxSupply, maxPerWallet }) {
      const result = await pool.query(`INSERT INTO contract_value_cache
        (chain,contract_address,price_wei,price_source,max_supply,supply_source,max_per_wallet,per_wallet_source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (chain,contract_address) DO UPDATE SET
          price_wei=EXCLUDED.price_wei,price_source=EXCLUDED.price_source,
          max_supply=EXCLUDED.max_supply,supply_source=EXCLUDED.supply_source,
          max_per_wallet=EXCLUDED.max_per_wallet,per_wallet_source=EXCLUDED.per_wallet_source,
          resolved_at=NOW() RETURNING *`,
        [chain, contractAddress.toLowerCase(), price?.value ?? null, price?.source ?? null,
          maxSupply?.value ?? null, maxSupply?.source ?? null, maxPerWallet?.value ?? null, maxPerWallet?.source ?? null]);
      return mapRow(result.rows[0]);
    },
  };
}

module.exports = { createContractValueRepository };

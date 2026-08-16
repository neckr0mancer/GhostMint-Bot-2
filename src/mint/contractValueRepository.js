function mapRow(row) {
  if (!row) return null;
  return {
    price: row.price_wei === null ? null : { value: row.price_wei, source: row.price_source },
    maxSupply: row.max_supply === null ? null : { value: row.max_supply, source: row.supply_source },
    maxPerWallet: row.max_per_wallet === null ? null : { value: row.max_per_wallet, source: row.per_wallet_source },
    resolvedAt: row.resolved_at,
  };
}

function mapSeaDropRow(row) {
  if (!row || row.seadrop_resolved_at === null || row.seadrop_resolved_at === undefined) return null;
  return {
    address: row.seadrop_address,
    discoverySource: row.seadrop_discovery_source,
    feeRecipient: row.seadrop_fee_recipient,
    publicDrop: row.seadrop_mint_price_wei === null ? null : {
      mintPriceWei: row.seadrop_mint_price_wei,
      startTime: row.seadrop_start_time,
      endTime: row.seadrop_end_time,
      maxTotalMintableByWallet: row.seadrop_max_total_mintable_by_wallet,
      feeBps: row.seadrop_fee_bps,
      restrictFeeRecipients: row.seadrop_restrict_fee_recipients,
    },
    resolvedAt: row.seadrop_resolved_at,
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

    async getSeaDrop(chain, contractAddress) {
      const result = await pool.query(
        'SELECT * FROM contract_value_cache WHERE chain=$1 AND contract_address=$2',
        [chain, contractAddress.toLowerCase()],
      );
      return mapSeaDropRow(result.rows[0]);
    },

    async saveSeaDrop(chain, contractAddress, { address, discoverySource, publicDrop, feeRecipient }) {
      const result = await pool.query(`INSERT INTO contract_value_cache
        (chain,contract_address,seadrop_address,seadrop_discovery_source,seadrop_fee_recipient,
         seadrop_mint_price_wei,seadrop_start_time,seadrop_end_time,seadrop_max_total_mintable_by_wallet,
         seadrop_fee_bps,seadrop_restrict_fee_recipients,seadrop_resolved_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (chain,contract_address) DO UPDATE SET
          seadrop_address=EXCLUDED.seadrop_address,seadrop_discovery_source=EXCLUDED.seadrop_discovery_source,
          seadrop_fee_recipient=EXCLUDED.seadrop_fee_recipient,seadrop_mint_price_wei=EXCLUDED.seadrop_mint_price_wei,
          seadrop_start_time=EXCLUDED.seadrop_start_time,seadrop_end_time=EXCLUDED.seadrop_end_time,
          seadrop_max_total_mintable_by_wallet=EXCLUDED.seadrop_max_total_mintable_by_wallet,
          seadrop_fee_bps=EXCLUDED.seadrop_fee_bps,seadrop_restrict_fee_recipients=EXCLUDED.seadrop_restrict_fee_recipients,
          seadrop_resolved_at=NOW() RETURNING *`,
        [chain, contractAddress.toLowerCase(), address ?? null, discoverySource ?? null, feeRecipient ?? null,
          publicDrop?.mintPriceWei ?? null, publicDrop?.startTime ?? null, publicDrop?.endTime ?? null,
          publicDrop?.maxTotalMintableByWallet ?? null, publicDrop?.feeBps ?? null, publicDrop?.restrictFeeRecipients ?? null]);
      return mapSeaDropRow(result.rows[0]);
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

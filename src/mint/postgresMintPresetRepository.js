function mapPreset(row) {
  if (!row) return null;
  return {
    id: row.preset_id,
    userId: row.user_id,
    name: row.name,
    contractAddress: row.contract_address,
    chain: row.chain,
    methodSignature: row.method_signature,
    abiFragment: row.abi_fragment,
    arguments: row.arguments,
    valueWei: BigInt(row.value_wei),
    proofUrl: row.proof_source_url,
    allowlistCheck: row.allowlist_check,
  };
}

function createPostgresMintPresetRepository(pool) {
  return {
    async save(preset) {
      const result = await pool.query(`INSERT INTO mint_presets
        (user_id,name,contract_address,chain,method_signature,abi_fragment,arguments,value_wei,proof_source_url,allowlist_check)
        VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7::JSONB,$8,$9,$10::JSONB)
        ON CONFLICT (user_id,(LOWER(name))) DO UPDATE SET
          contract_address=EXCLUDED.contract_address,chain=EXCLUDED.chain,
          method_signature=EXCLUDED.method_signature,abi_fragment=EXCLUDED.abi_fragment,
          arguments=EXCLUDED.arguments,value_wei=EXCLUDED.value_wei,
          proof_source_url=EXCLUDED.proof_source_url,allowlist_check=EXCLUDED.allowlist_check,updated_at=NOW() RETURNING *`,
      [preset.userId, preset.name, preset.contractAddress, preset.chain, preset.methodSignature,
        JSON.stringify(preset.abiFragment), JSON.stringify(preset.arguments), preset.valueWei.toString(), preset.proofUrl || null,
        preset.allowlistCheck ? JSON.stringify(preset.allowlistCheck) : null]);
      return mapPreset(result.rows[0]);
    },

    async getByName(userId, name) {
      const result = await pool.query('SELECT * FROM mint_presets WHERE user_id=$1 AND LOWER(name)=LOWER($2)', [userId, name]);
      return mapPreset(result.rows[0]);
    },

    async list(userId) {
      const result = await pool.query('SELECT * FROM mint_presets WHERE user_id=$1 ORDER BY LOWER(name)', [userId]);
      return result.rows.map(mapPreset);
    },

    async delete(userId, name) {
      const result = await pool.query('DELETE FROM mint_presets WHERE user_id=$1 AND LOWER(name)=LOWER($2)', [userId, name]);
      return result.rowCount > 0;
    },
  };
}

module.exports = { createPostgresMintPresetRepository, mapPreset };

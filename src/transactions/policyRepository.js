const { defaultPolicy } = require('./defaults');
const { requestSchemas } = require('../validation/domain');

const COLUMN_TO_PROPERTY = Object.freeze({
  simulation_enabled: 'simulationEnabled',
  gas_ceiling_gwei: 'gasCeilingGwei',
  max_transaction_value_wei: 'maxTransactionValueWei',
  daily_spending_budget_wei: 'dailySpendingBudgetWei',
  required_confirmations: 'requiredConfirmations',
  transaction_timeout_ms: 'transactionTimeoutMs',
});

function overlay(policy, row) {
  if (!row) return policy;
  const result = { ...policy };
  for (const [column, property] of Object.entries(COLUMN_TO_PROPERTY)) {
    if (row[column] === null || row[column] === undefined) continue;
    if (['maxTransactionValueWei', 'dailySpendingBudgetWei'].includes(property)) result[property] = BigInt(row[column]);
    else if (['gasCeilingGwei', 'requiredConfirmations', 'transactionTimeoutMs'].includes(property)) result[property] = Number(row[column]);
    else result[property] = row[column];
  }
  return result;
}

function applyGovernance(policy, governance, triggerSource = 'manual') {
  const result = { ...policy };
  result.gasPriceMultiplier = 1;
  if (governance.preset) {
    result.requiredConfirmations = governance.preset.confirmationCount;
    result.humanVerification = governance.preset.humanVerification;
    result.simulationEnabled = governance.preset.simulationMode === 'on'
      || (governance.preset.simulationMode === 'blockchain_off' && triggerSource !== 'blockchain');
    result.gasPriceMultiplier = governance.preset.gasPriceMultiplier ?? 1;
  }
  if (governance.simulationForced) result.simulationEnabled = true;
  result.simulationForced = governance.simulationForced;
  result.ceilingExempt = governance.isOwner;
  if (!governance.isOwner) {
    result.maxTransactionValueWei = result.maxTransactionValueWei < governance.maxTransactionValueWei
      ? result.maxTransactionValueWei : governance.maxTransactionValueWei;
    result.dailySpendingBudgetWei = result.dailySpendingBudgetWei < governance.dailySpendingBudgetWei
      ? result.dailySpendingBudgetWei : governance.dailySpendingBudgetWei;
    result.gasCeilingGwei = Math.min(result.gasCeilingGwei, governance.gasCeilingGwei);
  }
  return result;
}

function createTransactionPolicyRepository(pool, { governanceRepository = null } = {}) {
  return {
    async resolvePolicy({ userId, walletId, targetId = null, chain, triggerSource = 'manual' }) {
      const scopes = [['wallet', String(walletId)]];
      if (targetId) scopes.push(['target', String(targetId)]);
      const rows = await pool.query(
        `SELECT * FROM transaction_policies WHERE user_id=$1
         AND (scope_type,scope_id) IN (${scopes.map((_, index) => `($${index * 2 + 2},$${index * 2 + 3})`).join(',')})`,
        [userId, ...scopes.flat()],
      );
      const wallet = rows.rows.find(row => row.scope_type === 'wallet');
      const target = rows.rows.find(row => row.scope_type === 'target');
      const policy = overlay(overlay(defaultPolicy(chain), wallet), target);
      if (!governanceRepository) return policy;
      const governance = await governanceRepository.getEffectiveGovernance(userId, chain);
      if (targetId) {
        const targetPreset = await pool.query(`SELECT mp.* FROM target_trigger_policies tp
          JOIN mode_presets mp ON mp.preset_key=tp.mode_preset_key
          WHERE tp.user_id=$1 AND tp.target_id=$2`, [userId, String(targetId)]);
        if (targetPreset.rows[0]) governance.preset = {
          key: targetPreset.rows[0].preset_key, displayName: targetPreset.rows[0].display_name,
          simulationMode: targetPreset.rows[0].simulation_mode,
          confirmationCount: Number(targetPreset.rows[0].confirmation_count),
          humanVerification: targetPreset.rows[0].human_verification,
          gasPriceMultiplier: Number(targetPreset.rows[0].gas_price_multiplier),
        };
      }
      return applyGovernance(policy, governance, triggerSource);
    },

    async setPolicy({ userId, scopeType, scopeId, settings }) {
      if (!['wallet', 'target'].includes(scopeType)) throw new Error('Invalid transaction policy scope');
      const validated = requestSchemas.transactionPolicy(settings);
      const result = await pool.query(`INSERT INTO transaction_policies
        (user_id,scope_type,scope_id,simulation_enabled,gas_ceiling_gwei,max_transaction_value_wei,
          daily_spending_budget_wei,required_confirmations,transaction_timeout_ms,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT (user_id,scope_type,scope_id) DO UPDATE SET
          simulation_enabled=EXCLUDED.simulation_enabled,gas_ceiling_gwei=EXCLUDED.gas_ceiling_gwei,
          max_transaction_value_wei=EXCLUDED.max_transaction_value_wei,
          daily_spending_budget_wei=EXCLUDED.daily_spending_budget_wei,
          required_confirmations=EXCLUDED.required_confirmations,
          transaction_timeout_ms=EXCLUDED.transaction_timeout_ms,updated_at=NOW()
        RETURNING *`, [userId, scopeType, String(scopeId), validated.simulationEnabled,
        validated.gasCeilingGwei, validated.maxTransactionValueWei?.toString(),
        validated.dailySpendingBudgetWei?.toString(), validated.requiredConfirmations,
        validated.transactionTimeoutMs]);
      return result.rows[0];
    },
  };
}

module.exports = { applyGovernance, createTransactionPolicyRepository, overlay };

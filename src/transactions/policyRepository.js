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

function createTransactionPolicyRepository(pool) {
  return {
    async resolvePolicy({ userId, walletId, targetId = null, chain }) {
      const scopes = [['wallet', String(walletId)]];
      if (targetId) scopes.push(['target', String(targetId)]);
      const rows = await pool.query(
        `SELECT * FROM transaction_policies WHERE user_id=$1
         AND (scope_type,scope_id) IN (${scopes.map((_, index) => `($${index * 2 + 2},$${index * 2 + 3})`).join(',')})`,
        [userId, ...scopes.flat()],
      );
      const wallet = rows.rows.find(row => row.scope_type === 'wallet');
      const target = rows.rows.find(row => row.scope_type === 'target');
      return overlay(overlay(defaultPolicy(chain), wallet), target);
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

module.exports = { createTransactionPolicyRepository, overlay };

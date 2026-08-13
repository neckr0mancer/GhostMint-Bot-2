const { defaultPolicy } = require('../transactions/defaults');

const PRESET_KEYS = Object.freeze(['ultra_fast', 'fast', 'semi_safe', 'safe']);

function normalizePresetKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
}

function mapPreset(row) {
  if (!row) return null;
  return {
    key: row.preset_key,
    displayName: row.display_name,
    simulationMode: row.simulation_mode,
    confirmationCount: Number(row.confirmation_count),
    humanVerification: row.human_verification,
  };
}

function createPostgresGovernanceRepository(pool) {
  return {
    async isOwner(userId) {
      const result = await pool.query('SELECT is_owner FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.is_owner === true;
    },

    async findUserByPlatform(platform, platformUserId) {
      const result = await pool.query(
        'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2',
        [platform, String(platformUserId)],
      );
      return result.rows[0]?.user_id || null;
    },

    async setOwner(userId, enabled) {
      if (!enabled) {
        const count = await pool.query('SELECT COUNT(*)::INTEGER AS count FROM users WHERE is_owner=TRUE');
        const current = await this.isOwner(userId);
        if (current && count.rows[0].count <= 1) throw new Error('Cannot remove the last owner');
      }
      const result = await pool.query('UPDATE users SET is_owner=$2 WHERE user_id=$1 RETURNING user_id,is_owner', [userId, enabled]);
      if (!result.rowCount) throw new Error('User not found');
      return result.rows[0];
    },

    async upsertGroup({ actorUserId, name, maxTransactionValueWei, dailySpendingBudgetWei, gasCeilingGwei, simulationForced }) {
      const result = await pool.query(`INSERT INTO seat_groups
        (name,max_transaction_value_wei,daily_spending_budget_wei,gas_ceiling_gwei,simulation_forced,created_by)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT ((LOWER(name))) DO UPDATE SET
          max_transaction_value_wei=EXCLUDED.max_transaction_value_wei,
          daily_spending_budget_wei=EXCLUDED.daily_spending_budget_wei,
          gas_ceiling_gwei=EXCLUDED.gas_ceiling_gwei,
          simulation_forced=EXCLUDED.simulation_forced,updated_at=NOW()
        RETURNING *`, [name, maxTransactionValueWei.toString(), dailySpendingBudgetWei.toString(), gasCeilingGwei, simulationForced, actorUserId]);
      return result.rows[0];
    },

    async deleteGroup(name) {
      const result = await pool.query('DELETE FROM seat_groups WHERE LOWER(name)=LOWER($1)', [name]);
      return result.rowCount > 0;
    },

    async assignGroup(userId, groupName) {
      const result = await pool.query(`INSERT INTO user_governance (user_id,group_id)
        SELECT $1,group_id FROM seat_groups WHERE LOWER(name)=LOWER($2)
        ON CONFLICT (user_id) DO UPDATE SET group_id=EXCLUDED.group_id,updated_at=NOW()
        RETURNING user_id`, [userId, groupName]);
      if (!result.rowCount) throw new Error('Group not found');
    },

    async removeGroup(userId) {
      await pool.query(`INSERT INTO user_governance (user_id,group_id) VALUES ($1,NULL)
        ON CONFLICT (user_id) DO UPDATE SET group_id=NULL,updated_at=NOW()`, [userId]);
    },

    async setUserCeilings({ actorUserId, userId, maxTransactionValueWei, dailySpendingBudgetWei, gasCeilingGwei }) {
      await pool.query(`INSERT INTO user_governance
        (user_id,max_transaction_value_wei,daily_spending_budget_wei,gas_ceiling_gwei,updated_by)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id) DO UPDATE SET
        max_transaction_value_wei=EXCLUDED.max_transaction_value_wei,
        daily_spending_budget_wei=EXCLUDED.daily_spending_budget_wei,
        gas_ceiling_gwei=EXCLUDED.gas_ceiling_gwei,updated_by=$5,updated_at=NOW()`,
      [userId, maxTransactionValueWei?.toString() ?? null, dailySpendingBudgetWei?.toString() ?? null, gasCeilingGwei, actorUserId]);
    },

    async setUserSimulation({ actorUserId, userId, simulationForced }) {
      await pool.query(`INSERT INTO user_governance (user_id,simulation_forced,updated_by)
        VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET
        simulation_forced=EXCLUDED.simulation_forced,updated_by=$3,updated_at=NOW()`,
      [userId, simulationForced, actorUserId]);
    },

    async setGroupSimulation(groupName, simulationForced) {
      const result = await pool.query('UPDATE seat_groups SET simulation_forced=$2,updated_at=NOW() WHERE LOWER(name)=LOWER($1)', [groupName, simulationForced]);
      if (!result.rowCount) throw new Error('Group not found');
    },

    async updatePreset({ actorUserId, presetKey, simulationMode, confirmationCount, humanVerification }) {
      const key = normalizePresetKey(presetKey);
      if (!PRESET_KEYS.includes(key)) throw new Error('Unknown mode preset');
      const result = await pool.query(`UPDATE mode_presets SET simulation_mode=$2,
        confirmation_count=$3,human_verification=$4,updated_by=$5,updated_at=NOW()
        WHERE preset_key=$1 RETURNING *`, [key, simulationMode, confirmationCount, humanVerification, actorUserId]);
      return mapPreset(result.rows[0]);
    },

    async selectPreset(userId, presetKey) {
      const key = normalizePresetKey(presetKey);
      if (!PRESET_KEYS.includes(key)) throw new Error('Unknown mode preset');
      await pool.query(`INSERT INTO user_governance (user_id,selected_preset_key) VALUES ($1,$2)
        ON CONFLICT (user_id) DO UPDATE SET selected_preset_key=$2,updated_at=NOW()`, [userId, key]);
      return key;
    },

    async getEffectiveGovernance(userId, chain) {
      const result = await pool.query(`SELECT u.is_owner,ug.max_transaction_value_wei AS user_max,
        ug.daily_spending_budget_wei AS user_daily,ug.gas_ceiling_gwei AS user_gas,
        ug.simulation_forced AS user_simulation_forced,
        sg.max_transaction_value_wei AS group_max,sg.daily_spending_budget_wei AS group_daily,
        sg.gas_ceiling_gwei AS group_gas,sg.simulation_forced AS group_simulation_forced,
        mp.* FROM users u LEFT JOIN user_governance ug ON ug.user_id=u.user_id
        LEFT JOIN seat_groups sg ON sg.group_id=ug.group_id
        LEFT JOIN mode_presets mp ON mp.preset_key=ug.selected_preset_key WHERE u.user_id=$1`, [userId]);
      if (!result.rowCount) throw new Error('User not found');
      const row = result.rows[0];
      const defaults = defaultPolicy(chain);
      return {
        isOwner: row.is_owner,
        maxTransactionValueWei: BigInt(row.user_max ?? row.group_max ?? defaults.maxTransactionValueWei),
        dailySpendingBudgetWei: BigInt(row.user_daily ?? row.group_daily ?? defaults.dailySpendingBudgetWei),
        gasCeilingGwei: Number(row.user_gas ?? row.group_gas ?? defaults.gasCeilingGwei),
        simulationForced: row.user_simulation_forced ?? row.group_simulation_forced ?? true,
        preset: mapPreset(row),
      };
    },
  };
}

module.exports = { PRESET_KEYS, createPostgresGovernanceRepository, normalizePresetKey };

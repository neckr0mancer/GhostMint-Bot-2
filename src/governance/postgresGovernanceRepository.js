const { defaultPolicy } = require('../transactions/defaults');
const { ValidationError } = require('../validation/domain');

const PRESET_KEYS = Object.freeze(['ultra_fast', 'fast', 'semi_safe', 'safe']);

function normalizePresetKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
}

function mapPreset(row) {
  if (!row?.preset_key) return null;
  return {
    key: row.preset_key,
    displayName: row.display_name,
    simulationMode: row.simulation_mode,
    confirmationCount: Number(row.confirmation_count),
    humanVerification: row.human_verification,
    gasPriceMultiplier: Number(row.gas_price_multiplier),
    isDefault: row.is_default === true,
  };
}

// Degen (ultra_fast) and Fast trade away enough safety (skipped/lightened confirmation and
// verification) that picking them requires opt-in: either the caller's seat group allows it for
// everyone assigned to it, or the caller has been granted it individually regardless of group.
const ADVANCED_PRESET_KEYS = Object.freeze(['ultra_fast', 'fast']);

// Owners always get Degen/Fast unlocked -- never force-selected, just made pickable, the same way
// ceiling-exemption is an availability, not a forced change to what a user already has active.
async function checkAdvancedModesAllowed(pool, userId) {
  const result = await pool.query(`SELECT u.is_owner,COALESCE(ug.advanced_modes_allowed,sg.advanced_modes_allowed,FALSE) AS allowed
    FROM users u LEFT JOIN user_governance ug ON ug.user_id=u.user_id
    LEFT JOIN seat_groups sg ON sg.group_id=ug.group_id WHERE u.user_id=$1`, [userId]);
  const row = result.rows[0];
  return row?.is_owner === true || row?.allowed === true;
}

function createPostgresGovernanceRepository(pool) {
  return {
    async isOwner(userId) {
      const result = await pool.query('SELECT is_owner FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.is_owner === true;
    },

    async isRootOwner(userId) {
      const result = await pool.query('SELECT is_root_owner FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.is_root_owner === true;
    },

    async findUserByPlatform(platform, platformUserId) {
      const result = await pool.query(
        'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2',
        [platform, String(platformUserId)],
      );
      return result.rows[0]?.user_id || null;
    },

    async setOwner(userId, enabled) {
      const current = await pool.query('SELECT is_owner,is_root_owner FROM users WHERE user_id=$1', [userId]);
      if (!current.rowCount) throw new Error('User not found');
      if (!enabled) {
        if (current.rows[0].is_root_owner) throw new Error('User is a root owner -- remove root owner status first');
        if (current.rows[0].is_owner) {
          const count = await pool.query('SELECT COUNT(*)::INTEGER AS count FROM users WHERE is_owner=TRUE');
          if (count.rows[0].count <= 1) throw new Error('Cannot remove the last owner');
        }
      }
      const result = await pool.query('UPDATE users SET is_owner=$2 WHERE user_id=$1 RETURNING user_id,is_owner', [userId, enabled]);
      return result.rows[0];
    },

    // Root owners are capped at 2 and can only be drawn from existing owners -- promoting straight
    // from a regular user would let someone skip the regular-owner step entirely. Mirrors setOwner's
    // "cannot remove the last owner" protection one tier up: at least one root owner must always remain.
    async setRootOwner(userId, enabled) {
      const current = await pool.query('SELECT is_owner,is_root_owner FROM users WHERE user_id=$1', [userId]);
      if (!current.rowCount) throw new Error('User not found');
      if (enabled) {
        if (current.rows[0].is_root_owner) return { user_id: userId, is_root_owner: true };
        if (!current.rows[0].is_owner) throw new Error('User must already be an owner before becoming a root owner');
        const count = await pool.query('SELECT COUNT(*)::INTEGER AS count FROM users WHERE is_root_owner=TRUE');
        if (count.rows[0].count >= 2) throw new Error('There are already 2 root owners -- remove one first');
      } else if (current.rows[0].is_root_owner) {
        const count = await pool.query('SELECT COUNT(*)::INTEGER AS count FROM users WHERE is_root_owner=TRUE');
        if (count.rows[0].count <= 1) throw new Error('Cannot remove the last root owner');
      }
      const result = await pool.query('UPDATE users SET is_root_owner=$2 WHERE user_id=$1 RETURNING user_id,is_root_owner', [userId, enabled]);
      return result.rows[0];
    },

    async upsertGroup({ actorUserId, name, maxTransactionValueWei, dailySpendingBudgetWei, gasCeilingGwei, simulationForced, advancedModesAllowed }) {
      const result = await pool.query(`INSERT INTO seat_groups
        (name,max_transaction_value_wei,daily_spending_budget_wei,gas_ceiling_gwei,simulation_forced,advanced_modes_allowed,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT ((LOWER(name))) DO UPDATE SET
          max_transaction_value_wei=EXCLUDED.max_transaction_value_wei,
          daily_spending_budget_wei=EXCLUDED.daily_spending_budget_wei,
          gas_ceiling_gwei=EXCLUDED.gas_ceiling_gwei,
          simulation_forced=EXCLUDED.simulation_forced,
          advanced_modes_allowed=EXCLUDED.advanced_modes_allowed,updated_at=NOW()
        RETURNING *`, [name, maxTransactionValueWei.toString(), dailySpendingBudgetWei.toString(), gasCeilingGwei, simulationForced, advancedModesAllowed, actorUserId]);
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

    async setUserAdvancedModes({ actorUserId, userId, advancedModesAllowed }) {
      await pool.query(`INSERT INTO user_governance (user_id,advanced_modes_allowed,updated_by)
        VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET
        advanced_modes_allowed=EXCLUDED.advanced_modes_allowed,updated_by=$3,updated_at=NOW()`,
      [userId, advancedModesAllowed, actorUserId]);
    },

    async setGroupSimulation(groupName, simulationForced) {
      const result = await pool.query('UPDATE seat_groups SET simulation_forced=$2,updated_at=NOW() WHERE LOWER(name)=LOWER($1)', [groupName, simulationForced]);
      if (!result.rowCount) throw new Error('Group not found');
    },

    async updatePreset({ actorUserId, presetKey, simulationMode, confirmationCount, humanVerification, gasPriceMultiplier }) {
      const key = normalizePresetKey(presetKey);
      if (!PRESET_KEYS.includes(key)) throw new Error('Unknown mode preset');
      const result = await pool.query(`UPDATE mode_presets SET simulation_mode=$2,
        confirmation_count=$3,human_verification=$4,gas_price_multiplier=COALESCE($5,gas_price_multiplier),updated_by=$6,updated_at=NOW()
        WHERE preset_key=$1 RETURNING *`, [key, simulationMode, confirmationCount, humanVerification, gasPriceMultiplier ?? null, actorUserId]);
      return mapPreset(result.rows[0]);
    },

    async selectPreset(userId, presetKey) {
      const key = normalizePresetKey(presetKey);
      if (!PRESET_KEYS.includes(key)) throw new Error('Unknown mode preset');
      if (ADVANCED_PRESET_KEYS.includes(key) && !await checkAdvancedModesAllowed(pool, userId)) {
        throw new ValidationError({ field: 'preset', message: 'Degen and Fast require group access or a manual admin grant -- ask an owner to enable it.' });
      }
      await pool.query(`INSERT INTO user_governance (user_id,selected_preset_key) VALUES ($1,$2)
        ON CONFLICT (user_id) DO UPDATE SET selected_preset_key=$2,updated_at=NOW()`, [userId, key]);
      return key;
    },

    // Explicitly clears the caller's selection rather than pointing it at whatever preset is
    // currently the default -- so a later admin change to which preset is_default carries
    // forward automatically for reset users, but not for someone who explicitly chose Normie by
    // name while it happened to also be the default.
    async clearPreset(userId) {
      await pool.query(`INSERT INTO user_governance (user_id,selected_preset_key) VALUES ($1,NULL)
        ON CONFLICT (user_id) DO UPDATE SET selected_preset_key=NULL,updated_at=NOW()`, [userId]);
    },

    isAdvancedModesAllowed(userId) {
      return checkAdvancedModesAllowed(pool, userId);
    },

    async getPreset(presetKey) {
      const key = normalizePresetKey(presetKey);
      if (!PRESET_KEYS.includes(key)) throw new Error('Unknown mode preset');
      const result = await pool.query('SELECT * FROM mode_presets WHERE preset_key=$1', [key]);
      return mapPreset(result.rows[0]);
    },
    async listPresets() {
      const result=await pool.query('SELECT * FROM mode_presets ORDER BY CASE preset_key WHEN \'ultra_fast\' THEN 1 WHEN \'fast\' THEN 2 WHEN \'semi_safe\' THEN 3 ELSE 4 END');
      return result.rows.map(mapPreset);
    },

    async listGroups() {
      const result=await pool.query(`SELECT name,max_transaction_value_wei,daily_spending_budget_wei,
        gas_ceiling_gwei,simulation_forced,advanced_modes_allowed,updated_at FROM seat_groups ORDER BY LOWER(name)`);
      return result.rows.map(row=>({name:row.name,maxTransactionValueWei:row.max_transaction_value_wei,
        dailySpendingBudgetWei:row.daily_spending_budget_wei,gasCeilingGwei:Number(row.gas_ceiling_gwei),
        simulationForced:row.simulation_forced,advancedModesAllowed:row.advanced_modes_allowed,updatedAt:row.updated_at}));
    },

    async listGovernedUsers() {
      const result=await pool.query(`SELECT u.user_id,u.is_owner,u.is_root_owner,u.account_status,u.status_reason,
        u.suspended_until,u.status_changed_at,u.subscription_active,
        u.good_standing_override,sg.name AS group_name,
        ug.max_transaction_value_wei,ug.daily_spending_budget_wei,ug.gas_ceiling_gwei,
        ug.simulation_forced,ug.selected_preset_key,ug.scheduled_removal_at,ug.advanced_modes_allowed,
        sg.max_transaction_value_wei AS group_max,sg.daily_spending_budget_wei AS group_daily,
        sg.gas_ceiling_gwei AS group_gas,sg.simulation_forced AS group_simulation_forced,
        sg.advanced_modes_allowed AS group_advanced,
        COALESCE(JSON_AGG(JSON_BUILD_OBJECT('platform',la.platform,'platformUserId',la.platform_user_id)
          ORDER BY la.platform) FILTER (WHERE la.platform IS NOT NULL),'[]'::JSON) AS linked_accounts,
        GREATEST(
          (SELECT MAX(last_seen_at) FROM dashboard_sessions WHERE user_id=u.user_id AND revoked_at IS NULL),
          (SELECT MAX(occurred_at) FROM activity WHERE user_id=u.user_id)
        ) AS last_active_at
        FROM users u LEFT JOIN user_governance ug ON ug.user_id=u.user_id
        LEFT JOIN seat_groups sg ON sg.group_id=ug.group_id
        LEFT JOIN linked_accounts la ON la.user_id=u.user_id
        GROUP BY u.user_id,u.is_owner,u.is_root_owner,u.account_status,u.status_reason,u.suspended_until,
          u.status_changed_at,u.subscription_active,u.good_standing_override,
          sg.name,ug.max_transaction_value_wei,
          ug.daily_spending_budget_wei,ug.gas_ceiling_gwei,ug.simulation_forced,ug.selected_preset_key,
          ug.scheduled_removal_at,ug.advanced_modes_allowed,
          sg.max_transaction_value_wei,sg.daily_spending_budget_wei,sg.gas_ceiling_gwei,
          sg.simulation_forced,sg.advanced_modes_allowed
        ORDER BY u.created_at`);
      // Resolved fields fold in the same fallback chain enforcement actually uses (own override ->
      // group -> system default) so the UI can show what really applies instead of a bare "inherit"
      // that leaves the admin to guess. Simulation/advanced-modes are chain-independent, so fully
      // resolvable here; ceilings are chain-dependent (see defaultPolicy) so only the group's own
      // number is resolved -- with no group either, the UI falls back to "system default" wording.
      return result.rows.map(row=>({userId:row.user_id,isOwner:row.is_owner,isRootOwner:row.is_root_owner,accountStatus:row.account_status,
        statusReason:row.status_reason,suspendedUntil:row.suspended_until,statusChangedAt:row.status_changed_at,
        subscriptionActive:row.subscription_active,goodStandingOverride:row.good_standing_override,
        groupName:row.group_name,
        maxTransactionValueWei:row.max_transaction_value_wei,dailySpendingBudgetWei:row.daily_spending_budget_wei,
        gasCeilingGwei:row.gas_ceiling_gwei===null?null:Number(row.gas_ceiling_gwei),
        groupMaxTransactionValueWei:row.group_max,groupDailySpendingBudgetWei:row.group_daily,
        groupGasCeilingGwei:row.group_gas===null?null:Number(row.group_gas),
        simulationForced:row.simulation_forced,selectedPresetKey:row.selected_preset_key,
        scheduledRemovalAt:row.scheduled_removal_at,advancedModesAllowed:row.advanced_modes_allowed,
        resolvedSimulationForced:row.simulation_forced??row.group_simulation_forced??true,
        resolvedAdvancedModesAllowed:row.is_owner||row.advanced_modes_allowed||row.group_advanced||false,
        lastActiveAt:row.last_active_at,
        linkedAccounts:row.linked_accounts}));
    },

    // So an admin write can notify every currently-connected owner, not just whoever made the
    // change -- broadcastToUser alone only ever reaches the acting admin's own session.
    async listOwnerUserIds() {
      const result = await pool.query('SELECT user_id FROM users WHERE is_owner=TRUE');
      return result.rows.map(row => row.user_id);
    },

    // activeUsers is deliberately narrow (dashboard sessions only, 15-minute window) -- it answers
    // "who's on the dashboard right now." activeAnyPlatform24h answers the broader question admins
    // actually care about day to day: who's been doing anything at all, including a Telegram/Discord
    // user who has never once opened the dashboard. Neither metric replaces the other.
    async getAdminOverviewMetrics() {
      const result = await pool.query(`SELECT
        (SELECT COUNT(*)::INTEGER FROM users) AS total_users,
        (SELECT COUNT(*)::INTEGER FROM users WHERE is_owner=TRUE) AS owners,
        (SELECT COUNT(*)::INTEGER FROM users WHERE is_root_owner=TRUE) AS root_owners,
        (SELECT COUNT(*)::INTEGER FROM linked_accounts) AS linked_accounts,
        (SELECT COUNT(*)::INTEGER FROM seat_groups) AS groups,
        (SELECT COUNT(DISTINCT user_id)::INTEGER FROM dashboard_sessions
          WHERE revoked_at IS NULL AND expires_at>NOW()
            AND last_seen_at>=NOW()-INTERVAL '15 minutes') AS active_users,
        (SELECT COUNT(DISTINCT user_id)::INTEGER FROM (
          SELECT user_id FROM dashboard_sessions
            WHERE revoked_at IS NULL AND expires_at>NOW() AND last_seen_at>=NOW()-INTERVAL '15 minutes'
          UNION
          SELECT user_id FROM activity WHERE occurred_at>=NOW()-INTERVAL '24 hours'
        ) combined) AS active_any_platform_24h`);
      const row = result.rows[0];
      return { totalUsers:row.total_users, activeUsers:row.active_users, activeAnyPlatform24h:row.active_any_platform_24h,
        linkedAccounts:row.linked_accounts, groups:row.groups, owners:row.owners, rootOwners:row.root_owners,
        activeWindowMinutes:15 };
    },

    async getEffectiveGovernance(userId, chain) {
      const result = await pool.query(`SELECT u.is_owner,ug.max_transaction_value_wei AS user_max,
        ug.daily_spending_budget_wei AS user_daily,ug.gas_ceiling_gwei AS user_gas,
        ug.simulation_forced AS user_simulation_forced,
        ug.advanced_modes_allowed AS user_advanced,sg.advanced_modes_allowed AS group_advanced,
        sg.max_transaction_value_wei AS group_max,sg.daily_spending_budget_wei AS group_daily,
        sg.gas_ceiling_gwei AS group_gas,sg.simulation_forced AS group_simulation_forced,
        mp.* FROM users u LEFT JOIN user_governance ug ON ug.user_id=u.user_id
        LEFT JOIN seat_groups sg ON sg.group_id=ug.group_id
        LEFT JOIN mode_presets mp ON mp.preset_key=COALESCE(ug.selected_preset_key,(SELECT preset_key FROM mode_presets WHERE is_default))
        WHERE u.user_id=$1`, [userId]);
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
        advancedModesAllowed: row.is_owner || row.user_advanced || row.group_advanced || false,
      };
    },

    // ── Milestone 16a: account lifecycle (ban/suspend/deactivate/reinstate) ──
    async setAccountStatus(userId, { status, reason, actorUserId, suspendedUntil = null }) {
      const result = await pool.query(`UPDATE users SET account_status=$2,status_reason=$3,
        status_changed_at=NOW(),status_changed_by=$4,suspended_until=$5
        WHERE user_id=$1 RETURNING user_id,account_status,status_reason,suspended_until`,
      [userId, status, reason, actorUserId, status === 'suspended' ? suspendedUntil : null]);
      if (!result.rowCount) throw new Error('User not found');
      return result.rows[0];
    },

    async getAccountStatus(userId) {
      const result = await pool.query(
        'SELECT account_status,status_reason,suspended_until,is_owner,is_root_owner FROM users WHERE user_id=$1', [userId]);
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return { status: row.account_status, reason: row.status_reason,
        suspendedUntil: row.suspended_until, isOwner: row.is_owner, isRootOwner: row.is_root_owner };
    },

    // Flips a time-boxed suspension back to active once suspended_until has passed. Called from the
    // identity-resolution choke point so this self-heals on the user's next command with no worker
    // or cron needed -- an indefinite suspension (suspended_until IS NULL) is never auto-lifted.
    async autoReinstateIfExpired(userId) {
      const result = await pool.query(`UPDATE users SET account_status='active',suspended_until=NULL,
        status_reason='Suspension period ended',status_changed_at=NOW()
        WHERE user_id=$1 AND account_status='suspended' AND suspended_until IS NOT NULL AND suspended_until<=NOW()
        RETURNING user_id`, [userId]);
      return result.rowCount > 0;
    },

    async setSubscriptionActive(userId, active) {
      const result = await pool.query(
        'UPDATE users SET subscription_active=$2 WHERE user_id=$1 RETURNING user_id,subscription_active',
        [userId, active]);
      if (!result.rowCount) throw new Error('User not found');
      return result.rows[0];
    },

    async setGoodStandingOverride(userId, enabled) {
      const result = await pool.query(
        'UPDATE users SET good_standing_override=$2 WHERE user_id=$1 RETURNING user_id,good_standing_override',
        [userId, enabled]);
      if (!result.rowCount) throw new Error('User not found');
      return result.rows[0];
    },

    // ── Milestone 16b: governance-group retention scheduling ──
    async setGroupRetentionPolicy(groupName, { retentionPeriodDays, requireActiveSubscription, requireRecentActivityDays }) {
      const result = await pool.query(`UPDATE seat_groups SET retention_period_days=$2,
        require_active_subscription=$3,require_recent_activity_days=$4,updated_at=NOW()
        WHERE LOWER(name)=LOWER($1) RETURNING *`,
      [groupName, retentionPeriodDays, requireActiveSubscription, requireRecentActivityDays]);
      if (!result.rowCount) throw new Error('Group not found');
      return result.rows[0];
    },

    async scheduleRemoval(userId, removalAt) {
      const result = await pool.query(`INSERT INTO user_governance (user_id,scheduled_removal_at) VALUES ($1,$2)
        ON CONFLICT (user_id) DO UPDATE SET scheduled_removal_at=$2,updated_at=NOW()
        RETURNING user_id,group_id,scheduled_removal_at`, [userId, removalAt]);
      if (!result.rows[0].group_id) throw new Error('User is not assigned to a group');
      return result.rows[0];
    },

    // Due items joined with everything the worker needs to evaluate them in one round trip: the
    // group's configured retention policy, the user's subscription/override flags, and their most
    // recent activity timestamp (there is no dedicated last-activity column -- MAX(occurred_at) on
    // the existing append-only activity log is the only signal of bot usage recency today).
    async listDueRetentions(now) {
      const result = await pool.query(`SELECT ug.user_id,ug.group_id,ug.scheduled_removal_at,
          sg.name AS group_name,sg.retention_period_days,sg.require_active_subscription,
          sg.require_recent_activity_days,u.subscription_active,u.good_standing_override,
          (SELECT MAX(occurred_at) FROM activity WHERE activity.user_id=ug.user_id) AS last_activity_at
        FROM user_governance ug
        JOIN seat_groups sg ON sg.group_id=ug.group_id
        JOIN users u ON u.user_id=ug.user_id
        WHERE ug.scheduled_removal_at IS NOT NULL AND ug.scheduled_removal_at<=$1`, [now]);
      return result.rows.map(row => ({
        userId: row.user_id, groupId: row.group_id, groupName: row.group_name,
        scheduledRemovalAt: row.scheduled_removal_at, retentionPeriodDays: row.retention_period_days,
        requireActiveSubscription: row.require_active_subscription,
        requireRecentActivityDays: row.require_recent_activity_days,
        subscriptionActive: row.subscription_active, goodStandingOverride: row.good_standing_override,
        lastActivityAt: row.last_activity_at,
      }));
    },

    // Both renewal and removal are guarded by an optimistic-concurrency WHERE clause on the exact
    // scheduled_removal_at value the worker just read, so a due item can never be double-processed
    // (renewed and removed, or renewed twice) even if the worker's poll loop overlaps a slow tick.
    async renewRetention({ userId, groupId, previousScheduledRemovalAt, nextScheduledRemovalAt, reason }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(`UPDATE user_governance SET scheduled_removal_at=$3,
            retention_renewed_at=NOW(),updated_at=NOW()
          WHERE user_id=$1 AND group_id=$2 AND scheduled_removal_at=$4
          RETURNING user_id`, [userId, groupId, nextScheduledRemovalAt, previousScheduledRemovalAt]);
        if (updated.rowCount) {
          await client.query(`INSERT INTO group_retention_events
            (user_id,group_id,outcome,reason,previous_scheduled_removal_at,next_scheduled_removal_at)
            VALUES ($1,$2,'renewed',$3,$4,$5)`,
          [userId, groupId, reason, previousScheduledRemovalAt, nextScheduledRemovalAt]);
        }
        await client.query('COMMIT');
        return updated.rowCount > 0;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },

    async removeFromGroupForRetention({ userId, groupId, previousScheduledRemovalAt, reason }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(`UPDATE user_governance SET group_id=NULL,
            scheduled_removal_at=NULL,retention_renewed_at=NULL,updated_at=NOW()
          WHERE user_id=$1 AND group_id=$2 AND scheduled_removal_at=$3
          RETURNING user_id`, [userId, groupId, previousScheduledRemovalAt]);
        if (updated.rowCount) {
          await client.query(`INSERT INTO group_retention_events
            (user_id,group_id,outcome,reason,previous_scheduled_removal_at,next_scheduled_removal_at)
            VALUES ($1,$2,'removed',$3,$4,NULL)`,
          [userId, groupId, reason, previousScheduledRemovalAt]);
        }
        await client.query('COMMIT');
        return updated.rowCount > 0;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },

    async listRetentionEvents(userId, { limit = 20 } = {}) {
      const result = await pool.query(
        'SELECT * FROM group_retention_events WHERE user_id=$1 ORDER BY evaluated_at DESC LIMIT $2',
        [userId, limit]);
      return result.rows.map(row => ({
        eventId: row.event_id, userId: row.user_id, groupId: row.group_id, outcome: row.outcome,
        reason: row.reason, previousScheduledRemovalAt: row.previous_scheduled_removal_at,
        nextScheduledRemovalAt: row.next_scheduled_removal_at, evaluatedAt: row.evaluated_at,
      }));
    },
  };
}

module.exports = { PRESET_KEYS, createPostgresGovernanceRepository, normalizePresetKey };

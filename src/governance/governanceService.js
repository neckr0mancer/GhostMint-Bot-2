const { requestSchemas, ValidationError } = require('../validation/domain');

class AuthorizationError extends Error {
  constructor(message = 'Owner access required') {
    super(message);
    this.name = 'AuthorizationError';
    this.code = 'OWNER_REQUIRED';
  }
}

// Thrown by checkAccountStatus (Milestone 16a) for a suspended/banned/deactivated caller. Deliberately
// a distinct class from AuthorizationError: that one means "you're not an owner", this one means "your
// own account is blocked" -- the bot surfaces show a different message for each.
class AccountBlockedError extends Error {
  constructor(status, reason) {
    super(`Account is ${status}${reason ? `: ${reason}` : ''}`);
    this.name = 'AccountBlockedError';
    this.code = 'ACCOUNT_BLOCKED';
    this.status = status;
    this.reason = reason || null;
  }
}

// These throw ValidationError, not a plain Error, on purpose: they are input mistakes an owner
// can immediately fix (wrong platform name, unlinked user, bad on/off value, missing ceiling), and
// every bot surface already knows how to show a ValidationError's message safely to the caller.
// A plain Error here would instead be swallowed into a generic "command failed" reply, which is
// the right behavior for a genuinely unexpected failure but the wrong one for a typo.
function requiredText(value, field, max = 100) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max) throw new ValidationError({ field, message: `is required and must be at most ${max} characters` });
  return normalized;
}

function forcedValue(value, field = 'simulationForced', { nullable = false } = {}) {
  if (nullable && (value === null || value === 'inherit')) return null;
  if (value === true || value === 'forced') return true;
  if (value === false || value === 'optional') return false;
  throw new ValidationError({ field, message: nullable ? 'must be forced, optional, or inherit' : 'must be forced or optional' });
}

function parseOnOff(value, field) {
  if (value === true || value === 'on') return true;
  if (value === false || value === 'off') return false;
  throw new ValidationError({ field, message: 'must be on or off' });
}

function parsePositiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError({ field, message: 'must be a positive whole number' });
  }
  return parsed;
}

// A schedule/period field accepts either "off" (clears/disables it) or a positive integer number of
// days; used by suspension duration, group retention period, and group activity-recency requirement.
function parseOptionalDays(value, field) {
  if (value === undefined || value === null || value === 'off' || value === 'indefinite') return null;
  return parsePositiveInteger(value, field);
}

function validateCeilings(input, { allowClear = false } = {}) {
  const validated = requestSchemas.transactionPolicy({
    maxTransactionValueWei: input.maxTransactionValueWei,
    dailySpendingBudgetWei: input.dailySpendingBudgetWei,
    gasCeilingGwei: input.gasCeilingGwei,
  });
  if (!allowClear && [validated.maxTransactionValueWei, validated.dailySpendingBudgetWei, validated.gasCeilingGwei].some(value => value === null)) {
    throw new ValidationError({ field: 'ceilings', message: 'all three (max value, daily budget, gas ceiling) are required together' });
  }
  return validated;
}

function createGovernanceService(repository) {
  async function requireOwner(callerUserId) {
    if (!await repository.isOwner(callerUserId)) throw new AuthorizationError();
  }

  async function targetUser(platform, platformUserId) {
    const normalizedPlatform = requiredText(platform, 'platform', 16).toLowerCase();
    if (!['telegram', 'discord'].includes(normalizedPlatform)) throw new ValidationError({ field: 'platform', message: 'must be telegram or discord' });
    const userId = await repository.findUserByPlatform(normalizedPlatform, requiredText(platformUserId, 'platformUserId', 255));
    if (!userId) throw new ValidationError({ field: 'platformUserId', message: 'has no linked GhostMint account -- that platform ID must have run a command at least once' });
    return userId;
  }

  // Shared by ban/unban/suspend/unsuspend/deactivate/reactivate: resolves the target, refuses to
  // touch an owner account (mirrors the existing "cannot remove the last owner" invariant on
  // setOwner -- owner status must be revoked first, so account status changes can never be used to
  // silently lock an owner out of their own bot), and requires a reason for every transition so
  // status_changed_at/status_changed_by/status_reason is always a meaningful audit trail.
  async function setStatus(callerUserId, { platform, platformUserId, status, reason, suspendedUntil = null }) {
    await requireOwner(callerUserId);
    const targetId = await targetUser(platform, platformUserId);
    const current = await repository.getAccountStatus(targetId);
    if (current?.isOwner) {
      throw new ValidationError({ field: 'platformUserId', message: 'belongs to an owner -- remove owner status first before changing account status' });
    }
    return repository.setAccountStatus(targetId, {
      status, reason: requiredText(reason, 'reason', 500), actorUserId: callerUserId, suspendedUntil,
    });
  }

  return {
    requireOwner,

    // ── Milestone 16a: account lifecycle ──
    banUser(callerUserId, input) {
      return setStatus(callerUserId, { ...input, status: 'banned' });
    },

    unbanUser(callerUserId, input) {
      return setStatus(callerUserId, { ...input, status: 'active' });
    },

    suspendUser(callerUserId, input) {
      const days = parseOptionalDays(input.durationDays, 'durationDays');
      const suspendedUntil = days === null ? null : new Date(Date.now() + days * 86_400_000);
      return setStatus(callerUserId, { ...input, status: 'suspended', suspendedUntil });
    },

    unsuspendUser(callerUserId, input) {
      return setStatus(callerUserId, { ...input, status: 'active' });
    },

    deactivateUser(callerUserId, input) {
      return setStatus(callerUserId, { ...input, status: 'deactivated' });
    },

    reactivateUser(callerUserId, input) {
      return setStatus(callerUserId, { ...input, status: 'active' });
    },

    async setSubscriptionActive(callerUserId, input) {
      await requireOwner(callerUserId);
      const targetId = await targetUser(input.platform, input.platformUserId);
      return repository.setSubscriptionActive(targetId, parseOnOff(input.active, 'active'));
    },

    async setGoodStandingOverride(callerUserId, input) {
      await requireOwner(callerUserId);
      const targetId = await targetUser(input.platform, input.platformUserId);
      return repository.setGoodStandingOverride(targetId, parseOnOff(input.enabled, 'enabled'));
    },

    // Not owner-gated: called for every user on every command, at the same identity-resolution
    // choke point every platform already funnels through, so a blocked account can never reach any
    // command by using a different bot surface. Self-heals a time-boxed suspension whose window has
    // passed without needing a worker or cron.
    async checkAccountStatus(userId) {
      await repository.autoReinstateIfExpired(userId);
      const status = await repository.getAccountStatus(userId);
      if (!status || status.status === 'active' || status.isOwner) return;
      throw new AccountBlockedError(status.status, status.reason);
    },

    // ── Milestone 16b: governance-group retention scheduling ──
    async setGroupRetentionPolicy(callerUserId, input) {
      await requireOwner(callerUserId);
      const name = requiredText(input.groupName, 'groupName');
      const retentionPeriodDays = parseOptionalDays(input.retentionPeriodDays, 'retentionPeriodDays');
      const requireActiveSubscription = parseOnOff(input.requireActiveSubscription, 'requireActiveSubscription');
      const requireRecentActivityDays = parseOptionalDays(input.requireRecentActivityDays, 'requireRecentActivityDays');
      return repository.setGroupRetentionPolicy(name, { retentionPeriodDays, requireActiveSubscription, requireRecentActivityDays });
    },

    async scheduleRemoval(callerUserId, input) {
      await requireOwner(callerUserId);
      const targetId = await targetUser(input.platform, input.platformUserId);
      const days = parseOptionalDays(input.days, 'days');
      const removalAt = days === null ? null : new Date(Date.now() + days * 86_400_000);
      try {
        return await repository.scheduleRemoval(targetId, removalAt);
      } catch (error) {
        if (error.message === 'User is not assigned to a group') {
          throw new ValidationError({ field: 'platformUserId', message: 'is not assigned to a governance group -- assign one first' });
        }
        throw error;
      }
    },

    async upsertGroup(callerUserId, input) {
      await requireOwner(callerUserId);
      const ceilings = validateCeilings(input);
      return repository.upsertGroup({ actorUserId: callerUserId, name: requiredText(input.name, 'name'),
        ...ceilings, simulationForced: forcedValue(input.simulationForced) });
    },

    async deleteGroup(callerUserId, name) {
      await requireOwner(callerUserId);
      return repository.deleteGroup(requiredText(name, 'name'));
    },

    async assignGroup(callerUserId, input) {
      await requireOwner(callerUserId);
      return repository.assignGroup(await targetUser(input.platform, input.platformUserId), requiredText(input.groupName, 'groupName'));
    },

    async removeGroup(callerUserId, input) {
      await requireOwner(callerUserId);
      return repository.removeGroup(await targetUser(input.platform, input.platformUserId));
    },

    async setUserCeilings(callerUserId, input) {
      await requireOwner(callerUserId);
      const userId = await targetUser(input.platform, input.platformUserId);
      const ceilings = input.clear ? validateCeilings({}, { allowClear: true }) : validateCeilings(input);
      return repository.setUserCeilings({ actorUserId: callerUserId, userId, ...ceilings });
    },

    async setUserSimulation(callerUserId, input) {
      await requireOwner(callerUserId);
      return repository.setUserSimulation({ actorUserId: callerUserId,
        userId: await targetUser(input.platform, input.platformUserId),
        simulationForced: forcedValue(input.simulationForced, 'simulationForced', { nullable: true }) });
    },

    async setGroupSimulation(callerUserId, input) {
      await requireOwner(callerUserId);
      return repository.setGroupSimulation(requiredText(input.groupName, 'groupName'), forcedValue(input.simulationForced, 'simulationForced', { nullable: true }));
    },

    async updatePreset(callerUserId, input) {
      await requireOwner(callerUserId);
      const simulationMode = requiredText(input.simulationMode, 'simulationMode', 32).toLowerCase();
      const humanVerification = requiredText(input.humanVerification, 'humanVerification', 16).toLowerCase();
      if (!['on', 'off', 'blockchain_off'].includes(simulationMode)) throw new ValidationError({ field: 'simulationMode', message: 'must be on, off, or blockchain_off' });
      if (!['on', 'bypass'].includes(humanVerification)) throw new ValidationError({ field: 'humanVerification', message: 'must be on or bypass' });
      const { requiredConfirmations } = requestSchemas.transactionPolicy({ requiredConfirmations: input.confirmationCount });
      return repository.updatePreset({ actorUserId: callerUserId, presetKey: input.presetKey,
        simulationMode, confirmationCount: requiredConfirmations, humanVerification });
    },

    async setOwner(callerUserId, input) {
      await requireOwner(callerUserId);
      if (![true, false, 'on', 'off'].includes(input.enabled)) throw new ValidationError({ field: 'enabled', message: 'must be on or off' });
      return repository.setOwner(await targetUser(input.platform, input.platformUserId), input.enabled === true || input.enabled === 'on');
    },

    async dashboardOverview(callerUserId) {
      await requireOwner(callerUserId);
      const [groups,users,presets]=await Promise.all([
        repository.listGroups(),repository.listGovernedUsers(),repository.listPresets(),
      ]);
      return {groups,users,presets};
    },

    async effectiveForLinkedUser(callerUserId,input) {
      await requireOwner(callerUserId);
      const userId=await targetUser(input.platform,input.platformUserId);
      const effective=await repository.getEffectiveGovernance(userId,input.chain);
      if(effective.isOwner)return {userId,isOwner:true,ceilingExempt:true,maxTransactionValueWei:null,
        dailySpendingBudgetWei:null,gasCeilingGwei:null,simulationForced:effective.simulationForced,preset:effective.preset};
      return {...effective,userId,isOwner:false,ceilingExempt:false};
    },

    selectPreset(userId, presetKey) {
      return repository.selectPreset(userId, presetKey);
    },
  };
}

module.exports = { AccountBlockedError, AuthorizationError, createGovernanceService, forcedValue, validateCeilings };

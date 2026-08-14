const { requestSchemas, ValidationError } = require('../validation/domain');

class AuthorizationError extends Error {
  constructor(message = 'Owner access required') {
    super(message);
    this.name = 'AuthorizationError';
    this.code = 'OWNER_REQUIRED';
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

  return {
    requireOwner,

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

module.exports = { AuthorizationError, createGovernanceService, forcedValue, validateCeilings };

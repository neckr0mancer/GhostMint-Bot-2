const { requestSchemas } = require('../validation/domain');

class AuthorizationError extends Error {
  constructor(message = 'Owner access required') {
    super(message);
    this.name = 'AuthorizationError';
    this.code = 'OWNER_REQUIRED';
  }
}

function requiredText(value, field, max = 100) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max) throw new Error(`${field} is required and must be at most ${max} characters`);
  return normalized;
}

function forcedValue(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === 'inherit')) return null;
  if (value === true || value === 'forced') return true;
  if (value === false || value === 'optional') return false;
  throw new Error(nullable ? 'Simulation must be forced, optional, or inherit' : 'Simulation must be forced or optional');
}

function validateCeilings(input, { allowClear = false } = {}) {
  const validated = requestSchemas.transactionPolicy({
    maxTransactionValueWei: input.maxTransactionValueWei,
    dailySpendingBudgetWei: input.dailySpendingBudgetWei,
    gasCeilingGwei: input.gasCeilingGwei,
  });
  if (!allowClear && [validated.maxTransactionValueWei, validated.dailySpendingBudgetWei, validated.gasCeilingGwei].some(value => value === null)) {
    throw new Error('All three ceilings are required');
  }
  return validated;
}

function createGovernanceService(repository) {
  async function requireOwner(callerUserId) {
    if (!await repository.isOwner(callerUserId)) throw new AuthorizationError();
  }

  async function targetUser(platform, platformUserId) {
    const normalizedPlatform = requiredText(platform, 'platform', 16).toLowerCase();
    if (!['telegram', 'discord'].includes(normalizedPlatform)) throw new Error('Platform must be telegram or discord');
    const userId = await repository.findUserByPlatform(normalizedPlatform, requiredText(platformUserId, 'platformUserId', 255));
    if (!userId) throw new Error('Linked user not found');
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
        simulationForced: forcedValue(input.simulationForced, { nullable: true }) });
    },

    async setGroupSimulation(callerUserId, input) {
      await requireOwner(callerUserId);
      return repository.setGroupSimulation(requiredText(input.groupName, 'groupName'), forcedValue(input.simulationForced, { nullable: true }));
    },

    async updatePreset(callerUserId, input) {
      await requireOwner(callerUserId);
      const simulationMode = requiredText(input.simulationMode, 'simulationMode', 32).toLowerCase();
      const humanVerification = requiredText(input.humanVerification, 'humanVerification', 16).toLowerCase();
      if (!['on', 'off', 'blockchain_off'].includes(simulationMode)) throw new Error('Simulation mode must be on, off, or blockchain_off');
      if (!['on', 'bypass'].includes(humanVerification)) throw new Error('Human verification must be on or bypass');
      const { requiredConfirmations } = requestSchemas.transactionPolicy({ requiredConfirmations: input.confirmationCount });
      return repository.updatePreset({ actorUserId: callerUserId, presetKey: input.presetKey,
        simulationMode, confirmationCount: requiredConfirmations, humanVerification });
    },

    async setOwner(callerUserId, input) {
      await requireOwner(callerUserId);
      if (![true, false, 'on', 'off'].includes(input.enabled)) throw new Error('Owner status must be on or off');
      return repository.setOwner(await targetUser(input.platform, input.platformUserId), input.enabled === true || input.enabled === 'on');
    },

    selectPreset(userId, presetKey) {
      return repository.selectPreset(userId, presetKey);
    },
  };
}

module.exports = { AuthorizationError, createGovernanceService, forcedValue, validateCeilings };

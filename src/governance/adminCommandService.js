const { ValidationError } = require('../validation/domain');

function createAdminCommandService(governance) {
  return {
    async execute(callerUserId, input) {
      await governance.requireOwner(callerUserId);
      const [action, ...args] = String(input || '').trim().split(/\s+/);
      if (!action) throw new ValidationError({ field: 'action', message: 'is required' });
      switch (action.toLowerCase()) {
        case 'group-set':
          await governance.upsertGroup(callerUserId, { name: args[0], maxTransactionValueWei: args[1],
            dailySpendingBudgetWei: args[2], gasCeilingGwei: args[3], simulationForced: args[4] });
          return `Group ${args[0]} saved.`;
        case 'group-delete':
          await governance.deleteGroup(callerUserId, args[0]); return `Group ${args[0]} deleted.`;
        case 'assign':
          await governance.assignGroup(callerUserId, { platform: args[0], platformUserId: args[1], groupName: args[2] });
          return `User assigned to ${args[2]}.`;
        case 'unassign':
          await governance.removeGroup(callerUserId, { platform: args[0], platformUserId: args[1] });
          return 'User removed from their group.';
        case 'user-ceilings':
          await governance.setUserCeilings(callerUserId, { platform: args[0], platformUserId: args[1],
            maxTransactionValueWei: args[2], dailySpendingBudgetWei: args[3], gasCeilingGwei: args[4] });
          return 'User ceilings saved.';
        case 'user-ceilings-clear':
          await governance.setUserCeilings(callerUserId, { platform: args[0], platformUserId: args[1], clear: true });
          return 'User ceiling overrides cleared.';
        case 'user-simulation':
          await governance.setUserSimulation(callerUserId, { platform: args[0], platformUserId: args[1], simulationForced: args[2] });
          return 'User simulation rule saved.';
        case 'group-simulation':
          await governance.setGroupSimulation(callerUserId, { groupName: args[0], simulationForced: args[1] });
          return 'Group simulation rule saved.';
        case 'preset-set':
          await governance.updatePreset(callerUserId, { presetKey: args[0], simulationMode: args[1],
            confirmationCount: args[2], humanVerification: args[3] });
          return `Preset ${args[0]} updated.`;
        case 'owner':
          await governance.setOwner(callerUserId, { platform: args[0], platformUserId: args[1], enabled: args[2] });
          return 'Owner status updated.';
        default: throw new ValidationError({ field: 'action', message: `is unknown: ${action}` });
      }
    },
  };
}

module.exports = { createAdminCommandService };

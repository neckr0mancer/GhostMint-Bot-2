const { ValidationError } = require('../validation/domain');

function createAdminCommandService(governance, identity) {
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
            confirmationCount: args[2], humanVerification: args[3], gasPriceMultiplier: args[4] });
          return `Preset ${args[0]} updated.`;
        case 'owner':
          await governance.setOwner(callerUserId, { platform: args[0], platformUserId: args[1], enabled: args[2] });
          return 'Owner status updated.';
        case 'root-owner':
          await governance.setRootOwner(callerUserId, { platform: args[0], platformUserId: args[1], enabled: args[2] });
          return 'Root owner status updated.';

        // ── Milestone 16a: account lifecycle ──
        case 'ban':
          await governance.banUser(callerUserId, { platform: args[0], platformUserId: args[1], reason: args.slice(2).join(' ') });
          return 'Account banned.';
        case 'unban':
          await governance.unbanUser(callerUserId, { platform: args[0], platformUserId: args[1], reason: args.slice(2).join(' ') });
          return 'Account unbanned.';
        case 'suspend':
          await governance.suspendUser(callerUserId, { platform: args[0], platformUserId: args[1],
            durationDays: args[2], reason: args.slice(3).join(' ') });
          return 'Account suspended.';
        case 'unsuspend':
          await governance.unsuspendUser(callerUserId, { platform: args[0], platformUserId: args[1], reason: args.slice(2).join(' ') });
          return 'Account unsuspended.';
        case 'deactivate':
          await governance.deactivateUser(callerUserId, { platform: args[0], platformUserId: args[1], reason: args.slice(2).join(' ') });
          return 'Account deactivated. Wallets, tasks, and activity are retained; run reactivate to restore access.';
        case 'reactivate':
          await governance.reactivateUser(callerUserId, { platform: args[0], platformUserId: args[1], reason: args.slice(2).join(' ') });
          return 'Account reactivated.';
        case 'subscription':
          await governance.setSubscriptionActive(callerUserId, { platform: args[0], platformUserId: args[1], active: args[2] });
          return 'Subscription status updated.';
        case 'good-standing':
          await governance.setGoodStandingOverride(callerUserId, { platform: args[0], platformUserId: args[1], enabled: args[2] });
          return 'Good-standing override updated.';

        // ── Milestone 16b: governance-group retention scheduling ──
        case 'group-retention':
          await governance.setGroupRetentionPolicy(callerUserId, { groupName: args[0], retentionPeriodDays: args[1],
            requireActiveSubscription: args[2], requireRecentActivityDays: args[3] });
          return `Retention policy for ${args[0]} saved.`;
        case 'schedule-removal':
          await governance.scheduleRemoval(callerUserId, { platform: args[0], platformUserId: args[1], days: args[2] });
          return args[2] === 'off' ? 'Scheduled removal cleared.' : 'Scheduled removal set.';

        // ── Merge an empty platform-created duplicate account into an existing one ──
        case 'merge-account': {
          if (!identity) throw new ValidationError({ field: 'action', message: 'merge-account is not available' });
          const result = await identity.mergeAccount({ sourcePlatform: args[0], sourcePlatformUserId: args[1],
            targetPlatform: args[2], targetPlatformUserId: args[3] });
          return `Merged ${args[0]}:${args[1]} into account ${result.targetUserId}; the empty duplicate account has been removed.`;
        }

        default: throw new ValidationError({ field: 'action', message: `is unknown: ${action}` });
      }
    },
  };
}

module.exports = { createAdminCommandService };

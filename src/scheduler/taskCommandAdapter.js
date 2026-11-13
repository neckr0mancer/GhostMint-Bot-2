const { taskPolicyInput } = require('./schedulePolicyDraft');

function guidedTaskInput(flowData = {}) {
  return {
    name: flowData.name,
    walletLabel: flowData.walletLabel,
    contractAddress: flowData.contractAddress,
    chain: flowData.chain,
    quantity: flowData.quantity || 1,
    priceETH: flowData.priceETH,
    mintTime: flowData.mintTime,
    viaOpenSea: flowData.viaOpenSea,
    stageUuid: flowData.stageUuid,
    stageLabel: flowData.stageLabel,
    stageType: flowData.stageType,
    eligibilityMode: flowData.eligibilityMode,
    eligibilityDeadline: flowData.eligibilityDeadline,
    ...taskPolicyInput(flowData),
  };
}

// The final guided-flow boundary is deliberately shared by Telegram and Discord. Both platforms
// resolve their sender to the canonical internal user before reaching this adapter, and both now
// dispatch the exact same validated command payload. Presentation-only work (clearing the flow and
// rendering success/rate-limit feedback) stays in each platform handler.
async function scheduleTaskFromGuidedFlow({ platform, userId, flowData, commands, rateLimiter }) {
  rateLimiter.check(platform, userId, 'task');
  return commands.createTask(userId, guidedTaskInput(flowData));
}

module.exports = { guidedTaskInput, scheduleTaskFromGuidedFlow };

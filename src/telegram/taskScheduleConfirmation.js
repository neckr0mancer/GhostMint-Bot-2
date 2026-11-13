const telegramMenus = require('./menus');
const { RateLimitError, escapeTelegramHtml } = require('../security/botSecurity');
const { ValidationError, validationReply } = require('../validation/domain');
const { scheduleTaskFromGuidedFlow } = require('../scheduler/taskCommandAdapter');

// This is the real Telegram confirmation boundary, kept outside server.js so the same function
// registered by the callback-query listener can be driven by focused acceptance tests. It owns
// only Telegram presentation/flow lifecycle; canonical validation, persistence and broadcasts stay
// in the shared command service used by Dashboard and Discord.
async function finishTelegramTaskSchedule({
  chatId,
  messageId,
  userId,
  flowData,
  commands,
  rateLimiter,
  flowState,
  update,
  renderFlowStep,
}) {
  const backToMenu = telegramMenus.mainMenu({}).replyMarkup;
  try {
    const task = await scheduleTaskFromGuidedFlow({
      platform: 'telegram', userId, flowData, commands, rateLimiter,
    });
    flowState.clear('telegram', chatId);
    await update(chatId, messageId, telegramMenus.taskScheduled({
      id: task.id,
      name: task.name,
      contractAddress: flowData.contractAddress,
      mintTime: new Date(task.mintTime).toISOString(),
      phaseNumber: flowData.phaseNumber,
      viaOpenSea: task.viaOpenSea,
      phaseAware: Boolean(task.eligibilityDeadline),
    }));
    return task;
  } catch (error) {
    if (error instanceof RateLimitError) {
      const retryIn = Math.ceil(error.retryAfterMs / 1000);
      const confirm = renderFlowStep('task_guided', 'awaiting_confirm', { userId, data: flowData });
      return update(chatId, messageId, {
        ...confirm,
        text: `⏳ Easy — ${retryIn}s of cooldown before the next one. Nothing was lost; hit Schedule again once it clears.\n\n${confirm.text}`,
      });
    }
    flowState.clear('telegram', chatId);
    if (error instanceof ValidationError) {
      return update(chatId, messageId, {
        text: escapeTelegramHtml(validationReply(error)),
        replyMarkup: backToMenu,
        parseMode: 'HTML',
      });
    }
    throw error;
  }
}

module.exports = { finishTelegramTaskSchedule };

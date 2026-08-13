function createNotificationService({ identityRepository, transports = {}, log = () => {} }) {
  return {
    async sendToUser(userId, message) {
      const accounts = await identityRepository.listLinkedAccounts(userId);
      const results = await Promise.allSettled(accounts.map(async account => {
        const send = transports[account.platform];
        if (!send) return;
        await send(account.platformUserId, message);
      }));
      results.forEach((result, index) => {
        if (result.status === 'rejected') log(`Notification to ${accounts[index].platform} failed: ${result.reason?.message || 'unknown error'}`);
      });
      return results;
    },
  };
}

module.exports = { createNotificationService };

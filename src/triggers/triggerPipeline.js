function createTriggerPipeline({ handlers = [], log = () => {} } = {}) {
  return {
    async publish(event) {
      if (!['blockchain-triggered', 'social-triggered'].includes(event?.triggerSource)) {
        throw new Error('Trigger source must be blockchain-triggered or social-triggered');
      }
      const results = await Promise.allSettled(handlers.map(handler => handler(event)));
      results.forEach(result => {
        if (result.status === 'rejected') log(`Trigger handler failed safely: ${result.reason?.message || 'unknown error'}`);
      });
      return results;
    },
  };
}

module.exports = { createTriggerPipeline };

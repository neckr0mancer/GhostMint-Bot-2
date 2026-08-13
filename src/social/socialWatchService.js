const { createHash } = require('node:crypto');
const { getAddress, isAddress } = require('ethers');
const { ValidationError, requestSchemas } = require('../validation/domain');

const ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/g;

function extractContractAddresses(text) {
  const matches = String(text || '').match(ADDRESS_PATTERN) || [];
  const unique = new Map();
  for (const match of matches) {
    if (!isAddress(match)) continue;
    const checksum = getAddress(match);
    unique.set(checksum.toLowerCase(), checksum);
  }
  return [...unique.values()];
}

function contentMatches(rule, item) {
  const text = item.text.toLowerCase();
  if (rule.type === 'twitter_account') return !rule.config.keywords.length || rule.config.keywords.some(keyword => text.includes(keyword));
  if (rule.type === 'discord_channel') return !rule.config.keywords.length || rule.config.keywords.some(keyword => text.includes(keyword));
  return rule.config.keywords.some(keyword => text.includes(keyword));
}

function createSocialWatchService({ repository, adapters, emitTrigger, notifyOwner = async () => {},
  log = () => {}, now = () => Date.now(), pollIntervalMs = 30_000, failureNotifyThreshold = 3,
  dedupWindowMs = 5 * 60_000 }) {
  async function create(userId, input) {
    return repository.create(userId, requestSchemas.watchRuleCreate(input));
  }
  async function update(userId, id, patch) {
    const validatedId = requestSchemas.watchRuleDeletion({ id }).id;
    const current = await repository.get(userId, validatedId);
    if (!current) throw new ValidationError({ field:'id', message:'was not found' });
    const values = requestSchemas.watchRulePatch(patch);
    return repository.update(userId, validatedId, requestSchemas.watchRuleCreate({
      name: values.name ?? current.name, type: values.type ?? current.type,
      method: values.method ?? current.method, config: values.config ?? current.config,
      enabled: values.enabled ?? current.enabled,
    }));
  }
  async function remove(userId, id) {
    const validatedId = requestSchemas.watchRuleDeletion({ id }).id;
    if (!await repository.remove(userId, validatedId)) throw new ValidationError({ field:'id', message:'was not found' });
    return validatedId;
  }
  async function disable(userId, id) { return update(userId, id, { enabled:false }); }

  async function processRule(rule) {
    const adapter = adapters.get(rule.method);
    if (!adapter) throw new Error(`No social adapter registered for ${rule.method}`);
    try {
      const result = await adapter.poll(rule);
      const triggers = [];
      for (const item of result.items) {
        if (!contentMatches(rule, item)) continue;
        const contentHash = createHash('sha256').update(`${item.platform}:${item.id}:${item.text}`).digest('hex');
        for (const address of extractContractAddresses(item.text)) {
          const bucket = Math.floor((item.publishedAt || now()) / dedupWindowMs);
          const dedupKey = createHash('sha256').update(`${rule.userId}:${item.platform}:${address.toLowerCase()}:${bucket}`).digest('hex');
          const event = await repository.createTrigger({ userId:rule.userId, address,
            triggerSource:'social-triggered', platform:item.platform, sourceContentId:item.id,
            sourceUrl:item.url, contentHash, matchedRuleIds:[rule.id], dedupKey });
          if (event) { await emitTrigger(event); triggers.push(event); }
        }
      }
      await repository.markSuccess(rule, { cursor:result.cursor, nextPollAt:now() + pollIntervalMs });
      return triggers;
    } catch (error) {
      const failures = await repository.markFailure(rule, { nextPollAt:now() + (error.retryAfterMs ||
        Math.min(pollIntervalMs * 2 ** Math.min(rule.consecutiveFailures || 0, 6), 60 * 60_000)) });
      log(`Social watch rule ${rule.id} (${rule.method}) failed: ${error.message}`);
      if (failures >= failureNotifyThreshold && failures % failureNotifyThreshold === 0) {
        await Promise.resolve(notifyOwner(rule.userId, `Social watch rule "${rule.name}" has failed ${failures} consecutive times using ${rule.method}. Check its source and adapter configuration.`))
          .catch(notifyError=>log(`Social watch rule ${rule.id} failure notification failed: ${notifyError.message}`));
      }
      return [];
    }
  }

  async function pollOnce() {
    const rules = await repository.listDue(now());
    return Promise.allSettled(rules.map(rule => processRule(rule)));
  }

  return { create, disable, extractContractAddresses, list:userId => repository.list(userId),
    pollOnce, processRule, remove, update };
}

module.exports = { ADDRESS_PATTERN, contentMatches, createSocialWatchService, extractContractAddresses };

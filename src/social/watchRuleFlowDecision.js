// Platform-agnostic "what's next" decisions for the guided social watch-rule create flow,
// mirroring src/mint/mintFlowDecision.js's role for the mint flow: one shared, pure branching
// core both Telegram's server.js and Discord's discordBot.js call, so a future change to which
// fields a rule type needs can't silently diverge between platforms.
//
// Scope: create only. Editing an existing rule's fields after creation stays on the raw
// `/watch edit <id> <json>` form -- showing current values and routing to the right step per
// field is a materially different (and larger) shape than "collect these fields once," and this
// file's sibling change (list/disable/re-enable/remove) covers the rest of the CRUD surface
// without it. Requires src/validation/domain.js's WATCH_RULE_TYPES/WATCH_METHODS to stay in sync
// with configFieldsForType/CONFIG_FIELD_LABELS below by hand -- there's no single source of truth
// linking them across modules.

const CONFIG_FIELDS_BY_TYPE = {
  twitter_account: ['handle'],
  farcaster_account: ['handle'],
  discord_channel: ['channelId'],
  twitter_keyword: ['keywords'],
  discord_keyword: ['keywords'],
  farcaster_keyword: ['keywords'],
};

// Every field name here must exist as a key in CONFIG_FIELD_PROMPTS below, and vice versa --
// tests/watchRuleFlowDecision.test.js checks this so the two can't quietly drift apart.
const CONFIG_FIELD_PROMPTS = {
  handle: { label: 'handle', hint: 'the account handle to watch (without the @)' },
  channelId: { label: 'channel ID', hint: 'the Discord channel ID to watch' },
  keywords: { label: 'keywords', hint: 'one or more keywords to watch for, comma-separated' },
  sourceUrl: { label: 'source URL', hint: 'the credential-free HTTP(S) URL the scraper method reads from' },
};

function configFieldsForType(type) {
  return CONFIG_FIELDS_BY_TYPE[type] ? [...CONFIG_FIELDS_BY_TYPE[type]] : [];
}

// Given the type and method already chosen, and the config fields collected so far (an object
// keyed by field name), returns the next field still needed, or null once every required field
// for this type/method combination has been collected.
function nextConfigField(type, method, collected = {}) {
  const fields = configFieldsForType(type);
  if (method === 'scraper') fields.push('sourceUrl');
  return fields.find(field => collected[field] === undefined) ?? null;
}

module.exports = { CONFIG_FIELDS_BY_TYPE, CONFIG_FIELD_PROMPTS, configFieldsForType, nextConfigField };

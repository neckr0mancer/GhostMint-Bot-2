const assert = require('node:assert/strict');
const test = require('node:test');
const { CONFIG_FIELDS_BY_TYPE, CONFIG_FIELD_PROMPTS, configFieldsForType, nextConfigField } = require('../src/social/watchRuleFlowDecision');
const { WATCH_TYPE_PLATFORMS } = require('../src/validation/domain');

test('every watch-rule type known to validation has a defined config-field list here', () => {
  for (const type of Object.keys(WATCH_TYPE_PLATFORMS)) {
    assert.ok(Array.isArray(CONFIG_FIELDS_BY_TYPE[type]), `missing CONFIG_FIELDS_BY_TYPE entry for ${type}`);
  }
});

test('every config field referenced by a type has a prompt defined', () => {
  const referenced = new Set(Object.values(CONFIG_FIELDS_BY_TYPE).flat());
  referenced.add('sourceUrl');
  for (const field of referenced) assert.ok(CONFIG_FIELD_PROMPTS[field], `missing CONFIG_FIELD_PROMPTS entry for ${field}`);
});

test('account types need a handle; the channel type needs a channel ID; keyword types need keywords', () => {
  assert.deepEqual(configFieldsForType('twitter_account'), ['handle']);
  assert.deepEqual(configFieldsForType('farcaster_account'), ['handle']);
  assert.deepEqual(configFieldsForType('discord_channel'), ['channelId']);
  assert.deepEqual(configFieldsForType('twitter_keyword'), ['keywords']);
  assert.deepEqual(configFieldsForType('discord_keyword'), ['keywords']);
  assert.deepEqual(configFieldsForType('farcaster_keyword'), ['keywords']);
});

test('nextConfigField walks account/channel/keyword fields in order, then returns null once collected', () => {
  assert.equal(nextConfigField('twitter_account', 'official_api', {}), 'handle');
  assert.equal(nextConfigField('twitter_account', 'official_api', { handle: 'foo' }), null);
  assert.equal(nextConfigField('discord_channel', 'managed_service', {}), 'channelId');
  assert.equal(nextConfigField('twitter_keyword', 'official_api', {}), 'keywords');
});

test('nextConfigField appends sourceUrl only for the scraper method, after the type\'s own fields', () => {
  assert.equal(nextConfigField('twitter_account', 'scraper', {}), 'handle');
  assert.equal(nextConfigField('twitter_account', 'scraper', { handle: 'foo' }), 'sourceUrl');
  assert.equal(nextConfigField('twitter_account', 'scraper', { handle: 'foo', sourceUrl: 'https://example.com' }), null);
  assert.equal(nextConfigField('twitter_account', 'official_api', { handle: 'foo' }), null, 'non-scraper methods never need sourceUrl');
});

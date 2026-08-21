const assert = require('node:assert/strict');
const test = require('node:test');
const { telegramHtmlToDiscordMarkdown } = require('../src/notifications/discordMarkdown');

// Live-reported: a Discord DM read "❌ Scheduled mint <b>PUBLIC</b> failed." literally, tags and
// all -- notifyUser's messages are built once as Telegram HTML and fanned out unchanged to every
// linked platform. This is the exact message shape that broke.
test('converts every tag notifyUser messages actually use into Discord markdown', () => {
  assert.equal(telegramHtmlToDiscordMarkdown('❌ Scheduled mint <b>PUBLIC</b> failed.'), '❌ Scheduled mint **PUBLIC** failed.');
  assert.equal(telegramHtmlToDiscordMarkdown('<code>0xabc</code>'), '`0xabc`');
  assert.equal(telegramHtmlToDiscordMarkdown('<i>note</i>'), '*note*');
  assert.equal(telegramHtmlToDiscordMarkdown('<pre>block</pre>'), '```block```');
});

test('reverses escapeTelegramHtml\'s own entity-escaping, since Discord has no HTML entity decoder either', () => {
  assert.equal(telegramHtmlToDiscordMarkdown('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(telegramHtmlToDiscordMarkdown('a &lt; b &gt; c'), 'a < b > c');
});

test('tags convert before entities decode, so a task literally named "<b>" round-trips to literal text, not a stray delimiter', () => {
  // escapeTelegramHtml('<b>') produces '&lt;b&gt;' -- this is what a real caller would pass in.
  assert.equal(telegramHtmlToDiscordMarkdown('Name: &lt;b&gt;'), 'Name: <b>');
});

test('a plain message with no markup at all passes through unchanged', () => {
  assert.equal(telegramHtmlToDiscordMarkdown('Trigger requires confirmation.'), 'Trigger requires confirmation.');
});

test('handles null/undefined the same way String() would, never throwing', () => {
  assert.equal(telegramHtmlToDiscordMarkdown(null), '');
  assert.equal(telegramHtmlToDiscordMarkdown(undefined), '');
});

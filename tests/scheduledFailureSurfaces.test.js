const assert = require('node:assert/strict');
const test = require('node:test');
const telegramMenus = require('../src/telegram/menus');
const discordMenus = require('../src/discord/menus');

const failedTask = {
  id:'11111111-1111-4111-8111-111111111111',
  name:'Sold-out drop',
  status:'failed',
  contract:'0x0000000000000000000000000000000000000001',
  walletLabel:'primary',
  qty:1,
  price:0,
  mintTime:Date.UTC(2026, 7, 25),
  lastError:"This wallet has reached this mint's limit. Nothing was sent. Use another eligible wallet.",
};

test('Telegram task details retain the failure reason after the immediate alert is gone', () => {
  const rendered = telegramMenus.taskActions(failedTask);
  assert.match(rendered.text, /Reason:/);
  assert.match(rendered.text, /reached this mint's limit/i);
  assert.match(rendered.text, /Nothing was sent/i);
});

test('Discord task listings retain the failure reason after the immediate alert is gone', () => {
  const rendered = discordMenus.tasksMenu({ items:[failedTask], page:1, totalPages:1, total:1 });
  assert.match(rendered.content, /reason:/i);
  assert.match(rendered.content, /reached this mint/i);
  assert.match(rendered.content, /Nothing was sent/i);
});

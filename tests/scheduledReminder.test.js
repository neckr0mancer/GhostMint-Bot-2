const assert = require('node:assert/strict');
const test = require('node:test');
const { createScheduledReminder } = require('../src/scheduler/scheduledReminder');

const NOW = 1_000_000;

function task(overrides = {}) {
  return { id:'task-1', userId:'user-1', name:'Launch mint', walletLabel:'primary',
    status:'scheduled', mintTime:NOW + (5 * 60 * 1000), price:1, qty:1, ...overrides };
}

function fixture({ tasks = [task()], balances = [2n], needed = 1n } = {}) {
  const messages = [];
  const events = [];
  let balanceRead = 0;
  const reminder = createScheduledReminder({
    getTasks:() => tasks,
    findWallet:value => ({ userId:value.userId, label:value.walletLabel, address:'0x1', chain:'ethereum' }),
    detectSoldOut:async () => false,
    cancelTask:async () => {},
    calculateNeededWei:() => needed,
    getBalance:async () => balances[Math.min(balanceRead++, balances.length - 1)],
    formatWei:value => String(value),
    escape:value => String(value),
    notify:async (userId, message) => messages.push({ userId, message }),
    broadcast:(userId, event) => events.push({ userId, ...event }),
  });
  return { reminder, messages, events };
}

test('every scheduled mint gets one five-minute automatic-execution reminder', async () => {
  const value = fixture();
  await value.reminder.sweep(NOW);
  await value.reminder.sweep(NOW + 60_000);

  assert.equal(value.messages.length, 1);
  assert.match(value.messages[0].message, /execute automatically; no approval is required/i);
  assert.equal(value.events[0].type, 'task.reminder');
});

test('a balance that drops after the general reminder produces a later low-balance warning', async () => {
  const value = fixture({ balances:[2n, 0n] });
  await value.reminder.sweep(NOW);
  await value.reminder.sweep(NOW + 60_000);

  assert.equal(value.messages.length, 2);
  assert.match(value.messages[1].message, /is now short by 1 ETH/i);
  assert.deepEqual(value.events.map(event => event.type), ['task.reminder', 'task.lowBalance']);
});

test('an already-low wallet receives a combined reminder and low-balance warning once', async () => {
  const value = fixture({ balances:[0n] });
  await value.reminder.sweep(NOW);
  await value.reminder.sweep(NOW + 60_000);

  assert.equal(value.messages.length, 1);
  assert.match(value.messages[0].message, /short by 1 ETH/i);
  assert.match(value.messages[0].message, /execute automatically/i);
  assert.equal(value.events[0].type, 'task.lowBalance');
});

test('a zero-value mint still receives the five-minute reminder without a balance lookup', async () => {
  const value = fixture({ needed:0n, balances:[] });
  await value.reminder.sweep(NOW);
  assert.equal(value.messages.length, 1);
  assert.equal(value.events[0].type, 'task.reminder');
});

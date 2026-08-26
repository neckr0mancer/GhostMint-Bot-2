const assert = require('node:assert/strict');
const test = require('node:test');
const { deliverFailureSideEffects, scheduledFailureFeedback } = require('../src/scheduler/scheduledFailureFeedback');

test('a wallet mint cap becomes a concise, non-retryable explanation', () => {
  const feedback = scheduledFailureFeedback(
    'Request validation failed: contractAddress This wallet would hold 2, exceeding the 1 allowed per wallet.',
    { chainState:'not_sent' },
  );
  assert.equal(feedback.code, 'WALLET_MINT_LIMIT_REACHED');
  assert.equal(feedback.terminal, true);
  assert.equal(feedback.severity, 'warning');
  assert.equal(feedback.message,
    "This wallet has reached this mint's limit. Nothing was sent. Use another eligible wallet.");
});

test('collection and stage exhaustion stay distinct and state whether the transaction reached chain', () => {
  const collection = scheduledFailureFeedback('MintQuantityExceedsMaxSupply', { chainState:'not_sent' });
  assert.equal(collection.code, 'MINT_SOLD_OUT');
  assert.match(collection.message, /sold out before the scheduled mint could run/i);
  assert.match(collection.message, /Nothing was sent/i);

  const stage = scheduledFailureFeedback('This mint stage is sold out', { chainState:'mined' });
  assert.equal(stage.code, 'STAGE_SUPPLY_EXHAUSTED');
  assert.match(stage.message, /transaction reached the chain/i);
  assert.doesNotMatch(stage.message, /Nothing was sent/i);
});

test('unknown pre-broadcast failures remain specific and still say that nothing was sent', () => {
  const feedback = scheduledFailureFeedback(
    'Request validation failed: calldata does not match the selected function',
    { chainState:'not_sent' },
  );
  assert.equal(feedback.code, 'SCHEDULED_MINT_FAILED');
  assert.match(feedback.message, /does not match the selected function/i);
  assert.doesNotMatch(feedback.message, /^calldata/i, 'internal validation field names stay out of user copy');
  assert.match(feedback.message, /Nothing was sent/i);
});

test('an ambiguous OpenSea rejection is not guessed to be sold out', () => {
  const feedback = scheduledFailureFeedback(
    "OpenSea could not confirm why this wallet can't mint right now",
    { chainState:'not_sent' },
  );
  assert.equal(feedback.code, 'SCHEDULED_MINT_FAILED');
  assert.doesNotMatch(feedback.message, /sold out/i);
  assert.match(feedback.message, /Nothing was sent/i);
});

test('a failed activity write cannot suppress dashboard or linked-platform notification', async () => {
  const delivered = [];
  const logs = [];
  await deliverFailureSideEffects({
    broadcast:() => delivered.push('dashboard'),
    recordActivity:async () => { throw new Error('database unavailable'); },
    notify:async () => delivered.push('telegram-and-discord'),
    log:message => logs.push(message),
  });

  assert.deepEqual(delivered, ['dashboard', 'telegram-and-discord']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /activity delivery failed: database unavailable/i);
});

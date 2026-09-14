const assert = require('node:assert/strict');
const test = require('node:test');
const { createNotificationService } = require('../src/notifications/notificationService');

test('notifications reach every linked platform independently of last-used platform', async () => {
  const sent = [];
  const service = createNotificationService({
    identityRepository: { listLinkedAccounts: async () => [
      { platform: 'telegram', platformUserId: 'tg-1' },
      { platform: 'discord', platformUserId: 'dc-1' },
    ] },
    transports: {
      telegram: async (id, message) => sent.push(['telegram', id, message]),
      discord: async (id, message) => sent.push(['discord', id, message]),
    },
  });
  const results = await service.sendToUser('user-1', 'transaction confirmed');
  assert.deepEqual(sent, [
    ['telegram', 'tg-1', 'transaction confirmed'],
    ['discord', 'dc-1', 'transaction confirmed'],
  ]);
  assert.ok(results.every(result => result.status === 'fulfilled'));
});

test('one failed platform delivery does not prevent delivery to another linked platform', async () => {
  const sent = [];
  const service = createNotificationService({
    identityRepository: { listLinkedAccounts: async () => [
      { platform: 'telegram', platformUserId: 'tg-1' }, { platform: 'discord', platformUserId: 'dc-1' },
    ] },
    transports: { telegram: async () => { throw new Error('telegram unavailable'); },
      discord: async id => sent.push(id) },
  });
  const results = await service.sendToUser('user-1', 'confirmed');
  assert.deepEqual(sent, ['dc-1']);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled']);
});

test('a linked platform with no active transport is reported as failed, not silently successful',async()=>{
  const logs=[];
  const service=createNotificationService({identityRepository:{listLinkedAccounts:async()=>[
    {platform:'discord',platformUserId:'dc-1'},
  ]},transports:{},log:value=>logs.push(value)});
  const results=await service.sendToUser('user-1','scheduled mint check');
  assert.equal(results[0].status,'rejected');
  assert.match(results[0].reason.message,/transport is unavailable/);
  assert.match(logs[0],/Notification to discord failed/);
});

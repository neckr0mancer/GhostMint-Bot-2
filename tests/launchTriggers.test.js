const assert = require('node:assert/strict');
const test = require('node:test');
const { createLaunchTriggers } = require('../src/launch/triggers');

// Minimal scripted WebSocket: records the subscription request, lets tests push frames.
class FakeSocket {
  constructor() {
    FakeSocket.instances.push(this);
    this.sent = [];
    this.closed = false;
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  fail() { this.onerror?.(); }
}

function fixture() {
  FakeSocket.instances = [];
  const urls = [];
  const fired = [];
  const triggers = createLaunchTriggers({
    wsUrlFor: chain => `wss://${chain}.example`,
    makeSocket: url => { urls.push(url); return new FakeSocket(); },
    log: () => {},
  });
  const lastSocket = () => FakeSocket.instances[FakeSocket.instances.length - 1];
  return { triggers, urls, fired, lastSocket };
}

test('block trigger subscribes to newHeads and fires exactly once at the target height', async () => {
  const { triggers, urls, fired, lastSocket } = fixture();
  let resolved = false;
  const arming = triggers.arm({ squadId: 's1', kind: 'block', chain: 'base', contractAddress: '0xnft', targetBlock: 100 },
    () => fired.push('fire'));
  const socket = lastSocket();
  socket.open();
  socket.message({ id: 1, result: 'sub-1' });
  await arming;
  resolved = true;
  assert.equal(urls[0], 'wss://base.example');
  assert.deepEqual(socket.sent[0].params, ['newHeads']);
  socket.message({ params: { result: { number: '0x62' } } }); // 98 -- below
  socket.message({ params: { result: { number: '0x63' } } }); // 99 -- below
  assert.equal(fired.length, 0);
  socket.message({ params: { result: { number: '0x64' } } }); // 100 -- fire
  socket.message({ params: { result: { number: '0x65' } } }); // late frame ignored
  assert.deepEqual(fired, ['fire'], 'must fire exactly once, at the target');
  assert.ok(socket.closed, 'the subscription closes itself after firing');
  assert.equal(triggers.has('s1'), false);
});

test('pending trigger filters by contract address and fires on the first pending tx', async () => {
  const { triggers, fired, lastSocket } = fixture();
  const arming = triggers.arm({ squadId: 's2', kind: 'pending', chain: 'ethereum', contractAddress: '0xmint' },
    () => fired.push('fire'));
  const socket = lastSocket();
  socket.open();
  socket.message({ id: 1, result: 'sub-2' });
  await arming;
  assert.deepEqual(socket.sent[0].method, 'eth_subscribe');
  assert.deepEqual(socket.sent[0].params, ['alchemy_pendingTransactions', { toAddress: '0xmint' }]);
  socket.message({ params: { result: '0xtxhash' } });
  socket.message({ params: { result: '0xanother' } });
  assert.deepEqual(fired, ['fire']);
  assert.ok(socket.closed);
});

test('a provider that refuses the subscription fails the arm loudly instead of silently never firing', async () => {
  const { triggers, lastSocket } = fixture();
  const arming = triggers.arm({ squadId: 's3', kind: 'pending', chain: 'arbitrum', contractAddress: '0xmint' },
    () => {});
  const socket = lastSocket();
  socket.open();
  socket.message({ id: 1, error: { message: 'unsupported subscription type' } });
  await assert.rejects(arming, /rejected/);
});

test('dispose before the event means no fire', async () => {
  const { triggers, fired, lastSocket } = fixture();
  const arming = triggers.arm({ squadId: 's4', kind: 'block', chain: 'base', contractAddress: '0xnft', targetBlock: 5 },
    () => fired.push('fire'));
  const socket = lastSocket();
  socket.open();
  socket.message({ id: 1, result: 'sub-4' });
  await arming;
  assert.equal(triggers.dispose('s4'), true, 'an armed trigger is disposable');
  socket.message({ params: { result: { number: '0x5' } } });
  assert.equal(fired.length, 0, 'a disposed trigger must never call back');
});


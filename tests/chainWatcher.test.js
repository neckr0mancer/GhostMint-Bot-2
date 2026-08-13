const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createChainWatcher } = require('../src/sniper/chainWatcher');

function fakeProvider() {
  const emitter = new EventEmitter();
  emitter.destroyed = false;
  emitter.destroy = () => { emitter.destroyed = true; };
  return emitter;
}

test('falls back to HTTP polling when no WS url is configured', () => {
  const httpProvider = fakeProvider();
  const watcher = createChainWatcher({ chain:'ethereum', rpcUrl:'https://rpc', wsUrl:null,
    providerFactory: () => httpProvider, wsProviderFactory: () => { throw new Error('should not be called'); },
    onBlock: () => {} });
  watcher.start();
  assert.equal(watcher.mode(), 'http');
  assert.equal(watcher.getProvider(), httpProvider);
  watcher.stop();
});

test('uses WebSocket push when a WS url is configured', () => {
  const wsProvider = fakeProvider();
  const watcher = createChainWatcher({ chain:'ethereum', rpcUrl:'https://rpc', wsUrl:'wss://rpc',
    providerFactory: () => { throw new Error('should not be called'); }, wsProviderFactory: () => wsProvider,
    onBlock: () => {} });
  watcher.start();
  assert.equal(watcher.mode(), 'ws');
  assert.equal(watcher.getProvider(), wsProvider);
  watcher.stop();
});

test('delivers block events from the active provider to onBlock', async () => {
  const seen = [];
  const wsProvider = fakeProvider();
  const watcher = createChainWatcher({ chain:'ethereum', rpcUrl:'https://rpc', wsUrl:'wss://rpc',
    providerFactory: () => { throw new Error('unused'); }, wsProviderFactory: () => wsProvider,
    onBlock: (bn, provider) => { seen.push([bn, provider]); } });
  watcher.start();
  wsProvider.emit('block', 42);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(seen, [[42, wsProvider]]);
  watcher.stop();
});

test('a dropped WebSocket falls back to HTTP polling immediately and reconnects to WS in the background', async () => {
  const httpProvider = fakeProvider();
  const wsProviders = [fakeProvider(), fakeProvider()];
  let wsCalls = 0;
  const watcher = createChainWatcher({ chain:'ethereum', rpcUrl:'https://rpc', wsUrl:'wss://rpc',
    providerFactory: () => httpProvider, wsProviderFactory: () => wsProviders[wsCalls++],
    onBlock: () => {}, reconnectDelayMs: 10 });
  watcher.start();
  assert.equal(watcher.mode(), 'ws');
  wsProviders[0].emit('error', new Error('closed'));
  assert.equal(watcher.mode(), 'http');
  assert.equal(watcher.getProvider(), httpProvider);
  assert.equal(wsProviders[0].destroyed, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(watcher.mode(), 'ws');
  assert.equal(watcher.getProvider(), wsProviders[1]);
  assert.equal(wsCalls, 2);
  watcher.stop();
});

test('a synchronous WebSocket connect failure falls back to HTTP and still retries', async () => {
  const httpProvider = fakeProvider();
  const wsProvider = fakeProvider();
  let attempts = 0;
  const watcher = createChainWatcher({ chain:'ethereum', rpcUrl:'https://rpc', wsUrl:'wss://rpc',
    providerFactory: () => httpProvider,
    wsProviderFactory: () => { attempts++; if (attempts === 1) throw new Error('connect refused'); return wsProvider; },
    onBlock: () => {}, reconnectDelayMs: 10 });
  watcher.start();
  assert.equal(watcher.mode(), 'http');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(watcher.mode(), 'ws');
  assert.equal(attempts, 2);
  watcher.stop();
});

test('onBlock errors are caught and logged, never thrown out of the watcher', async () => {
  const wsProvider = fakeProvider();
  const logs = [];
  const watcher = createChainWatcher({ chain:'ethereum', rpcUrl:'https://rpc', wsUrl:'wss://rpc',
    providerFactory: () => { throw new Error('unused'); }, wsProviderFactory: () => wsProvider,
    onBlock: async () => { throw new Error('boom'); }, log: message => logs.push(message) });
  watcher.start();
  wsProvider.emit('block', 1);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(logs.some(message => message.includes('boom')));
  watcher.stop();
});

test('stop tears down the provider and cancels any pending reconnect', async () => {
  const httpProvider = fakeProvider();
  const wsProviders = [fakeProvider(), fakeProvider()];
  let wsCalls = 0;
  const watcher = createChainWatcher({ chain:'ethereum', rpcUrl:'https://rpc', wsUrl:'wss://rpc',
    providerFactory: () => httpProvider, wsProviderFactory: () => wsProviders[wsCalls++],
    onBlock: () => {}, reconnectDelayMs: 10 });
  watcher.start();
  wsProviders[0].emit('error', new Error('closed'));
  watcher.stop();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(wsCalls, 1);
  assert.equal(watcher.mode(), null);
  assert.equal(watcher.getProvider(), null);
});

test('a chain whose provider construction fails never throws out of start(), so other chains keep working', () => {
  const good = fakeProvider();
  const logs = [];
  const watcherA = createChainWatcher({ chain:'ethereum', rpcUrl:'https://rpc-a', wsUrl:null,
    providerFactory: () => { throw new Error('chain A RPC unreachable'); }, wsProviderFactory: () => {},
    onBlock: () => {}, log: message => logs.push(message) });
  const watcherB = createChainWatcher({ chain:'base', rpcUrl:'https://rpc-b', wsUrl:null,
    providerFactory: () => good, wsProviderFactory: () => {}, onBlock: () => {} });
  assert.doesNotThrow(() => watcherA.start());
  assert.equal(watcherA.mode(), null);
  assert.ok(logs.some(message => message.includes('chain A RPC unreachable')));
  watcherB.start();
  assert.equal(watcherB.mode(), 'http');
  assert.equal(watcherB.getProvider(), good);
  watcherB.stop();
});

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { createDashboardApi, mountDashboardRoutes } = require('../src/dashboard/api');
const { ValidationError } = require('../src/validation/domain');

async function listenForFetch(server) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve, reject) => {
      const fail = error => {
        server.off('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.off('error', fail);
        resolve();
      };
      server.once('error', fail);
      server.once('listening', ready);
      server.listen(0, '127.0.0.1');
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fetch(base, { method: 'HEAD' });
      return base;
    } catch (error) {
      if (error?.cause?.message !== 'bad port') throw error;
      await new Promise(resolve => server.close(resolve));
    }
  }
  throw new Error('Could not allocate a Fetch-safe local test port');
}

function authHeaders(user = 'a', write = false) {
  return {
    cookie: `ghostmint_session=token-${user}`,
    ...(write ? { 'content-type': 'application/json', 'x-csrf-token': 'csrf' } : {}),
  };
}

async function walletHistoryServer(t,{syncResult={accepted:true,supported:false,state:'unsupported'}}={}) {
  const sessions = new Map([
    ['token-a', { userId: 'user-a', csrfTokenHash: 'csrf' }],
    ['token-b', { userId: 'user-b', csrfTokenHash: 'csrf' }],
  ]);
  const calls = [];
  const broadcasts = [];
  const ownedWallet = {
    id: 41,
    label: 'Trading',
    address: '0x0000000000000000000000000000000000000041',
    chain: 'ethereum',
    keyEnvelope: { ciphertext: 'must-not-leave-the-server' },
  };
  const requireOwnedWallet = (userId, walletId) => {
    if (userId !== 'user-a' || String(walletId) !== String(ownedWallet.id)) {
      throw new ValidationError({ field: 'walletId', message: 'was not found' });
    }
  };
  const commands = {
    wallets: userId => (userId === 'user-a' ? [ownedWallet] : []),
    walletBalance: async (userId, label) => ({
      ...ownedWallet,
      label,
      balances: [{ chain: 'ethereum', balance: '0.25', symbol: 'ETH' }],
    }),
    walletHistoryPage: async (userId, walletId, input) => {
      requireOwnedWallet(userId, walletId);
      calls.push(['list', userId, walletId, input]);
      return {
        page: Number(input.page) || 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
        snapshotAt: '2026-01-01T00:00:00.000Z',
        coverage: { state: 'partial' },
        items: [{ txHash: `0x${'ab'.repeat(32)}`, valueWei: 1n }],
      };
    },
    requestWalletHistorySync: async (userId, walletId, input) => {
      requireOwnedWallet(userId, walletId);
      calls.push(['sync', userId, walletId, input]);
      return syncResult;
    },
  };
  const auth = {
    authenticate: async cookieHeader => {
      const match = /(?:^|;\s*)ghostmint_session=([^;]+)/.exec(String(cookieHeader || ''));
      return match ? sessions.get(match[1]) || null : null;
    },
    verifyCsrf: ({ headerToken }) => headerToken === 'csrf',
  };
  const api = createDashboardApi({
    auth,
    commands,
    identityRepository: {},
    broadcast: (userId, message) => broadcasts.push({ userId, message }),
  });
  const app = express();
  app.use(express.json());
  app.use(api.securityHeaders);
  mountDashboardRoutes(app, api);
  app.use(api.error);
  const server = http.createServer(app);
  const base = await listenForFetch(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base, calls, broadcasts };
}

test('wallet list exposes the tenant-scoped history ID without leaking key material', async t => {
  const { base } = await walletHistoryServer(t);
  const response = await fetch(`${base}/api/wallets`, { headers: authHeaders('a') });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes('must-not-leave-the-server'), false);
  const [wallet] = JSON.parse(text);
  assert.deepEqual(Object.keys(wallet).sort(), [
    'addedAt', 'address', 'balances', 'chain', 'id', 'label', 'minted',
  ]);
  assert.equal(wallet.id, 41);
  assert.deepEqual(await (await fetch(`${base}/api/wallets`, { headers: authHeaders('b') })).json(), []);
});

test('wallet history GET is authenticated, tenant scoped, no-store, and JSON safe', async t => {
  const { base, calls } = await walletHistoryServer(t);
  assert.equal((await fetch(`${base}/api/wallets/41/history`)).status, 401);

  const response = await fetch(`${base}/api/wallets/41/history?page=2`, { headers: authHeaders('a') });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const body = await response.json();
  assert.equal(body.page, 2);
  assert.equal(body.items[0].valueWei, '1');

  const crossTenant = await fetch(`${base}/api/wallets/41/history`, { headers: authHeaders('b') });
  assert.equal(crossTenant.status, 400);
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [['list', 'user-a', '41']]);
});

test('wallet history sync checks CSRF and tenancy before broadcasting a refresh', async t => {
  const { base, calls, broadcasts } = await walletHistoryServer(t);
  const route = `${base}/api/wallets/41/history/sync`;

  assert.equal((await fetch(route, {
    method: 'POST', headers: authHeaders('a'), body: '{}',
  })).status, 403);
  assert.equal((await fetch(route, {
    method: 'POST', headers: authHeaders('b', true), body: '{}',
  })).status, 400);
  assert.deepEqual(calls, []);
  assert.deepEqual(broadcasts, []);

  const response = await fetch(route, {
    method: 'POST', headers: authHeaders('a', true), body: '{}',
  });
  assert.equal(response.status, 202);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { accepted: true, supported: false, state: 'unsupported' });
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [['sync', 'user-a', '41']]);
  assert.deepEqual(broadcasts, [{ userId: 'user-a', message: { type: 'wallet-history.changed' } }]);
});

test('wallet history sync reports an unavailable worker without claiming or broadcasting a queue', async t => {
  const syncResult={accepted:false,supported:false,state:'disabled',
    message:'Wallet history sync is not enabled on this server.'};
  const {base,calls,broadcasts}=await walletHistoryServer(t,{syncResult});
  const response=await fetch(`${base}/api/wallets/41/history/sync`,{
    method:'POST',headers:authHeaders('a',true),body:'{}',
  });
  assert.equal(response.status,503);
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.deepEqual(await response.json(),syncResult);
  assert.deepEqual(calls.map(call=>call.slice(0,3)),[['sync','user-a','41']]);
  assert.deepEqual(broadcasts,[]);
});

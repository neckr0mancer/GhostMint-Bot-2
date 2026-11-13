const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { WebSocket } = require('ws');
const { createBotCommandService } = require('../src/commands/botCommandService');
const { createDashboardApi, mountDashboardRoutes } = require('../src/dashboard/api');
const { createDashboardWebSocketHub } = require('../src/dashboard/webSocketHub');
const { createIdentityService } = require('../src/identity/identityService');

const CANONICAL_USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const TELEGRAM_PLATFORM_ID = '7000000001';
const DISCORD_PLATFORM_ID = '1000000000000000001';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function nextSocketMessage(socket, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for the dashboard WebSocket event'));
    }, timeoutMs);
    const onMessage = raw => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    };
    socket.once('message', onMessage);
  });
}

async function openSocket(url, cookie) {
  const socket = new WebSocket(url, { headers: { cookie } });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  assert.deepEqual(await nextSocketMessage(socket), { type: 'connected' });
  return socket;
}

function parityFixture() {
  const mappings = new Map([
    [`telegram:${TELEGRAM_PLATFORM_ID}`, CANONICAL_USER_ID],
    [`discord:${DISCORD_PLATFORM_ID}`, CANONICAL_USER_ID],
  ]);
  const identityRepository = {
    async resolveOrCreateIdentity({ platform, platformUserId }) {
      return mappings.get(`${platform}:${platformUserId}`) || OTHER_USER_ID;
    },
  };
  const identity = createIdentityService(identityRepository);
  const rows = [];
  const state = {
    wallets: [{
      id: 'wallet-a', userId: CANONICAL_USER_ID, label: 'Trading',
      address: '0x0000000000000000000000000000000000000001', chain: 'ethereum',
    }],
    tasks: [], activity: [], pnl: [], snipers: [],
  };
  const counts = tasks => ({
    pending: tasks.filter(task => ['scheduled', 'claimed', 'retry'].includes(task.status)).length,
    paused: tasks.filter(task => task.status === 'paused').length,
    failed: tasks.filter(task => task.status === 'failed').length,
    expired: 0,
    cancelled: tasks.filter(task => task.status === 'cancelled').length,
    succeeded: tasks.filter(task => task.status === 'succeeded').length,
  });
  const schedulerRepository = {
    async listForUser(userId) {
      return rows.filter(task => task.userId === userId);
    },
    async listPageForUser(userId, { limit = 10, offset = 0, status } = {}) {
      const owned = rows.filter(task => task.userId === userId);
      const filtered = status === 'pending'
        ? owned.filter(task => ['scheduled', 'claimed', 'retry'].includes(task.status))
        : owned;
      return { items: filtered.slice(offset, offset + limit), total: filtered.length, counts: counts(owned) };
    },
    async detailsForUser(userId, id) {
      return rows.find(task => task.userId === userId && task.id === id) || null;
    },
    async pause(userId, id) {
      const task = rows.find(item => item.userId === userId && item.id === id
        && ['scheduled', 'retry'].includes(item.status));
      if (!task) return null;
      task.status = 'paused';
      return { ...task };
    },
    async resume(userId, id, now) {
      const task = rows.find(item => item.userId === userId && item.id === id
        && item.status === 'paused');
      if (!task) return null;
      task.status = 'scheduled';
      task.nextAttemptAt = Math.max(Number(task.mintTime), now);
      return { ...task };
    },
  };
  const storage = {
    async saveTask(task) {
      rows.push({ ...task });
      return true;
    },
  };
  const providerService = {
    perform: async (_chain, _operation, callback) => callback({
      getCode: async () => '0x60806040',
      call: async () => '0x',
    }),
  };
  return { identity, rows, state, schedulerRepository, storage, providerService };
}

test('linked bot schedules share the dashboard row, live event, tenant scope, and restart view', async t => {
  const fixture = parityFixture();
  const auth = {
    authenticate: async cookie => String(cookie || '').includes('session=canonical')
      ? { userId: CANONICAL_USER_ID, sessionId: 'session-a' }
      : String(cookie || '').includes('session=other')
        ? { userId: OTHER_USER_ID, sessionId: 'session-b' }
        : null,
    verifyCsrf: () => true,
  };
  const hub = createDashboardWebSocketHub({ auth });
  const commandDependencies = {
    storage: fixture.storage,
    schedulerRepository: fixture.schedulerRepository,
    providerService: fixture.providerService,
    governance: {}, adminCommands: {}, sniperService: {},
    supportedChains: ['ethereum'], chains: { ethereum: { sym: 'ETH' } },
    encryptPrivateKey: () => ({}), getState: () => fixture.state,
    broadcast: (userId, resource) => hub.broadcastToUser(userId, { type: `${resource}.changed` }),
  };
  const commands = createBotCommandService(commandDependencies);
  const api = createDashboardApi({
    auth, commands, identityRepository: {}, supportedChains: ['ethereum'],
  });
  const app = express();
  app.use(express.json());
  app.use(api.securityHeaders);
  mountDashboardRoutes(app, api);
  app.use(api.error);
  const server = http.createServer(app);
  hub.attach(server);
  const base = await listen(server);
  const socket = await openSocket(base.replace('http:', 'ws:') + '/ws', 'session=canonical');
  t.after(async () => {
    socket.close();
    await hub.close();
    await new Promise(resolve => server.close(resolve));
  });

  const discordUserId = await fixture.identity.resolveOrCreate('discord', DISCORD_PLATFORM_ID);
  const telegramUserId = await fixture.identity.resolveOrCreate('telegram', TELEGRAM_PLATFORM_ID);
  assert.equal(discordUserId, CANONICAL_USER_ID);
  assert.equal(telegramUserId, CANONICAL_USER_ID);

  const future = new Date(Date.now() + 86_400_000).toISOString();
  const discordEvent = nextSocketMessage(socket);
  const discordTask = await commands.createTask(discordUserId, {
    name: 'Discord schedule', walletLabel: 'Trading',
    contractAddress: '0x0000000000000000000000000000000000000011',
    quantity: 1, priceETH: 0, chain: 'ethereum', mintTime: future,
  });
  assert.deepEqual(await discordEvent, { type: 'tasks.changed' });

  const telegramEvent = nextSocketMessage(socket);
  const telegramTask = await commands.createTask(telegramUserId, {
    name: 'Telegram schedule', walletLabel: 'Trading',
    contractAddress: '0x0000000000000000000000000000000000000022',
    quantity: 1, priceETH: 0, chain: 'ethereum', mintTime: future,
  });
  assert.deepEqual(await telegramEvent, { type: 'tasks.changed' });

  const dashboard = await fetch(`${base}/api/tasks?page=1&pageSize=10&status=pending`, {
    headers: { cookie: 'session=canonical' },
  });
  assert.equal(dashboard.status, 200);
  const dashboardPage = await dashboard.json();
  assert.deepEqual(dashboardPage.items.map(task => task.id), [discordTask.id, telegramTask.id]);
  assert.equal(dashboardPage.counts.pending, 2);

  const unrelated = await fetch(`${base}/api/tasks?page=1&pageSize=10&status=pending`, {
    headers: { cookie: 'session=other' },
  });
  assert.equal(unrelated.status, 200);
  assert.deepEqual((await unrelated.json()).items, []);

  const restartedCommands = createBotCommandService({
    ...commandDependencies,
    getState: () => ({ ...fixture.state, tasks: [] }),
    broadcast: () => {},
  });
  const afterRestart = await restartedCommands.tasksPage(CANONICAL_USER_ID, {
    page: 1, pageSize: 10, status: 'pending',
  });
  assert.deepEqual(afterRestart.items.map(task => task.id), [discordTask.id, telegramTask.id]);

  const dashboardCreateEvent = nextSocketMessage(socket);
  const dashboardCreate = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { cookie: 'session=canonical', 'content-type': 'application/json', 'x-csrf-token': 'test' },
    body: JSON.stringify({
      name: 'Dashboard schedule', walletLabel: 'Trading',
      contractAddress: '0x0000000000000000000000000000000000000033',
      quantity: 1, priceETH: 0, chain: 'ethereum', mintTime: future,
    }),
  });
  assert.equal(dashboardCreate.status, 201);
  const dashboardTask = await dashboardCreate.json();
  assert.deepEqual(await dashboardCreateEvent, { type: 'tasks.changed' });

  const telegramPauseEvent = nextSocketMessage(socket);
  const paused = await commands.controlTask(telegramUserId, 'pause', dashboardTask.id);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(await telegramPauseEvent, { type: 'tasks.changed' });

  const discordResumeEvent = nextSocketMessage(socket);
  const resumed = await commands.controlTask(discordUserId, 'resume', dashboardTask.id);
  assert.equal(resumed.status, 'scheduled');
  assert.deepEqual(await discordResumeEvent, { type: 'tasks.changed' });

  const details = await fetch(`${base}/api/tasks/${dashboardTask.id}`, {
    headers: { cookie: 'session=canonical' },
  });
  assert.equal(details.status, 200);
  assert.equal((await details.json()).status, 'scheduled');
});

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { WebSocket } = require('ws');
const { createBotCommandService } = require('../src/commands/botCommandService');
const { createDashboardApi, mountDashboardRoutes } = require('../src/dashboard/api');
const { createDashboardAuthService } = require('../src/dashboard/authService');
const { createDashboardSessionRepository } = require('../src/dashboard/sessionRepository');
const { createDashboardWebSocketHub } = require('../src/dashboard/webSocketHub');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createSchedulerRepository } = require('../src/scheduler/schedulerRepository');
const { createKeyEncryption } = require('../src/security/keyEncryption');
const { createPostgresStorage } = require('../src/storage/postgresStorage');
const { createDiscordInteractionHandler } = require('../src/discord/discordBot');
const { createFlowStateStore } = require('../src/telegram/flowState');
const { finishTelegramTaskSchedule } = require('../src/telegram/taskScheduleConfirmation');
const {
  createTestDatabasePool,
  integrationTest,
  runTestMigrations,
} = require('./helpers/disposableDatabase');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function nextSocketMessage(socket, timeoutMs = 10_000) {
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

function cookieHeader(auth, session) {
  return auth.sessionCookies(session).map(value => value.split(';')[0]).join('; ');
}

function providerService() {
  return {
    perform: async (_chain, _operation, callback) => callback({
      getCode: async () => '0x60806040',
      call: async () => '0x',
    }),
  };
}

function discordScheduleTap(platformUserId) {
  return {
    customId: 'flow:taskconfirm', user: { id: platformUserId }, guildId: 'guild', channelId: 'channel',
    deferred: false, replied: false, replies: [],
    isChatInputCommand: () => false, isButton: () => true,
    isStringSelectMenu: () => false, isModalSubmit: () => false,
    async deferUpdate() { this.deferred = true; },
    async editReply(value) { this.replies.push(value); },
    async reply(value) { this.replied = true; this.replies.push(value); },
  };
}

integrationTest('linked bot schedules persist in Postgres, reach the Dashboard API, and share user-scoped controls',
  { timeout: 180_000 }, async () => {
    await runTestMigrations({ migrationsDirectory: path.join(__dirname, '..', 'migrations') });
    const pool = await createTestDatabasePool({ max: 4 });
    const identityRepository = createPostgresIdentityRepository(pool);
    const identity = createIdentityService(identityRepository);
    const storage = createPostgresStorage(pool);
    const schedulerRepository = createSchedulerRepository(pool);
    const suffix = `${process.pid}-${Date.now()}`;
    const telegramPlatformId = `schedule-telegram-${suffix}`;
    const discordPlatformId = `schedule-discord-${suffix}`;
    const userIds = [];
    let server;
    let hub;
    let socket;
    let otherSocket;

    try {
      const telegramUserId = await identity.resolveOrCreate('telegram', telegramPlatformId);
      userIds.push(telegramUserId);
      const discordLink = await identity.createLinkCode(telegramUserId);
      const discordUserId = await identity.consumeLinkCode({
        code: discordLink.code,
        platform: 'discord',
        platformUserId: discordPlatformId,
      });
      assert.equal(discordUserId, telegramUserId);
      assert.equal(await identity.resolveOrCreate('discord', discordPlatformId), telegramUserId);

      const otherUserId = await identity.resolveOrCreate('telegram', `schedule-other-${suffix}`);
      userIds.push(otherUserId);
      const crypto = createKeyEncryption({ activeVersion: 1, keys: { 1: 'schedule-parity-test-key' } });
      await storage.addWallet({
        userId: telegramUserId,
        label: 'Trading',
        address: '0x00000000000000000000000000000000000000a1',
        chain: 'ethereum',
        keyEnvelope: crypto.encrypt(`0x${'11'.repeat(32)}`),
        minted: 0,
        addedAt: Date.now(),
      });
      const state = await storage.loadSystemState();

      const auth = createDashboardAuthService({
        identity,
        repository: createDashboardSessionRepository(pool),
        secureCookies: false,
      });
      const dashboardLink = await identity.createLinkCode(telegramUserId);
      const dashboardSession = await auth.login(dashboardLink.code, 'schedule parity test');
      const dashboardCookie = cookieHeader(auth, dashboardSession);
      const otherSession = await auth.loginWithUserId(otherUserId, 'schedule parity tenant check');
      const otherCookie = cookieHeader(auth, otherSession);

      hub = createDashboardWebSocketHub({ auth });
      const commandDependencies = {
        storage,
        schedulerRepository,
        providerService: providerService(),
        governance: {},
        adminCommands: {},
        sniperService: {},
        supportedChains: ['ethereum'],
        chains: { ethereum: { sym: 'ETH' } },
        encryptPrivateKey: value => crypto.encrypt(value),
        getState: () => state,
        broadcast: (userId, resource) => hub.broadcastToUser(userId, { type: `${resource}.changed` }),
      };
      const commands = createBotCommandService(commandDependencies);
      const api = createDashboardApi({
        auth,
        commands,
        identityRepository,
        supportedChains: ['ethereum'],
      });
      const app = express();
      app.use(express.json());
      app.use(api.securityHeaders);
      mountDashboardRoutes(app, api);
      app.use(api.error);
      server = http.createServer(app);
      hub.attach(server);
      const base = await listen(server);
      socket = await openSocket(base.replace('http:', 'ws:') + '/ws', dashboardCookie);
      otherSocket = await openSocket(base.replace('http:', 'ws:') + '/ws', otherCookie);
      const unrelatedSocketMessages = [];
      otherSocket.on('message', raw => unrelatedSocketMessages.push(JSON.parse(String(raw))));

      // Seven days in the future and no worker is started: these fixtures cannot execute or spend.
      const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const telegramFlowData = {
        name: 'Telegram disposable schedule',
        walletLabel: 'Trading',
        contractAddress: '0x0000000000000000000000000000000000000011',
        quantity: 1,
        priceETH: 0,
        chain: 'ethereum',
        mintTime: future,
      };
      const telegramFlowState = createFlowStateStore();
      telegramFlowState.start('telegram', telegramPlatformId, 'task_guided', 'awaiting_confirm',
        telegramFlowData);
      const telegramUpdates = [];
      const telegramEvent = nextSocketMessage(socket);
      const telegramTask = await finishTelegramTaskSchedule({
        chatId: telegramPlatformId,
        messageId: 1,
        userId: telegramUserId,
        flowData: telegramFlowData,
        commands,
        rateLimiter: { check() {} },
        flowState: telegramFlowState,
        update: async (chatId, messageId, payload) => {
          telegramUpdates.push({ chatId, messageId, payload });
          return payload;
        },
        renderFlowStep: () => ({ text: 'Confirm schedule' }),
      });
      assert.deepEqual(await telegramEvent, { type: 'tasks.changed' });
      assert.equal(telegramFlowState.get('telegram', telegramPlatformId), null);
      assert.equal(telegramUpdates.length, 1);
      assert.equal(telegramUpdates[0].chatId, telegramPlatformId);
      assert.match(telegramUpdates[0].payload.text, /Telegram disposable schedule/);

      const discordFlowState = createFlowStateStore();
      discordFlowState.start('discord', discordPlatformId, 'task_guided', 'awaiting_confirm', {
        name: 'Discord disposable schedule',
        walletLabel: 'Trading',
        contractAddress: '0x0000000000000000000000000000000000000022',
        quantity: 1,
        priceETH: 0,
        chain: 'ethereum',
        mintTime: future,
      });
      const discordHandler = createDiscordInteractionHandler({ identity, commands, flowState: discordFlowState });
      const discordTap = discordScheduleTap(discordPlatformId);
      const discordEvent = nextSocketMessage(socket);
      await discordHandler(discordTap);
      assert.deepEqual(await discordEvent, { type: 'tasks.changed' });
      assert.equal(discordFlowState.get('discord', discordPlatformId), null);
      assert.match(discordTap.replies[0].content, /Discord disposable schedule/);
      const discordTask = (await commands.tasks(discordUserId))
        .find(task => task.name === 'Discord disposable schedule');
      assert.ok(discordTask, 'the real Discord confirmation handler must create a canonical task');

      const stored = await pool.query(
        'SELECT id,user_id FROM mint_tasks WHERE id=ANY($1::UUID[]) ORDER BY id',
        [[telegramTask.id, discordTask.id]],
      );
      assert.equal(stored.rowCount, 2);
      assert.deepEqual(new Set(stored.rows.map(row => row.user_id)), new Set([telegramUserId]));

      const dashboard = await fetch(`${base}/api/tasks?page=1&pageSize=10&status=pending`, {
        headers: { cookie: dashboardCookie },
      });
      assert.equal(dashboard.status, 200);
      const dashboardPage = await dashboard.json();
      assert.deepEqual(
        dashboardPage.items.map(task => task.id).sort(),
        [telegramTask.id, discordTask.id].sort(),
      );

      const unrelated = await fetch(`${base}/api/tasks?page=1&pageSize=10&status=pending`, {
        headers: { cookie: otherCookie },
      });
      assert.equal(unrelated.status, 200);
      assert.deepEqual((await unrelated.json()).items, []);

      const unrelatedDetails = await fetch(`${base}/api/tasks/${telegramTask.id}`, {
        headers: { cookie: otherCookie },
      });
      assert.equal(unrelatedDetails.status, 400);
      assert.match((await unrelatedDetails.json()).issues[0].message, /not found/i);

      const unrelatedControl = await fetch(`${base}/api/tasks/${discordTask.id}/control`, {
        method: 'POST',
        headers: {
          cookie: otherCookie,
          'content-type': 'application/json',
          'x-csrf-token': otherSession.csrfToken,
        },
        body: JSON.stringify({ action: 'pause' }),
      });
      assert.equal(unrelatedControl.status, 400);
      assert.match((await unrelatedControl.json()).issues[0].message, /not found|cannot be paused/i);

      const dashboardPauseTelegramEvent = nextSocketMessage(socket);
      const dashboardPauseTelegram = await fetch(`${base}/api/tasks/${telegramTask.id}/control`, {
        method: 'POST',
        headers: {
          cookie: dashboardCookie,
          'content-type': 'application/json',
          'x-csrf-token': dashboardSession.csrfToken,
        },
        body: JSON.stringify({ action: 'pause' }),
      });
      assert.equal(dashboardPauseTelegram.status, 200);
      assert.equal((await dashboardPauseTelegram.json()).status, 'paused');
      assert.deepEqual(await dashboardPauseTelegramEvent, { type: 'tasks.changed' });

      const discordResumeTelegramEvent = nextSocketMessage(socket);
      assert.equal((await commands.controlTask(discordUserId, 'resume', telegramTask.id)).status, 'scheduled');
      assert.deepEqual(await discordResumeTelegramEvent, { type: 'tasks.changed' });

      const dashboardPauseDiscordEvent = nextSocketMessage(socket);
      const dashboardPauseDiscord = await fetch(`${base}/api/tasks/${discordTask.id}/control`, {
        method: 'POST',
        headers: {
          cookie: dashboardCookie,
          'content-type': 'application/json',
          'x-csrf-token': dashboardSession.csrfToken,
        },
        body: JSON.stringify({ action: 'pause' }),
      });
      assert.equal(dashboardPauseDiscord.status, 200);
      assert.equal((await dashboardPauseDiscord.json()).status, 'paused');
      assert.deepEqual(await dashboardPauseDiscordEvent, { type: 'tasks.changed' });

      const telegramResumeDiscordEvent = nextSocketMessage(socket);
      assert.equal((await commands.controlTask(telegramUserId, 'resume', discordTask.id)).status, 'scheduled');
      assert.deepEqual(await telegramResumeDiscordEvent, { type: 'tasks.changed' });

      const dashboardCreateEvent = nextSocketMessage(socket);
      const dashboardCreate = await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: {
          cookie: dashboardCookie,
          'content-type': 'application/json',
          'x-csrf-token': dashboardSession.csrfToken,
        },
        body: JSON.stringify({
          name: 'Dashboard disposable schedule',
          walletLabel: 'Trading',
          contractAddress: '0x0000000000000000000000000000000000000033',
          quantity: 1,
          priceETH: 0,
          chain: 'ethereum',
          mintTime: future,
        }),
      });
      assert.equal(dashboardCreate.status, 201);
      const dashboardTask = await dashboardCreate.json();
      assert.deepEqual(await dashboardCreateEvent, { type: 'tasks.changed' });

      const telegramPauseEvent = nextSocketMessage(socket);
      assert.equal((await commands.controlTask(telegramUserId, 'pause', dashboardTask.id)).status, 'paused');
      assert.deepEqual(await telegramPauseEvent, { type: 'tasks.changed' });

      const discordResumeEvent = nextSocketMessage(socket);
      assert.equal((await commands.controlTask(discordUserId, 'resume', dashboardTask.id)).status, 'scheduled');
      assert.deepEqual(await discordResumeEvent, { type: 'tasks.changed' });

      const details = await fetch(`${base}/api/tasks/${dashboardTask.id}`, {
        headers: { cookie: dashboardCookie },
      });
      assert.equal(details.status, 200);
      assert.equal((await details.json()).status, 'scheduled');

      const reconstructedState = await storage.loadSystemState();
      const reconstructedCommands = createBotCommandService({
        ...commandDependencies,
        schedulerRepository: createSchedulerRepository(pool),
        getState: () => reconstructedState,
        broadcast: () => {},
      });
      const afterServiceReconstruction = await reconstructedCommands.tasksPage(telegramUserId, {
        page: 1,
        pageSize: 10,
        status: 'pending',
      });
      assert.deepEqual(
        afterServiceReconstruction.items.map(task => task.id).sort(),
        [telegramTask.id, discordTask.id, dashboardTask.id].sort(),
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(unrelatedSocketMessages, []);
    } finally {
      if (socket) socket.close();
      if (otherSocket) otherSocket.close();
      if (hub) await hub.close().catch(() => {});
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      if (userIds.length) {
        // wallets and mint_tasks intentionally use restrictive owner FKs, so remove the test-owned
        // rows first. Do not suppress cleanup errors: a green integration test must not leave
        // seven-day schedules or synthetic identities behind in the disposable database.
        await pool.query('DELETE FROM mint_tasks WHERE user_id=ANY($1::UUID[])', [userIds]);
        await pool.query('DELETE FROM wallets WHERE user_id=ANY($1::UUID[])', [userIds]);
        await pool.query('DELETE FROM users WHERE user_id=ANY($1::UUID[])', [userIds]);
      }
      await pool.end();
    }
  });

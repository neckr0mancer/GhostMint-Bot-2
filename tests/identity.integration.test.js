const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { CONFIG } = require('../src/config');
const { LinkCodeError, createIdentityService, hashCode } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createKeyEncryption } = require('../src/security/keyEncryption');
const { createPostgresStorage } = require('../src/storage/postgresStorage');
const { ValidationError, requestSchemas } = require('../src/validation/domain');
const { createTestDatabasePool, integrationTest, runTestMigrations } = require('./helpers/disposableDatabase');

async function migrate() {
  await runTestMigrations({
    migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations'),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

function waitForBarrier(promise, label, timeoutMs = 20_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

integrationTest('different Telegram accounts automatically resolve to different stable users', { timeout: 120_000 }, async () => {
  await migrate();
  const pool = await createTestDatabasePool({ max: 2 });
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const suffix = `${process.pid}-${Date.now()}`;
  try {
    const first = await identity.resolveOrCreate('telegram', `telegram-a-${suffix}`);
    const second = await identity.resolveOrCreate('telegram', `telegram-b-${suffix}`);
    assert.notEqual(first, second);
    assert.equal(await identity.resolveOrCreate('telegram', `telegram-a-${suffix}`), first);
  } finally {
    await pool.end();
  }
});

integrationTest('a first-seen Discord account is created and can link into an existing Telegram identity', { timeout: 120_000 }, async () => {
  await migrate();
  const pool = await createTestDatabasePool({ max: 2 });
  const repository = createPostgresIdentityRepository(pool);
  const identity = createIdentityService(repository);
  const suffix = `${process.pid}-${Date.now()}`;
  try {
    const standalone = await identity.resolveOrCreate('discord', `standalone-discord-${suffix}`);
    assert.equal(await identity.resolveOrCreate('discord', `standalone-discord-${suffix}`), standalone);
    const telegramUser = await identity.resolveOrCreate('telegram', `telegram-link-${suffix}`);
    const link = await identity.createLinkCode(telegramUser);
    assert.equal(await identity.consumeLinkCode({ code: link.code, platform: 'discord',
      platformUserId: `linked-discord-${suffix}` }), telegramUser);
    assert.equal(await identity.resolveOrCreate('discord', `linked-discord-${suffix}`), telegramUser);
  } finally { await pool.end(); }
});

integrationTest('wallet and task repository operations cannot cross Telegram user ownership', { timeout: 120_000 }, async () => {
  await migrate();
  const pool = await createTestDatabasePool({ max: 2 });
  const repository = createPostgresIdentityRepository(pool);
  const identity = createIdentityService(repository);
  const storage = createPostgresStorage(pool);
  const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
  const suffix = `${process.pid}-${Date.now()}`;
  const walletLabel = `owned-${suffix}`;
  const taskId = randomUUID();
  try {
    const ownerId = await identity.resolveOrCreate('telegram', `owner-${suffix}`);
    const attackerId = await identity.resolveOrCreate('telegram', `attacker-${suffix}`);
    await storage.addWallet({ userId: ownerId, label: walletLabel,
      address: '0x0000000000000000000000000000000000000002', chain: 'ethereum',
      keyEnvelope: crypto.encrypt(`0x${'56'.repeat(32)}`), minted: 0, addedAt: Date.now() });
    await storage.saveTask({ userId: ownerId, id: taskId, name: 'owned task', walletLabel,
      contract: '0x0000000000000000000000000000000000000003', fn: 'mint', qty: 1,
      price: 0, gas: null, mintTime: Date.now() + 60_000, status: 'waiting', createdAt: Date.now() });

    const attackerState = await storage.loadState(attackerId);
    assert.equal(attackerState.wallets.some(wallet => wallet.label === walletLabel), false);
    assert.equal(attackerState.tasks.some(task => task.id === taskId), false);
    assert.equal(await storage.deleteWallet(attackerId, walletLabel), false);
    assert.equal(await storage.deleteTask(attackerId, taskId), false);
    assert.throws(() => requestSchemas.taskDeletion({ id: 'not-an-id' }), ValidationError);

    const ownerState = await storage.loadState(ownerId);
    assert.equal(ownerState.wallets.some(wallet => wallet.label === walletLabel), true);
    assert.equal(ownerState.tasks.some(task => task.id === taskId), true);
    await storage.deleteTask(ownerId, taskId);
    await storage.deleteWallet(ownerId, walletLabel);
  } finally {
    await storage.close();
  }
});

integrationTest('link codes expire and are single-use', { timeout: 120_000 }, async () => {
  await migrate();
  const pool = await createTestDatabasePool({ max: 2 });
  const repository = createPostgresIdentityRepository(pool);
  let clock = Date.now();
  const identity = createIdentityService(repository, { now: () => clock });
  const suffix = `${process.pid}-${Date.now()}`;
  try {
    const userId = await identity.resolveOrCreate('telegram', `link-owner-${suffix}`);
    const valid = await identity.createLinkCode(userId);
    const linkedUserId = await identity.consumeLinkCode({
      code: valid.code, platform: 'discord', platformUserId: `discord-${suffix}`,
    });
    assert.equal(linkedUserId, userId);
    await assert.rejects(
      identity.consumeLinkCode({ code: valid.code, platform: 'discord', platformUserId: `discord-${suffix}` }),
      LinkCodeError,
    );

    const expiring = await identity.createLinkCode(userId);
    clock = expiring.expiresAt + 1;
    await assert.rejects(
      identity.consumeLinkCode({ code: expiring.code, platform: 'discord', platformUserId: `discord-expired-${suffix}` }),
      LinkCodeError,
    );
  } finally {
    await pool.end();
  }
});

integrationTest('a bot-first identity race cannot consume a link code for the wrong account',
  { timeout: 120_000 }, async () => {
    await migrate();
    const pool = await createTestDatabasePool({ max: 4 });
    const setupIdentity = createIdentityService(createPostgresIdentityRepository(pool));
    const suffix = `${process.pid}-${Date.now()}`;
    const platformUserId = `race-discord-${suffix}`;
    let botInsertFinished;
    let allowBotCommit;
    let consumerInsertStarted;
    let connectionNumber = 0;
    let botPromise;
    let consumePromise;
    let botUserId;
    let consumeResult;
    let targetUserId;

    const controlledPool = {
      query: (...args) => pool.query(...args),
      async connect() {
        const client = await pool.connect();
        const number = ++connectionNumber;
        const query = client.query.bind(client);
        return {
          async query(sql, params) {
            const normalized = String(sql).replace(/\s+/g, ' ').trim();
            if (number === 1 && normalized.startsWith('INSERT INTO linked_accounts')) {
              const result = await query(sql, params);
              botInsertFinished.resolve();
              return result;
            }
            if (number === 1 && normalized === 'COMMIT') await allowBotCommit.promise;
            if (number === 2 && normalized.startsWith('INSERT INTO linked_accounts')
              && normalized.includes('ON CONFLICT DO NOTHING')) {
              consumerInsertStarted.resolve();
            }
            return query(sql, params);
          },
          release: client.release.bind(client),
        };
      },
    };

    try {
      targetUserId = await setupIdentity.resolveOrCreate('telegram', `race-target-${suffix}`);
      const link = await setupIdentity.createLinkCode(targetUserId);
      botInsertFinished = deferred();
      allowBotCommit = deferred();
      consumerInsertStarted = deferred();
      const repository = createPostgresIdentityRepository(controlledPool);

      botPromise = repository.resolveOrCreateIdentity({ platform: 'discord', platformUserId });
      await waitForBarrier(botInsertFinished.promise, 'the bot-first linked identity insert');
      consumePromise = repository.consumeLinkCode({
        codeHash: hashCode(link.code), platform: 'discord', platformUserId, now: Date.now(),
      });
      await waitForBarrier(consumerInsertStarted.promise, 'the link-code identity insert');
      allowBotCommit?.resolve();

      [botUserId, consumeResult] = await Promise.all([botPromise, consumePromise]);
      assert.notEqual(botUserId, targetUserId);
      assert.deepEqual(consumeResult, { status: 'conflict' });

      const durableIdentity = await pool.query(
        'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2',
        ['discord', platformUserId],
      );
      assert.equal(durableIdentity.rows[0]?.user_id, botUserId);
      const targetDiscord = await pool.query(
        'SELECT 1 FROM linked_accounts WHERE user_id=$1 AND platform=$2',
        [targetUserId, 'discord'],
      );
      assert.equal(targetDiscord.rowCount, 0);
      const code = await pool.query(
        'SELECT used_at FROM account_link_codes WHERE user_id=$1 ORDER BY expires_at DESC LIMIT 1',
        [targetUserId],
      );
      assert.equal(code.rows[0]?.used_at, null, 'the raced code must remain unused');
    } finally {
      allowBotCommit?.resolve();
      await Promise.allSettled([botPromise, consumePromise].filter(Boolean));
      const racedIdentity = await pool.query(
        'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2',
        ['discord', platformUserId],
      ).catch(() => ({ rows: [] }));
      const users = [...new Set([
        botUserId, targetUserId, racedIdentity.rows[0]?.user_id,
      ].filter(Boolean))];
      if (users.length) await pool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])', [users]).catch(() => {});
      await pool.end();
    }
  });

integrationTest('mergeAccount repoints an empty duplicate account onto an existing one and removes it', { timeout: 120_000 }, async () => {
  await migrate();
  const pool = await createTestDatabasePool({ max: 2 });
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const suffix = `${process.pid}-${Date.now()}`;
  const sourcePlatformUserId = `stray-discord-${suffix}`;
  const targetPlatformUserId = `telegram-owner-of-merge-${suffix}`;
  try {
    const sourceUserId = await identity.resolveOrCreate('discord', sourcePlatformUserId);
    const targetUserId = await identity.resolveOrCreate('telegram', targetPlatformUserId);

    const result = await identity.mergeAccount({
      sourcePlatform: 'discord', sourcePlatformUserId, targetPlatform: 'telegram', targetPlatformUserId,
    });
    assert.equal(result.sourceUserId, sourceUserId);
    assert.equal(result.targetUserId, targetUserId);

    assert.equal(await identity.resolveOrCreate('discord', sourcePlatformUserId), targetUserId,
      'the Discord identity now resolves to the target account, not a fresh one');

    const repeated = await identity.mergeAccount({
      sourcePlatform: 'discord', sourcePlatformUserId, targetPlatform: 'telegram', targetPlatformUserId,
    });
    assert.deepEqual(repeated,{sourceUserId:targetUserId,targetUserId,status:'already_unified'},
      'a retry after an uncertain response is an idempotent success, not a misleading failure');
  } finally {
    await pool.end();
  }
});

integrationTest('mergeAccount refuses and changes nothing if the duplicate account has a wallet', { timeout: 120_000 }, async () => {
  await migrate();
  const pool = await createTestDatabasePool({ max: 2 });
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const storage = createPostgresStorage(pool);
  const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
  const suffix = `${process.pid}-${Date.now()}`;
  const sourcePlatformUserId = `used-discord-${suffix}`;
  const targetPlatformUserId = `telegram-target-${suffix}`;
  const walletLabel = `merge-guard-${suffix}`;
  try {
    const sourceUserId = await identity.resolveOrCreate('discord', sourcePlatformUserId);
    await identity.resolveOrCreate('telegram', targetPlatformUserId);
    await storage.addWallet({ userId: sourceUserId, label: walletLabel,
      address: '0x0000000000000000000000000000000000000004', chain: 'ethereum',
      keyEnvelope: crypto.encrypt(`0x${'78'.repeat(32)}`), minted: 0, addedAt: Date.now() });

    await assert.rejects(
      identity.mergeAccount({ sourcePlatform: 'discord', sourcePlatformUserId, targetPlatform: 'telegram', targetPlatformUserId }),
      error => error.issues?.[0]?.field === 'sourcePlatformUserId' && /wallets/.test(error.issues[0].message),
    );

    assert.equal(await identity.resolveOrCreate('discord', sourcePlatformUserId), sourceUserId,
      'the duplicate account must still exist, untouched, after a refused merge');
    await storage.deleteWallet(sourceUserId, walletLabel);
  } finally {
    await storage.close();
  }
});

integrationTest('account merge preview inventories mixed data without changing ownership and detects later drift',
  { timeout: 120_000 }, async () => {
    await migrate();
    const pool = await createTestDatabasePool({ max: 2 });
    const repository = createPostgresIdentityRepository(pool);
    const identity = createIdentityService(repository);
    const storage = createPostgresStorage(pool);
    const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
    const suffix = `${process.pid}-${Date.now()}`;
    const sourcePlatformUserId = `preview-discord-${suffix}`;
    const targetPlatformUserId = `preview-telegram-${suffix}`;
    const address = '0x0000000000000000000000000000000000000007';
    let sourceUserId;let targetUserId;
    try {
      sourceUserId = await identity.resolveOrCreate('discord', sourcePlatformUserId);
      targetUserId = await identity.resolveOrCreate('telegram', targetPlatformUserId);
      await storage.addWallet({ userId: sourceUserId, label: `source-${suffix}`, address, chain: 'ethereum',
        keyEnvelope: crypto.encrypt(`0x${'71'.repeat(32)}`), minted: 0, addedAt: Date.now() });
      await storage.addActivity({ userId: sourceUserId, status: 'success', title: 'Preview evidence',
        walletLabel: `source-${suffix}`, txHash: null, explorer: null, time: Date.now() });

      const first = await identity.previewAccountMerge({
        sourcePlatform: 'discord', sourcePlatformUserId,
        targetPlatform: 'telegram', targetPlatformUserId,
      });
      assert.equal(first.previewOnly, true);
      assert.equal(first.executionAvailable, false);
      assert.equal(first.sourceUserId, sourceUserId);
      assert.equal(first.targetUserId, targetUserId);
      assert.equal(first.summary.movable.domains.find(item => item.key === 'wallets')?.count, 1);
      assert.equal(first.summary.movable.domains.find(item => item.key === 'activity')?.count, 1);
      assert.equal(await identity.resolveOrCreate('discord', sourcePlatformUserId), sourceUserId,
        'preview must not re-key the source identity');

      await pool.query('UPDATE wallets SET minted=minted+1 WHERE user_id=$1', [sourceUserId]);
      const sameCountDrift = await identity.previewAccountMerge({
        sourcePlatform: 'discord', sourcePlatformUserId,
        targetPlatform: 'telegram', targetPlatformUserId,
      });
      assert.equal(sameCountDrift.summary.movable.domains
        .find(item => item.key === 'wallets')?.count, 1);
      assert.notEqual(sameCountDrift.snapshotDigest, first.snapshotDigest,
        'a row update must invalidate an approval even when every domain count stays unchanged');

      await storage.addWallet({ userId: targetUserId, label: `target-${suffix}`, address, chain: 'ethereum',
        keyEnvelope: crypto.encrypt(`0x${'72'.repeat(32)}`), minted: 0, addedAt: Date.now() });
      const second = await identity.previewAccountMerge({
        sourcePlatform: 'discord', sourcePlatformUserId,
        targetPlatform: 'telegram', targetPlatformUserId,
      });
      assert.notEqual(second.snapshotDigest, sameCountDrift.snapshotDigest);
      assert.equal(second.classification, 'blocked');
      assert.equal(second.summary.blocking.domains
        .find(item => item.key === 'walletAddressCollisions')?.count, 1);
    } finally {
      const users = [sourceUserId, targetUserId].filter(Boolean);
      if (users.length) await pool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])', [users]).catch(() => {});
      await storage.close();
    }
  });

integrationTest('reviewed account merge atomically moves data, removes the duplicate, and replays its receipt',
  { timeout: 120_000 }, async () => {
    await migrate();
    const pool = await createTestDatabasePool({ max: 4 });
    const repository = createPostgresIdentityRepository(pool);
    const committed = [];
    const identity = createIdentityService(repository, {
      onAccountMergeCommitted: async receipt => committed.push(receipt),
    });
    const storage = createPostgresStorage(pool);
    const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
    const suffix = `${process.pid}-${Date.now()}`;
    const sourcePlatformUserId = `execute-discord-${suffix}`;
    const targetPlatformUserId = `execute-telegram-${suffix}`;
    const walletLabel = `execute-wallet-${suffix}`;
    let sourceUserId;let targetUserId;
    try {
      sourceUserId = await identity.resolveOrCreate('discord', sourcePlatformUserId);
      targetUserId = await identity.resolveOrCreate('telegram', targetPlatformUserId);
      await pool.query('UPDATE users SET is_owner=TRUE,is_root_owner=TRUE WHERE user_id=$1', [targetUserId]);
      await storage.addWallet({ userId: sourceUserId, label: walletLabel,
        address: '0x0000000000000000000000000000000000000008', chain: 'ethereum',
        keyEnvelope: crypto.encrypt(`0x${'73'.repeat(32)}`), minted: 0, addedAt: Date.now() });
      await storage.addActivity({ userId: sourceUserId, status: 'success', title: 'Merge evidence',
        walletLabel, txHash: null, explorer: null, time: Date.now() });
      const targetSession = await pool.query(
        `INSERT INTO dashboard_sessions (user_id,token_hash,csrf_token_hash,expires_at,client_label)
         VALUES ($1,$2,$3,NOW()+INTERVAL '8 hours','merge integration') RETURNING session_id`,
        [targetUserId, `merge-token-${suffix}`, `merge-csrf-${suffix}`],
      );

      const plan = await identity.previewAccountMerge({
        sourcePlatform: 'discord', sourcePlatformUserId,
        targetPlatform: 'telegram', targetPlatformUserId,
      });
      assert.equal(plan.classification, 'ready');
      assert.equal(plan.summary.revocable.domains
        .find(item => item.key === 'dashboardSessions')?.count, 1);
      // This is exactly what requireSession does between the preview and execute HTTP requests.
      // It must not invalidate the reviewed ownership graph by changing only sliding-session time.
      await pool.query(
        `UPDATE dashboard_sessions SET last_seen_at=NOW(),expires_at=NOW()+INTERVAL '8 hours'
         WHERE session_id=$1`, [targetSession.rows[0].session_id],
      );
      const request = {
        sourcePlatform: 'discord', sourcePlatformUserId,
        targetPlatform: 'telegram', targetPlatformUserId,
        expectedSourceUserId: sourceUserId,
        expectedTargetUserId: targetUserId,
        expectedPlanVersion: plan.planVersion,
        expectedSnapshotDigest: plan.snapshotDigest,
        resolutionMap: {},
        confirmationText: `MERGE ${sourceUserId} INTO ${targetUserId}`,
      };
      const receipt = await identity.executeAccountMerge(targetUserId, request);
      assert.equal(receipt.status, 'committed');
      assert.equal(receipt.outcomeCode, 'MERGE_COMMITTED');
      assert.equal(receipt.sourceUserId, sourceUserId);
      assert.equal(receipt.targetUserId, targetUserId);
      assert.equal(receipt.movedCounts.wallets, 1);
      assert.equal(receipt.movedCounts.activity, 1);
      assert.equal(receipt.revokedCounts.dashboardSessions, 1);
      assert.equal(receipt.replayed, false);
      assert.equal(committed.length, 1, 'runtime reconciliation runs once after the durable commit');

      const moved = await pool.query(
        `SELECT
           (SELECT COUNT(*)::INTEGER FROM wallets WHERE user_id=$1 AND label=$2) AS wallets,
           (SELECT COUNT(*)::INTEGER FROM activity WHERE user_id=$1 AND wallet_label=$2) AS activity,
           (SELECT COUNT(*)::INTEGER FROM users WHERE user_id=$3) AS source_users`,
        [targetUserId, walletLabel, sourceUserId],
      );
      assert.deepEqual(moved.rows[0], { wallets: 1, activity: 1, source_users: 0 });
      assert.equal(await identity.resolveOrCreate('discord', sourcePlatformUserId), targetUserId);

      const replay = await identity.executeAccountMerge(targetUserId, request);
      assert.equal(replay.eventId, receipt.eventId);
      assert.equal(replay.replayed, true);
      assert.equal(committed.length, 1, 'an idempotent replay must not repeat runtime teardown');
      const evidence = await pool.query(
        'SELECT COUNT(*)::INTEGER AS count FROM account_merge_events WHERE event_id=$1',
        [receipt.eventId],
      );
      assert.equal(evidence.rows[0].count, 1);
    } finally {
      const users = [sourceUserId, targetUserId].filter(Boolean);
      if (users.length) await pool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])', [users]).catch(() => {});
      await storage.close();
    }
  });

integrationTest('reviewed account merge rejects tuple drift and leaves both accounts untouched',
  { timeout: 120_000 }, async () => {
    await migrate();
    const pool = await createTestDatabasePool({ max: 4 });
    const repository = createPostgresIdentityRepository(pool);
    const identity = createIdentityService(repository);
    const storage = createPostgresStorage(pool);
    const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
    const suffix = `${process.pid}-${Date.now()}`;
    const sourcePlatformUserId = `stale-discord-${suffix}`;
    const targetPlatformUserId = `stale-telegram-${suffix}`;
    const walletLabel = `stale-wallet-${suffix}`;
    let sourceUserId;let targetUserId;
    try {
      sourceUserId = await identity.resolveOrCreate('discord', sourcePlatformUserId);
      targetUserId = await identity.resolveOrCreate('telegram', targetPlatformUserId);
      await pool.query('UPDATE users SET is_owner=TRUE,is_root_owner=TRUE WHERE user_id=$1', [targetUserId]);
      await storage.addWallet({ userId: sourceUserId, label: walletLabel,
        address: '0x0000000000000000000000000000000000000009', chain: 'ethereum',
        keyEnvelope: crypto.encrypt(`0x${'74'.repeat(32)}`), minted: 0, addedAt: Date.now() });
      const plan = await identity.previewAccountMerge({
        sourcePlatform: 'discord', sourcePlatformUserId,
        targetPlatform: 'telegram', targetPlatformUserId,
      });
      assert.equal(plan.classification, 'ready');
      await pool.query('UPDATE wallets SET minted=minted+1 WHERE user_id=$1', [sourceUserId]);

      await assert.rejects(identity.executeAccountMerge(targetUserId, {
        sourcePlatform: 'discord', sourcePlatformUserId,
        targetPlatform: 'telegram', targetPlatformUserId,
        expectedSourceUserId: sourceUserId,
        expectedTargetUserId: targetUserId,
        expectedPlanVersion: plan.planVersion,
        expectedSnapshotDigest: plan.snapshotDigest,
        resolutionMap: {},
        confirmationText: `MERGE ${sourceUserId} INTO ${targetUserId}`,
      }), error => Boolean(error.code === 'ACCOUNT_MERGE_STALE' && error.details?.freshPlan));

      const untouched = await pool.query(
        `SELECT
           (SELECT COUNT(*)::INTEGER FROM users WHERE user_id=$1) AS source_users,
           (SELECT COUNT(*)::INTEGER FROM wallets WHERE user_id=$1 AND label=$2) AS source_wallets,
           (SELECT COUNT(*)::INTEGER FROM wallets WHERE user_id=$3 AND label=$2) AS target_wallets,
           (SELECT COUNT(*)::INTEGER FROM account_merge_events
             WHERE source_user_id=$1 AND target_user_id=$3) AS events`,
        [sourceUserId, walletLabel, targetUserId],
      );
      assert.deepEqual(untouched.rows[0], {
        source_users: 1, source_wallets: 1, target_wallets: 0, events: 0,
      });
    } finally {
      const users = [sourceUserId, targetUserId].filter(Boolean);
      if (users.length) await pool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])', [users]).catch(() => {});
      await storage.close();
    }
  });

integrationTest('opposite-direction empty-account merges converge without a deadlock',
  { timeout: 120_000 }, async () => {
    await migrate();
    const pool = await createTestDatabasePool({ max: 4 });
    const repository = createPostgresIdentityRepository(pool);
    const identity = createIdentityService(repository);
    const suffix = `${process.pid}-${Date.now()}`;
    const discordId = `merge-race-discord-${suffix}`;
    const telegramId = `merge-race-telegram-${suffix}`;
    let discordUserId;
    let telegramUserId;
    try {
      discordUserId = await identity.resolveOrCreate('discord', discordId);
      telegramUserId = await identity.resolveOrCreate('telegram', telegramId);
      const results = await Promise.all([
        repository.mergeAccount({
          sourcePlatform: 'discord', sourcePlatformUserId: discordId,
          targetPlatform: 'telegram', targetPlatformUserId: telegramId,
        }),
        repository.mergeAccount({
          sourcePlatform: 'telegram', sourcePlatformUserId: telegramId,
          targetPlatform: 'discord', targetPlatformUserId: discordId,
        }),
      ]);

      assert.equal(results.filter(result => result.status === 'already_unified').length, 1);
      assert.equal(results.filter(result => result.status !== 'already_unified'
        && result.sourceUserId !== result.targetUserId).length, 1);

      const identities = await pool.query(
        `SELECT platform,platform_user_id,user_id FROM linked_accounts
         WHERE (platform='discord' AND platform_user_id=$1)
            OR (platform='telegram' AND platform_user_id=$2)
         ORDER BY platform`,
        [discordId, telegramId],
      );
      assert.equal(identities.rowCount, 2);
      assert.equal(identities.rows[0].user_id, identities.rows[1].user_id);
      const originalUsers = await pool.query(
        'SELECT user_id FROM users WHERE user_id=ANY($1::uuid[])',
        [[discordUserId, telegramUserId]],
      );
      assert.equal(originalUsers.rowCount, 1);
      assert.equal(originalUsers.rows[0].user_id, identities.rows[0].user_id);
    } finally {
      const users = [discordUserId, telegramUserId].filter(Boolean);
      if (users.length) await pool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])', [users]).catch(() => {});
      await pool.end();
    }
  });

integrationTest('dashboard chain, balance, and time preferences persist through PostgreSQL', { timeout: 120_000 }, async () => {
  await migrate();
  const pool = await createTestDatabasePool({ max: 2 });
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const suffix = `${process.pid}-${Date.now()}`;
  let userId;
  try {
    userId = await identity.resolveOrCreate('telegram', `dashboard-preferences-${suffix}`);
    const firstRepository = createPostgresIdentityRepository(pool);
    assert.equal(await firstRepository.setDefaultChain(userId, 'robinhood'), 'robinhood');
    assert.equal(await firstRepository.setLowBalanceThreshold(userId, '0.025'), '0.025');
    assert.equal(await firstRepository.setTimeFormat(userId, '12h'), '12h');

    // A fresh repository object proves these are database values, not process-local state.
    const restartedRepository = createPostgresIdentityRepository(pool);
    assert.equal(await restartedRepository.getDefaultChain(userId), 'robinhood');
    assert.equal(await restartedRepository.getLowBalanceThreshold(userId), '0.025');
    assert.equal(await restartedRepository.getTimeFormat(userId), '12h');
  } finally {
    if (userId) await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    await pool.end();
  }
});

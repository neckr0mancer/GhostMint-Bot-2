const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const dotenv = require('dotenv');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { randomUUID } = require('node:crypto');

const PROJECT_ROOT = path.join(__dirname, '..');
const EXAMPLE_ENV = dotenv.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.env.example')));
const localEnvPath = path.join(PROJECT_ROOT, '.env');
const LOCAL_ENV = fs.existsSync(localEnvPath) ? dotenv.parse(fs.readFileSync(localEnvPath)) : {};

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited with code ${child.exitCode}.\n${output()}`);
    }

    try {
      const response = await fetch(url);
      return response;
    } catch {
      // The child process may still be binding its HTTP listener.
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${url}.\n${output()}`);
}

const smokeTest = LOCAL_ENV.DATABASE_URL && LOCAL_ENV.DATABASE_URL_UNPOOLED ? test : test.skip;

smokeTest('the application starts and exposes a healthy database-backed service', { timeout: 20_000 }, async t => {
  await runMigrations({
    connectionString: LOCAL_ENV.DATABASE_URL_UNPOOLED,
    migrationsDirectory: path.join(PROJECT_ROOT, 'migrations'),
  });
  const port = await reservePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'index.js')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...EXAMPLE_ENV,
      DATABASE_URL: LOCAL_ENV.DATABASE_URL,
      DATABASE_URL_UNPOOLED: LOCAL_ENV.DATABASE_URL_UNPOOLED,
      PORT: String(port),
      TELEGRAM_BOT_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
  const response = await waitForHealth(`http://127.0.0.1:${port}/health`, child, output);
  const body = await response.json();

  assert.ok(['ok','degraded'].includes(body.status));
  assert.equal(body.dependencies.database.status, 'up');
  assert.equal(typeof body.dependencies.rpc, 'object');
  assert.equal(typeof body.dependencies.scheduler.status, 'string');
  assert.equal(typeof body.uptime, 'number');
  assert.doesNotMatch(stdout, new RegExp(EXAMPLE_ENV.ENCRYPTION_SECRET));
});

// Regression test: startup used to await discordBot.start() with no try/catch, so an invalid or
// revoked Discord token (or any transient Discord API failure) aborted the rest of the sequential
// start() function -- meaning the HTTP server (including /health and the dashboard), the scheduler,
// the social watch worker, the retention worker, and sniper-watcher restoration never ran either,
// even though every one of those is otherwise fully independent of Discord.
smokeTest('a Discord login failure does not prevent the HTTP server and workers from starting', { timeout: 20_000 }, async t => {
  await runMigrations({
    connectionString: LOCAL_ENV.DATABASE_URL_UNPOOLED,
    migrationsDirectory: path.join(PROJECT_ROOT, 'migrations'),
  });
  const port = await reservePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'index.js')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...EXAMPLE_ENV,
      DATABASE_URL: LOCAL_ENV.DATABASE_URL,
      DATABASE_URL_UNPOOLED: LOCAL_ENV.DATABASE_URL_UNPOOLED,
      PORT: String(port),
      TELEGRAM_BOT_TOKEN: '',
      DISCORD_BOT_TOKEN: 'smoke-test-invalid-token-will-fail-login',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_DEV_GUILD_ID: '123456789012345678',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
  const response = await waitForHealth(`http://127.0.0.1:${port}/health`, child, output);
  const body = await response.json();

  assert.ok(['ok','degraded'].includes(body.status),
    'the HTTP server must come up and report health even though Discord login failed');
  assert.equal(body.dependencies.database.status, 'up');
  assert.equal(typeof body.dependencies.scheduler.status, 'string');
  assert.match(stdout, /Discord bot failed to start, continuing without it/);
});

// Regression test: the scheduler worker's executeTask callback used to look up the wallet and
// prepare/submit the mint with no account-status check at all. M16's ban/suspend/deactivate
// enforcement only ran at the per-command choke point (identity.resolveOrCreate), which a due
// scheduled task picked up by the background scheduler loop never passes through -- so a task
// created while the owner was in good standing kept executing and spending from their wallet even
// after they were banned. This proves the real, running scheduler now refuses the task instead.
smokeTest('a banned account\'s due scheduled task fails without executing, instead of spending funds', { timeout: 45_000 }, async t => {
  await runMigrations({
    connectionString: LOCAL_ENV.DATABASE_URL_UNPOOLED,
    migrationsDirectory: path.join(PROJECT_ROOT, 'migrations'),
  });
  const pool = createDatabasePool({ connectionString: LOCAL_ENV.DATABASE_URL, max: 2 });
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = await identity.resolveOrCreate('telegram', `banned-scheduler-${suffix}`);
  const taskId = randomUUID();
  const banReason = `smoke-test-ban-reason-${suffix}`;
  try {
    await pool.query(
      `UPDATE users SET account_status='banned', status_reason=$2, status_changed_at=NOW() WHERE user_id=$1`,
      [userId, banReason]);
    await pool.query(
      `INSERT INTO mint_tasks (id,user_id,name,wallet_label,contract_address,function_name,quantity,
        price_eth,mint_time,status,next_attempt_at,max_attempts,idempotency_key)
       VALUES ($1,$2,'smoke test task','nonexistent-wallet','0x0000000000000000000000000000000000000001',
        'mint',1,0,NOW(),'scheduled',NOW(),3,$3)`,
      [taskId, userId, `scheduled-mint:${userId}:${taskId}`]);

    const port = await reservePort();
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'index.js')], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        ...EXAMPLE_ENV,
        DATABASE_URL: LOCAL_ENV.DATABASE_URL,
        DATABASE_URL_UNPOOLED: LOCAL_ENV.DATABASE_URL_UNPOOLED,
        PORT: String(port),
        TELEGRAM_BOT_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill(); });

    const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
    await waitForHealth(`http://127.0.0.1:${port}/health`, child, output);

    const deadline = Date.now() + 15_000;
    let row;
    do {
      const result = await pool.query('SELECT status,last_error FROM mint_tasks WHERE id=$1 AND user_id=$2', [taskId, userId]);
      row = result.rows[0];
      if (row && row.status !== 'scheduled' && row.status !== 'claimed') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);

    assert.ok(row, 'the task row must still exist');
    assert.equal(row.status, 'failed', `task must fail permanently, not execute or stay pending (last_error: ${row.last_error})\n${output()}`);
    // server.js's schedulerWorker is wired with sanitizeError:safeError, which for AccountBlockedError
    // surfaces error.reason (the ban reason text set on the account) rather than error.message -- so
    // this is the account's status_reason coming through, confirming an AccountBlockedError (and not
    // some other failure) is what stopped the task.
    assert.equal(row.last_error, banReason, `expected the account-status ban reason to surface as last_error\n${output()}`);

    const intents = await pool.query('SELECT 1 FROM transaction_intents WHERE user_id=$1', [userId]);
    assert.equal(intents.rowCount, 0, 'no transaction intent may ever be created for a banned account\'s task');
  } finally {
    await pool.query('DELETE FROM mint_tasks WHERE id=$1', [taskId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    await pool.end();
  }
});

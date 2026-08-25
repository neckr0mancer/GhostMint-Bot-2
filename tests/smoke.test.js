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
  // Deliberately short: a server that has not answered /health within 10s of spawning is treated
  // as broken, and the thrown error carries the child's full output for diagnosis. The OUTER test
  // timeouts below must be budgeted independently and generously -- migrations plus boot against
  // the remote database swing 3-5x between runs on slow links, so an outer ceiling near the happy
  // path kills tests that are working, which reads exactly like the failures these smokes exist
  // to catch.
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

// Booting the real server starts real workers -- scheduler, social watcher, retention, sniper
// watchers -- against whatever DATABASE_URL points at. With production credentials in .env that
// means a second worker instance could claim and broadcast a real due mint (the exact hazard
// dashboard/vite.config.js documents for dev booting). Smoke therefore runs only against an
// explicitly disposable database: point the env vars at throwaway credentials AND set
// SMOKE_ALLOW=RUN. Absent either, these skip instead of silently risking production.
const smokeTest = LOCAL_ENV.DATABASE_URL && LOCAL_ENV.DATABASE_URL_UNPOOLED && process.env.SMOKE_ALLOW === 'RUN' ? test : test.skip;

smokeTest('the application starts and exposes a healthy database-backed service', { timeout: 60_000 }, async t => {
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
smokeTest('a Discord login failure does not prevent the HTTP server and workers from starting', { timeout: 60_000 }, async t => {
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
smokeTest('a banned account\'s due scheduled task fails without executing, instead of spending funds', { timeout: 120_000 }, async t => {
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

    // Generous on purpose. The worker polls once a second and this assertion needs a full
    // claim -> AccountBlockedError -> permanent-fail round trip against a remote database, which
    // measured ~14s standalone but tips past a 15s budget when the rest of the suite has been
    // hammering the same connection pool -- a timeout here was reported as a scheduler failure
    // when nothing was actually broken. Widening only changes how long we wait for a verdict; it
    // does not weaken any assertion below, and a genuinely stuck task still fails the run.
    // The verdict budget below is 60s, so the test's own outer ceiling must exceed the worst-case
    // SUM -- migrations + up to 10s of health waiting + this poll + cleanup -- or the runner kills
    // the test before its own deadline can conclude (45s used to do exactly that on slow links,
    // reporting the test cancelled while it was still legitimately working).
    const deadline = Date.now() + 60_000;
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

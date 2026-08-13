const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const dotenv = require('dotenv');
const { runMigrations } = require('../src/db/migrate');

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

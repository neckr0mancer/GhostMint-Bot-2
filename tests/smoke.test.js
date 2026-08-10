const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const PROJECT_ROOT = path.join(__dirname, '..');

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
      if (response.ok) return response;
    } catch {
      // The child process may still be binding its HTTP listener.
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${url}.\n${output()}`);
}

test('the application starts and exposes a healthy service', { timeout: 15_000 }, async t => {
  const port = await reservePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'index.js')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
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

  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(typeof body.tasks, 'number');
});

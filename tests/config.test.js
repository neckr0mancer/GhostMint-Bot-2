const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_PROBE = [
  "const { CONFIG, getSafeConfigSummary } = require('./src/config');",
  'process.stdout.write(JSON.stringify({ summary: getSafeConfigSummary(), poolMax: CONFIG.databasePoolMax }));',
].join(' ');

const VALID_ENV = Object.freeze({
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: '',
  DATABASE_URL_UNPOOLED: '',
  DATABASE_POOL_MAX: '5',
  SUPPORTED_CHAINS: 'ethereum,base,arbitrum,polygon',
  ENCRYPTION_SECRET: 'dev-encryption-key-7Qv9!m2Lx4Rk8Zp3Cw6N',
  ENCRYPTION_KEY_VERSION: '1',
  ENCRYPTION_OLD_KEYS: '{}',
  DASHBOARD_PASSWORD: 'dev-dashboard-9Nf4!Tq7Vx2Jm8Kp',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  ETH_RPC: '',
  BASE_RPC: '',
  ARB_RPC: '',
  POLYGON_RPC: '',
});

function probeConfig(overrides = {}) {
  return spawnSync(process.execPath, ['--eval', CONFIG_PROBE], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...VALID_ENV, ...overrides },
    encoding: 'utf8',
  });
}

test('accepts valid development configuration and returns only a safe summary', () => {
  const result = probeConfig();
  assert.equal(result.status, 0, result.stderr);

  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.environment, 'development');
  assert.deepEqual(output.summary.supportedChains, ['ethereum', 'base', 'arbitrum', 'polygon']);
  assert.equal(output.summary.telegramEnabled, false);
  assert.equal(output.summary.databaseConfigured, false);
  assert.equal(output.poolMax, 5);

  const serialized = JSON.stringify(output.summary);
  assert.doesNotMatch(serialized, /7Qv9|9Nf4|encryptionSecret|dashboardPassword/);
});

test('accepts each explicit runtime mode when its policy is satisfied', () => {
  assert.equal(probeConfig({ NODE_ENV: 'test' }).status, 0);

  const production = probeConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app:strong-value@pooler.example.com:6543/ghostmint',
    DATABASE_URL_UNPOOLED: 'postgresql://migrator:strong-value@db.example.com:5432/ghostmint',
    ENCRYPTION_SECRET: 'production-key-7Qv9!m2Lx4Rk8Zp3Cw6N5Hs8Df1Aa4Bb9Cc!',
    DASHBOARD_PASSWORD: 'production-access-9Nf4!Tq7Vx2Jm8Kp6Rs',
  });
  assert.equal(production.status, 0, production.stderr);
});

test('refuses to start when any required setting is missing', () => {
  for (const name of ['NODE_ENV', 'SUPPORTED_CHAINS', 'ENCRYPTION_SECRET', 'DASHBOARD_PASSWORD']) {
    const result = probeConfig({ [name]: '' });
    assert.notEqual(result.status, 0, `${name} should be required`);
    assert.match(result.stderr, new RegExp(`${name} is required`));
  }
});

test('requires both database URLs in production and validates their protocols', () => {
  const base = {
    NODE_ENV: 'production',
    ENCRYPTION_SECRET: 'production-key-7Qv9!m2Lx4Rk8Zp3Cw6N5Hs8Df1Aa4Bb9Cc!',
    DASHBOARD_PASSWORD: 'production-access-9Nf4!Tq7Vx2Jm8Kp6Rs',
  };
  const missing = probeConfig(base);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /DATABASE_URL is required/);

  const malformed = probeConfig({ ...base, DATABASE_URL: 'https://db.example.com', DATABASE_URL_UNPOOLED: 'postgresql://user:pass@db.example.com/app' });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /valid PostgreSQL URL/);
});

test('validates versioned old encryption keys without exposing values', () => {
  const oldSecret = 'old-key-material-8Zp3!Cw6N7Qv9Lm2Rx4K';
  const result = probeConfig({ ENCRYPTION_KEY_VERSION: '2', ENCRYPTION_OLD_KEYS: JSON.stringify({ 1: oldSecret }) });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.summary.availableEncryptionKeyVersions, [1, 2]);
  assert.doesNotMatch(result.stdout, new RegExp(oldSecret));
});

test('refuses known default and weak secrets without echoing them', () => {
  const weakSecret = 'ghostmint123';
  const result = probeConfig({ DASHBOARD_PASSWORD: weakSecret });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DASHBOARD_PASSWORD/);
  assert.doesNotMatch(result.stderr, new RegExp(weakSecret));

  const previousDefault = 'ghostmint_change_me_32chars_min!!';
  const previousDefaultResult = probeConfig({ ENCRYPTION_SECRET: previousDefault });
  assert.notEqual(previousDefaultResult.status, 0);
  assert.match(previousDefaultResult.stderr, /known default or placeholder pattern/);
  assert.doesNotMatch(previousDefaultResult.stderr, new RegExp(previousDefault));
});

test('refuses an unsupported environment mode', () => {
  const result = probeConfig({ NODE_ENV: 'staging' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /development, test, production/);
});

test('refuses malformed RPC URLs without echoing their values', () => {
  const invalidRpc = 'ftp://private-token@rpc.invalid/path';
  const result = probeConfig({ ETH_RPC: invalidRpc });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ETH_RPC must be a valid HTTP or HTTPS URL/);
  assert.doesNotMatch(result.stderr, /private-token/);
});

test('refuses unsupported and duplicate chain names', () => {
  const unsupported = probeConfig({ SUPPORTED_CHAINS: 'ethereum,solana' });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /unsupported names: solana/);

  const duplicate = probeConfig({ SUPPORTED_CHAINS: 'ethereum,base,base' });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /must not contain duplicates/);
});

test('requires Telegram token and chat ID to be configured together', () => {
  const result = probeConfig({ TELEGRAM_BOT_TOKEN: '123456:bot-token', TELEGRAM_CHAT_ID: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be configured together/);
  assert.doesNotMatch(result.stderr, /bot-token/);
});

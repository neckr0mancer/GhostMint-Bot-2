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
  RPC_TIMEOUT_MS: '10000',
  RPC_RETRIES: '1',
  SUPPORTED_CHAINS: 'ethereum,base,arbitrum,polygon',
  ENCRYPTION_SECRET: 'dev-encryption-key-7Qv9!m2Lx4Rk8Zp3Cw6N',
  ENCRYPTION_KEY_VERSION: '1',
  ENCRYPTION_OLD_KEYS: '{}',
  TELEGRAM_BOT_TOKEN: '',
  DISCORD_BOT_TOKEN: '',
  DISCORD_APPLICATION_ID: '',
  DISCORD_DEV_GUILD_ID: '',
  SOCIAL_OFFICIAL_API_URL: '',
  SOCIAL_OFFICIAL_API_TOKEN: '',
  SOCIAL_MANAGED_SERVICE_URL: '',
  SOCIAL_MANAGED_SERVICE_TOKEN: '',
  SOCIAL_POLL_INTERVAL_MS: '30000',
  ETHERSCAN_API_KEY: '',
  ETH_RPC: '',
  BASE_RPC: '',
  ARB_RPC: '',
  POLYGON_RPC: '',
  ETH_RPC_URLS: '',
  BASE_RPC_URLS: '',
  ARB_RPC_URLS: '',
  POLYGON_RPC_URLS: '',
});

test('reports only whether the Etherscan key is configured', () => {
  const key='etherscan-private-key';
  const result=probeConfig({ETHERSCAN_API_KEY:key});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.etherscanGasConfigured,true);
  assert.doesNotMatch(result.stdout,new RegExp(key));
});

// Round 20 follow-up: OPENSEA_READ_API_KEY is optional and aliases OPENSEA_API_KEY when unset --
// same "unconfigured means zero behavior change" shape as Round 15's RPC pool splits.
test('OPENSEA_READ_API_KEY unconfigured aliases the main OpenSea key -- reports as not separate', () => {
  const key='opensea-main-key';
  // Explicit empty string, not just omitted: process.env already has this vars-from-the-real-.env
  // problem for every optional key in this suite, but dotenv.config() (called by src/config itself)
  // only fills in variables ABSENT from process.env -- an explicit empty string here is enough to
  // count as "already set" and stops the real .env file's own OPENSEA_READ_API_KEY from leaking in.
  const result=probeConfig({OPENSEA_API_KEY:key, OPENSEA_READ_API_KEY:''});
  assert.equal(result.status,0,result.stderr);
  const summary=JSON.parse(result.stdout).summary;
  assert.equal(summary.openSeaConfigured,true);
  assert.equal(summary.openSeaReadKeySeparate,false);
});

test('OPENSEA_READ_API_KEY configured is reported as a genuinely separate key, and neither key leaks into the summary', () => {
  const mainKey='opensea-main-key';
  const readKey='opensea-read-only-key';
  const result=probeConfig({OPENSEA_API_KEY:mainKey, OPENSEA_READ_API_KEY:readKey});
  assert.equal(result.status,0,result.stderr);
  const summary=JSON.parse(result.stdout).summary;
  assert.equal(summary.openSeaConfigured,true);
  assert.equal(summary.openSeaReadKeySeparate,true);
  assert.doesNotMatch(result.stdout,new RegExp(mainKey));
  assert.doesNotMatch(result.stdout,new RegExp(readKey));
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
  assert.equal(output.summary.discordEnabled, false);
  assert.equal(output.summary.databaseConfigured, false);
  assert.equal(output.poolMax, 5);

  const serialized = JSON.stringify(output.summary);
  assert.doesNotMatch(serialized, /7Qv9|encryptionSecret/);
});

test('accepts each explicit runtime mode when its policy is satisfied', () => {
  assert.equal(probeConfig({ NODE_ENV: 'test' }).status, 0);

  const production = probeConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app:strong-value@pooler.example.com:6543/ghostmint',
    DATABASE_URL_UNPOOLED: 'postgresql://migrator:strong-value@db.example.com:5432/ghostmint',
    ENCRYPTION_SECRET: 'production-key-7Qv9!m2Lx4Rk8Zp3Cw6N5Hs8Df1Aa4Bb9Cc!',
  });
  assert.equal(production.status, 0, production.stderr);
});

test('refuses to start when any required setting is missing', () => {
  for (const name of ['NODE_ENV', 'SUPPORTED_CHAINS', 'ENCRYPTION_SECRET']) {
    const result = probeConfig({ [name]: '' });
    assert.notEqual(result.status, 0, `${name} should be required`);
    assert.match(result.stderr, new RegExp(`${name} is required`));
  }
});

test('requires both database URLs in production and validates their protocols', () => {
  const base = {
    NODE_ENV: 'production',
    ENCRYPTION_SECRET: 'production-key-7Qv9!m2Lx4Rk8Zp3Cw6N5Hs8Df1Aa4Bb9Cc!',
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

test('refuses known default and weak encryption secrets without echoing them', () => {
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

test('accepts ordered RPC fallback lists and reports only endpoint counts', () => {
  const first = 'https://first-rpc.example.com';
  const second = 'https://second-rpc.example.com';
  const result = probeConfig({ ETH_RPC_URLS: `${first},${second}` });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  assert.equal(summary.rpcEndpointCounts.ethereum, 2);
  assert.doesNotMatch(result.stdout, /first-rpc|second-rpc/);
});

test('Round 15: an unconfigured {CHAIN}_FAST_URLS reports no fast chains at all -- the fast pool is just an alias for the general one', () => {
  const result = probeConfig();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).summary.fastRpcChainsConfigured, []);
});

test('Round 15: a configured {CHAIN}_FAST_URLS reports that chain as covered, without exposing the URL itself', () => {
  const fast = 'https://fast-rpc.example.com';
  const result = probeConfig({ ETH_RPC_FAST_URLS: fast });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  assert.deepEqual(summary.fastRpcChainsConfigured, ['ethereum']);
  assert.doesNotMatch(result.stdout, /fast-rpc/);
});

test('Round 15: a malformed {CHAIN}_FAST_URLS is refused the same way a malformed general URL is', () => {
  const result = probeConfig({ ETH_RPC_FAST_URLS: 'not-a-url' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ETH_RPC_FAST_URLS must contain valid HTTP or HTTPS URLs/);
});

test('Round 16: an unconfigured {CHAIN}_SNIPER_URLS/_SNIPER_WS reports no sniper chains at all -- same alias-by-default shape as the fast pool', () => {
  const result = probeConfig();
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  assert.deepEqual(summary.sniperRpcChainsConfigured, []);
  assert.deepEqual(summary.sniperWebSocketConfigured, []);
});

test('Round 16: a configured {CHAIN}_RPC_SNIPER_URLS reports that chain as covered, without exposing the URL itself', () => {
  const sniper = 'https://sniper-rpc.example.com';
  const result = probeConfig({ ETH_RPC_SNIPER_URLS: sniper });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  assert.deepEqual(summary.sniperRpcChainsConfigured, ['ethereum']);
  assert.deepEqual(summary.sniperWebSocketConfigured, []);
  assert.doesNotMatch(result.stdout, /sniper-rpc/);
});

test('Round 16: a configured {CHAIN}_RPC_SNIPER_WS reports that chain\'s WebSocket as covered independently of the URL list', () => {
  const ws = 'wss://sniper-ws.example.com';
  const result = probeConfig({ ETH_RPC_SNIPER_WS: ws });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  assert.deepEqual(summary.sniperRpcChainsConfigured, []);
  assert.deepEqual(summary.sniperWebSocketConfigured, ['ethereum']);
  assert.doesNotMatch(result.stdout, /sniper-ws/);
});

test('Round 16: sniper and fast pools are independent -- configuring one does not affect the other', () => {
  const result = probeConfig({ ETH_RPC_FAST_URLS: 'https://fast-rpc.example.com', ETH_RPC_SNIPER_URLS: 'https://sniper-rpc.example.com' });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  assert.deepEqual(summary.fastRpcChainsConfigured, ['ethereum']);
  assert.deepEqual(summary.sniperRpcChainsConfigured, ['ethereum']);
});

test('Round 16: a malformed {CHAIN}_RPC_SNIPER_URLS or _SNIPER_WS is refused the same way as the fast pool', () => {
  const badUrl = probeConfig({ ETH_RPC_SNIPER_URLS: 'not-a-url' });
  assert.notEqual(badUrl.status, 0);
  assert.match(badUrl.stderr, /ETH_RPC_SNIPER_URLS must contain valid HTTP or HTTPS URLs/);

  const badWs = probeConfig({ ETH_RPC_SNIPER_WS: 'https://not-a-ws-url.example.com' });
  assert.notEqual(badWs.status, 0);
  assert.match(badWs.stderr, /ETH_RPC_SNIPER_WS must be a WS or WSS URL without embedded credentials/);
});

test('refuses unsupported and duplicate chain names', () => {
  const unsupported = probeConfig({ SUPPORTED_CHAINS: 'ethereum,solana' });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /unsupported names: solana/);

  const duplicate = probeConfig({ SUPPORTED_CHAINS: 'ethereum,base,base' });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /must not contain duplicates/);
});

test('accepts a Telegram bot token without a shared chat destination', () => {
  const result = probeConfig({ TELEGRAM_BOT_TOKEN: '123456:bot-token' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.telegramEnabled, true);
});

test('accepts a complete Discord configuration and never exposes its token', () => {
  const token = 'discord-super-secret-token';
  const result = probeConfig({ DISCORD_BOT_TOKEN: token, DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_DEV_GUILD_ID: '223456789012345678' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.discordEnabled, true);
  assert.doesNotMatch(result.stdout, new RegExp(token));
});

// DISCORD_DEV_GUILD_ID is what makes it a *development* bot (one guild for registration and the
// same guild as a hard restriction); a normal bot serving every server it is in leaves it empty.
test('accepts a Discord configuration with no dev guild, which is the serve-every-server case', () => {
  const result = probeConfig({ DISCORD_BOT_TOKEN: 'discord-token', DISCORD_APPLICATION_ID: '123456789012345678' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.discordEnabled, true);
});

test('rejects partial or malformed Discord configuration', () => {
  const partial = probeConfig({ DISCORD_BOT_TOKEN: 'token-only' });
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /must be configured together/);
  const malformed = probeConfig({ DISCORD_BOT_TOKEN: 'token', DISCORD_APPLICATION_ID: 'not-a-snowflake',
    DISCORD_DEV_GUILD_ID: '223456789012345678' });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /valid Discord snowflake/);
});

// Real Discord snowflakes are digit strings -- this is the case a broken `\d` escape (matching the
// literal letter "d" instead of a digit) would silently fail on every real value.
test('accepts a real-shaped DISCORD_CHANNEL_IDS snowflake list, comma-separated and independent of a dev guild', () => {
  const result = probeConfig({ DISCORD_BOT_TOKEN: 'discord-token', DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_CHANNEL_IDS: '111111111111111111,222222222222222222' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.discordEnabled, true);
});

test('rejects a malformed DISCORD_CHANNEL_IDS entry and requires the bot token/application ID', () => {
  const malformed = probeConfig({ DISCORD_BOT_TOKEN: 'token', DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_CHANNEL_IDS: 'not-a-snowflake' });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /DISCORD_CHANNEL_IDS must be a comma-separated list of Discord snowflakes/);

  const orphaned = probeConfig({ DISCORD_CHANNEL_IDS: '111111111111111111' });
  assert.notEqual(orphaned.status, 0);
  assert.match(orphaned.stderr, /DISCORD_CHANNEL_IDS requires DISCORD_BOT_TOKEN/);
});

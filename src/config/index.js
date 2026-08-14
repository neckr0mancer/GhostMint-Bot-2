const path = require('node:path');
const { URL } = require('node:url');
const dotenv = require('dotenv');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ENVIRONMENTS = new Set(['development', 'test', 'production']);
const WEAK_SECRET_PATTERN = /ghostmint|change[_-]?me|replace|password|default|example|secret123/i;

const CHAIN_DEFINITIONS = Object.freeze({
  ethereum: Object.freeze({
    name: 'Ethereum',
    chainId: 1,
    envName: 'ETH_RPC',
    defaultRpc: 'https://ethereum.publicnode.com',
    sym: 'ETH',
    ex: 'https://etherscan.io/tx/',
    isTestnet: false,
  }),
  base: Object.freeze({
    name: 'Base',
    chainId: 8453,
    envName: 'BASE_RPC',
    defaultRpc: 'https://mainnet.base.org',
    sym: 'ETH',
    ex: 'https://basescan.org/tx/',
    isTestnet: false,
  }),
  arbitrum: Object.freeze({
    name: 'Arbitrum',
    chainId: 42161,
    envName: 'ARB_RPC',
    defaultRpc: 'https://arb1.arbitrum.io/rpc',
    sym: 'ETH',
    ex: 'https://arbiscan.io/tx/',
    isTestnet: false,
  }),
  polygon: Object.freeze({
    name: 'Polygon',
    chainId: 137,
    envName: 'POLYGON_RPC',
    defaultRpc: 'https://polygon-rpc.com',
    sym: 'MATIC',
    ex: 'https://polygonscan.com/tx/',
    isTestnet: false,
  }),
  sepolia: Object.freeze({
    name: 'Sepolia',
    chainId: 11155111,
    envName: 'SEPOLIA_RPC',
    defaultRpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    sym: 'ETH',
    ex: 'https://sepolia.etherscan.io/tx/',
    isTestnet: true,
  }),
});

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

function requiredString(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError(`${name} is required`);
  }
  if (value !== value.trim()) {
    throw new ConfigurationError(`${name} must not have leading or trailing whitespace`);
  }
  return value;
}

function optionalString(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (value !== value.trim()) {
    throw new ConfigurationError(`${name} must not have leading or trailing whitespace`);
  }
  return value;
}

function parseEnvironment() {
  const environment = requiredString('NODE_ENV');
  if (!ENVIRONMENTS.has(environment)) {
    throw new ConfigurationError('NODE_ENV must be one of: development, test, production');
  }
  return environment;
}

function parsePort() {
  const raw = optionalString('PORT');
  if (raw === null) return 3000;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError('PORT must be an integer from 1 to 65535');
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new ConfigurationError('PORT must be an integer from 1 to 65535');
  return port;
}

function parseInteger(name, fallback, minimum, maximum) {
  const raw = optionalString(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${name} must be an integer from ${minimum} to ${maximum}`);
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new ConfigurationError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function validateSecret(name, value, environment, policy) {
  const minimumLength = environment === 'production' ? policy.productionLength : policy.minimumLength;
  if (value.length < minimumLength) {
    throw new ConfigurationError(`${name} must be at least ${minimumLength} characters in ${environment} mode`);
  }

  const characterClasses = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/]
    .filter(pattern => pattern.test(value)).length;
  if (characterClasses < 3) {
    throw new ConfigurationError(`${name} must contain at least three character classes`);
  }

  if (new Set(value).size < policy.minimumUniqueCharacters) {
    throw new ConfigurationError(`${name} must contain at least ${policy.minimumUniqueCharacters} unique characters`);
  }

  if (WEAK_SECRET_PATTERN.test(value)) {
    throw new ConfigurationError(`${name} contains a known default or placeholder pattern`);
  }

  return value;
}

function parsePostgresUrl(name, required) {
  const raw = required ? requiredString(name) : optionalString(name);
  if (raw === null) return null;
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new ConfigurationError(`${name} must be a valid PostgreSQL URL`); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username) {
    throw new ConfigurationError(`${name} must be a valid PostgreSQL URL`);
  }
  return raw;
}

function parseDatabaseConfig(environment) {
  const required = environment === 'production';
  const pooled = parsePostgresUrl('DATABASE_URL', required);
  const unpooled = parsePostgresUrl('DATABASE_URL_UNPOOLED', required);
  if ((pooled === null) !== (unpooled === null)) {
    throw new ConfigurationError('DATABASE_URL and DATABASE_URL_UNPOOLED must be configured together');
  }
  return { pooled, unpooled };
}

function parseEncryptionKeys(environment) {
  const activeVersion = parseInteger('ENCRYPTION_KEY_VERSION', 1, 1, 2147483647);
  const activeSecret = validateSecret('ENCRYPTION_SECRET', requiredString('ENCRYPTION_SECRET'), environment, {
    minimumLength: 32,
    productionLength: 48,
    minimumUniqueCharacters: 12,
  });
  const rawOldKeys = optionalString('ENCRYPTION_OLD_KEYS') || '{}';
  let oldKeys;
  try { oldKeys = JSON.parse(rawOldKeys); }
  catch { throw new ConfigurationError('ENCRYPTION_OLD_KEYS must be a JSON object keyed by positive integer versions'); }
  if (!oldKeys || Array.isArray(oldKeys) || typeof oldKeys !== 'object') {
    throw new ConfigurationError('ENCRYPTION_OLD_KEYS must be a JSON object keyed by positive integer versions');
  }
  const keys = { [activeVersion]: activeSecret };
  for (const [rawVersion, secret] of Object.entries(oldKeys)) {
    if (!/^[1-9]\d*$/.test(rawVersion) || Number(rawVersion) === activeVersion) {
      throw new ConfigurationError('ENCRYPTION_OLD_KEYS versions must be positive integers different from ENCRYPTION_KEY_VERSION');
    }
    if (typeof secret !== 'string') throw new ConfigurationError('ENCRYPTION_OLD_KEYS values must be strings');
    keys[Number(rawVersion)] = validateSecret(`ENCRYPTION_OLD_KEYS version ${rawVersion}`, secret, environment, {
      minimumLength: 32,
      productionLength: 48,
      minimumUniqueCharacters: 12,
    });
  }
  return { activeVersion, keys: Object.freeze(keys) };
}

function parseSupportedChains() {
  const names = requiredString('SUPPORTED_CHAINS')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);

  if (names.length === 0) throw new ConfigurationError('SUPPORTED_CHAINS must contain at least one chain');
  if (new Set(names).size !== names.length) throw new ConfigurationError('SUPPORTED_CHAINS must not contain duplicates');

  const unknown = names.filter(name => !Object.hasOwn(CHAIN_DEFINITIONS, name));
  if (unknown.length) {
    throw new ConfigurationError(`SUPPORTED_CHAINS contains unsupported names: ${unknown.join(', ')}`);
  }
  if (!names.includes('ethereum')) {
    throw new ConfigurationError('SUPPORTED_CHAINS must include ethereum while it remains the default chain');
  }

  return Object.freeze(names);
}

function parseRpcUrls(definition) {
  const listName = `${definition.envName}_URLS`;
  const configuredList = optionalString(listName);
  const legacy = optionalString(definition.envName);
  const rawUrls = configuredList
    ? configuredList.split(',').map(value => value.trim()).filter(Boolean)
    : [legacy || definition.defaultRpc];
  const sourceName = configuredList ? listName : definition.envName;
  if (rawUrls.length < 1 || rawUrls.length > 5 || new Set(rawUrls).size !== rawUrls.length) {
    throw new ConfigurationError(`${listName} must contain 1-5 unique URLs`);
  }
  const urls = rawUrls.map(raw => {
    let parsed;
    try { parsed = new URL(raw); }
    catch {
      throw new ConfigurationError(configuredList
        ? `${sourceName} must contain valid HTTP or HTTPS URLs`
        : `${sourceName} must be a valid HTTP or HTTPS URL`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw new ConfigurationError(configuredList
        ? `${sourceName} must contain HTTP or HTTPS URLs without embedded credentials`
        : `${sourceName} must be a valid HTTP or HTTPS URL without embedded credentials`);
    }
    return parsed.toString();
  });
  return { urls: Object.freeze(urls), overridden: configuredList !== null || legacy !== null };
}

function parseWsRpcUrl(definition) {
  const name = `${definition.envName}_WS`;
  const raw = optionalString(name);
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new ConfigurationError(`${name} must be a valid WS or WSS URL`); }
  if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new ConfigurationError(`${name} must be a WS or WSS URL without embedded credentials`);
  }
  return parsed.toString();
}

function parseTelegram() {
  return { botToken: optionalString('TELEGRAM_BOT_TOKEN') };
}

function parseDiscord() {
  const botToken = optionalString('DISCORD_BOT_TOKEN');
  const applicationId = optionalString('DISCORD_APPLICATION_ID');
  const devGuildId = optionalString('DISCORD_DEV_GUILD_ID');
  const values = [botToken, applicationId, devGuildId];
  if (values.some(Boolean) && !values.every(Boolean)) {
    throw new ConfigurationError('DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, and DISCORD_DEV_GUILD_ID must be configured together');
  }
  for (const [name, value] of [['DISCORD_APPLICATION_ID', applicationId], ['DISCORD_DEV_GUILD_ID', devGuildId]]) {
    if (value && !/^\d{17,20}$/.test(value)) throw new ConfigurationError(`${name} must be a valid Discord snowflake`);
  }
  return { botToken, applicationId, devGuildId };
}

function parseSocialAdapters() {
  return {
    officialApiEndpoint: optionalString('SOCIAL_OFFICIAL_API_URL'),
    officialApiToken: optionalString('SOCIAL_OFFICIAL_API_TOKEN'),
    managedServiceEndpoint: optionalString('SOCIAL_MANAGED_SERVICE_URL'),
    managedServiceToken: optionalString('SOCIAL_MANAGED_SERVICE_TOKEN'),
  };
}

const environment = parseEnvironment();
const supportedChains = parseSupportedChains();
const telegram = parseTelegram();
const discord = parseDiscord();
const socialAdapters = parseSocialAdapters();
const etherscanApiKey = optionalString('ETHERSCAN_API_KEY');
const database = parseDatabaseConfig(environment);
const encryption = parseEncryptionKeys(environment);
const rpcOverrides = {};
const CHAINS = {};

for (const chainName of supportedChains) {
  const definition = CHAIN_DEFINITIONS[chainName];
  const rpc = parseRpcUrls(definition);
  rpcOverrides[chainName] = rpc.overridden;
  CHAINS[chainName] = Object.freeze({
    name: definition.name,
    chainId: definition.chainId,
    rpc: rpc.urls[0],
    rpcUrls: rpc.urls,
    rpcWsUrl: parseWsRpcUrl(definition),
    sym: definition.sym,
    ex: definition.ex,
    isTestnet: definition.isTestnet,
  });
}

const CONFIG = Object.freeze({
  environment,
  isDevelopment: environment === 'development',
  isTest: environment === 'test',
  isProduction: environment === 'production',
  port: parsePort(),
  botToken: telegram.botToken,
  discordBotToken: discord.botToken,
  discordApplicationId: discord.applicationId,
  discordDevGuildId: discord.devGuildId,
  socialOfficialApiUrl: socialAdapters.officialApiEndpoint,
  socialOfficialApiToken: socialAdapters.officialApiToken,
  socialManagedServiceUrl: socialAdapters.managedServiceEndpoint,
  socialManagedServiceToken: socialAdapters.managedServiceToken,
  etherscanApiKey,
  socialPollIntervalMs: parseInteger('SOCIAL_POLL_INTERVAL_MS', 30_000, 5_000, 3_600_000),
  socialPricing: Object.freeze({ officialReadUsd:0.005, officialPostUsd:0.015,
    managedMonthlyTiersUsd:Object.freeze([199, 499]) }),
  encryptionKeyVersion: encryption.activeVersion,
  encryptionKeys: encryption.keys,
  databaseUrl: database.pooled,
  databaseUrlUnpooled: database.unpooled,
  databasePoolMax: parseInteger('DATABASE_POOL_MAX', 5, 1, 10),
  rpcTimeoutMs: parseInteger('RPC_TIMEOUT_MS', 10_000, 1_000, 60_000),
  rpcRetries: parseInteger('RPC_RETRIES', 1, 0, 5),
  projectRoot: PROJECT_ROOT,
  supportedChains,
});

Object.freeze(CHAINS);
Object.freeze(rpcOverrides);

function getSafeConfigSummary() {
  return {
    environment: CONFIG.environment,
    port: CONFIG.port,
    supportedChains: [...CONFIG.supportedChains],
    telegramEnabled: CONFIG.botToken !== null,
    discordEnabled: CONFIG.discordBotToken !== null,
    socialOfficialApiConfigured: CONFIG.socialOfficialApiUrl !== null && CONFIG.socialOfficialApiToken !== null,
    socialManagedServiceConfigured: CONFIG.socialManagedServiceUrl !== null && CONFIG.socialManagedServiceToken !== null,
    socialScraperAvailable: true,
    etherscanGasConfigured: CONFIG.etherscanApiKey !== null,
    databaseConfigured: CONFIG.databaseUrl !== null,
    migrationConnectionConfigured: CONFIG.databaseUrlUnpooled !== null,
    databasePoolMax: CONFIG.databasePoolMax,
    activeEncryptionKeyVersion: CONFIG.encryptionKeyVersion,
    availableEncryptionKeyVersions: Object.keys(CONFIG.encryptionKeys).map(Number).sort((a, b) => a - b),
    rpcOverrides: { ...rpcOverrides },
    rpcEndpointCounts: Object.fromEntries(Object.entries(CHAINS).map(([name, chain]) => [name, chain.rpcUrls.length])),
    rpcWebSocketConfigured: Object.fromEntries(Object.entries(CHAINS).map(([name, chain]) => [name, chain.rpcWsUrl !== null])),
  };
}

module.exports = {
  CHAINS,
  CONFIG,
  ConfigurationError,
  getSafeConfigSummary,
};

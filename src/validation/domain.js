const { isAddress, Interface, Wallet } = require('ethers');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FUNCTION_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WALLET_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const DASHBOARD_THEMES = new Set(['ghost-mint', 'clean-vault', 'neon-arcade', 'quiet-ledger']);
const WATCH_RULE_TYPES = new Set(['twitter_account', 'twitter_keyword', 'discord_channel', 'discord_keyword']);
const WATCH_METHODS = new Set(['official_api', 'managed_service', 'scraper']);
const MAX_SCHEDULE_AHEAD_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const LIMITS = Object.freeze({
  quantity: 100,
  priceEth: 1_000,
  gasLimit: 30_000_000,
  feeGwei: 100_000,
  sniperValueEth: 1_000,
  sniperGasBoostPercent: 500,
  sniperCooldownMs: 86_400_000,
  sniperMaxAttempts: 20,
  pnlAmount: 1_000_000_000_000,
  batchWallets: 100,
});

class ValidationError extends Error {
  constructor(issues) {
    super('Request validation failed');
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
    this.issues = Array.isArray(issues) ? issues : [issues];
  }
}

function issue(field, message) { return { field, message }; }
function fail(field, message) { throw new ValidationError(issue(field, message)); }

function string(value, field, { min = 1, max = 255 } = {}) {
  if (typeof value !== 'string') fail(field, 'must be a string');
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) fail(field, `must contain ${min}-${max} characters`);
  return normalized;
}

function finiteNumber(value, field, { min = 0, max, integer = false, required = true } = {}) {
  if (!required && (value === undefined || value === null || value === '')) return null;
  if (typeof value === 'boolean') fail(field, 'must be a number');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) fail(field, 'must be a finite number');
  if (integer && !Number.isInteger(parsed)) fail(field, 'must be an integer');
  if (parsed < min || (max !== undefined && parsed > max)) {
    fail(field, `must be between ${min} and ${max}`);
  }
  return parsed;
}

function uuid(value, field = 'id') {
  const normalized = string(value, field, { max: 36 });
  if (!UUID_PATTERN.test(normalized)) fail(field, 'must be a valid UUID');
  return normalized.toLowerCase();
}

function ethereumAddress(value, field) {
  const normalized = string(value, field, { max: 42 });
  if (!isAddress(normalized)) fail(field, 'must be a valid Ethereum address');
  return normalized;
}

function addressList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) fail(field, 'must be an array with at most 100 Ethereum addresses');
  const addresses = value.map((item, index) => ethereumAddress(item, `${field}[${index}]`));
  if (new Set(addresses.map(item => item.toLowerCase())).size !== addresses.length) fail(field, 'must not contain duplicates');
  return addresses;
}

function chainName(value, supportedChains, field = 'chain') {
  const normalized = string(value, field, { max: 32 }).toLowerCase();
  if (!supportedChains.includes(normalized)) fail(field, `must be one of: ${supportedChains.join(', ')}`);
  return normalized;
}

function dashboardTheme(value, field = 'theme') {
  const normalized = string(value, field, { max: 32 }).toLowerCase();
  if (!DASHBOARD_THEMES.has(normalized)) fail(field, `must be one of: ${[...DASHBOARD_THEMES].join(', ')}`);
  return normalized;
}

function walletLabel(value, field = 'walletLabel') {
  const normalized = string(value, field, { max: 48 });
  if (!WALLET_LABEL_PATTERN.test(normalized)) {
    fail(field, 'must start with a letter or digit and contain only letters, digits, spaces, periods, underscores, or hyphens');
  }
  return normalized;
}

function uniqueWalletLabel(value, existingLabels = []) {
  const normalized = walletLabel(value, 'label');
  if (existingLabels.some(label => String(label).toLowerCase() === normalized.toLowerCase())) {
    fail('label', 'is already used by one of your wallets');
  }
  return normalized;
}

function functionName(value = 'mint', field = 'functionName') {
  const normalized = string(value, field, { max: 128 });
  if (!FUNCTION_NAME_PATTERN.test(normalized)) fail(field, 'must be a valid Solidity function name');
  return normalized;
}

function abiDefinition(value, requestedFunction = null) {
  if (value === undefined || value === null || value === '') return null;
  let definition = value;
  if (typeof value === 'string') {
    if (value.length > 100_000) fail('abi', 'is too large');
    try { definition = JSON.parse(value); }
    catch { fail('abi', 'must be valid JSON'); }
  }
  if (!Array.isArray(definition) || definition.length === 0 || definition.length > 100) {
    fail('abi', 'must be a non-empty array with at most 100 entries');
  }
  let parsed;
  try { parsed = new Interface(definition); }
  catch { fail('abi', 'must be a valid Ethereum ABI'); }
  if (requestedFunction) {
    try {
      if (!parsed.getFunction(requestedFunction)) fail('abi', `must define function ${requestedFunction}`);
    }
    catch { fail('abi', `must define function ${requestedFunction}`); }
  }
  return definition;
}

function scheduleTimestamp(value, { now = Date.now(), maxAheadMs = MAX_SCHEDULE_AHEAD_MS } = {}) {
  if (typeof value === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) {
    fail('mintTime', 'must include an explicit UTC offset or Z suffix');
  }
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) fail('mintTime', 'must be a valid date and time');
  if (timestamp <= now) fail('mintTime', 'must be in the future');
  if (timestamp - now > maxAheadMs) {
    fail('mintTime', `must be no more than ${Math.floor(maxAheadMs / 31_536_000_000)} years in the future`);
  }
  return timestamp;
}

function quantity(value) { return finiteNumber(value ?? 1, 'quantity', { min: 1, max: LIMITS.quantity, integer: true }); }
function price(value) { return finiteNumber(value ?? 0, 'priceETH', { min: 0, max: LIMITS.priceEth }); }
function gasLimit(value) { return finiteNumber(value, 'gasLimit', { min: 21_000, max: LIMITS.gasLimit, integer: true, required: false }); }
function fee(value, field) { return finiteNumber(value, field, { min: 0, max: LIMITS.feeGwei, required: false }); }

function optionalBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') fail(field, 'must be a boolean');
  return value;
}

function optionalWei(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean' || !/^[0-9]+$/.test(String(value))) fail(field, 'must be a non-negative integer amount in wei');
  const parsed = BigInt(value);
  if (parsed > 10n ** 78n - 1n) fail(field, 'is too large');
  return parsed;
}

function validateTransactionPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('settings', 'must be an object');
  return {
    simulationEnabled: optionalBoolean(input.simulationEnabled, 'simulationEnabled'),
    gasCeilingGwei: fee(input.gasCeilingGwei, 'gasCeilingGwei'),
    maxTransactionValueWei: optionalWei(input.maxTransactionValueWei, 'maxTransactionValueWei'),
    dailySpendingBudgetWei: optionalWei(input.dailySpendingBudgetWei, 'dailySpendingBudgetWei'),
    requiredConfirmations: finiteNumber(input.requiredConfirmations, 'requiredConfirmations', { min: 1, max: 1000, integer: true, required: false }),
    transactionTimeoutMs: finiteNumber(input.transactionTimeoutMs, 'transactionTimeoutMs', { min: 1000, max: 86_400_000, integer: true, required: false }),
  };
}

function validateWalletCreate(input, context) {
  const importMethod = input.importMethod === 'seedPhrase' ? 'seedPhrase' : 'privateKey';
  let privateKey;
  let address;
  if (importMethod === 'seedPhrase') {
    try {
      const phrase = string(input.seedPhrase, 'seedPhrase', { max: 500 });
      const derived = Wallet.fromPhrase(phrase);
      privateKey = derived.privateKey;
      address = derived.address;
    }
    catch { fail('seedPhrase', 'must be a valid BIP-39 recovery phrase'); }
  } else {
    try {
      privateKey = string(input.privateKey, 'privateKey', { max: 66 });
      address = new Wallet(privateKey).address;
    }
    catch { fail('privateKey', 'must be a valid Ethereum private key'); }
  }
  return {
    privateKey,
    label: uniqueWalletLabel(input.label, context.existingLabels),
    chain: chainName(input.chain, context.supportedChains),
    address,
  };
}

function validateMintRequest(input, context) {
  const fn = functionName(input.functionName ?? input.fn ?? 'mint');
  if (fn !== 'mint') fail('functionName', 'must be mint; custom function names are not supported');
  if (input.abi !== undefined && input.abi !== null && input.abi !== '') {
    fail('abi', 'custom ABI input is not supported; choose a built-in mint signature');
  }
  return {
    walletLabel: walletLabel(input.walletLabel),
    contractAddress: ethereumAddress(input.contractAddress ?? input.contract, 'contractAddress'),
    functionName: fn,
    abi: null,
    quantity: quantity(input.quantity ?? input.qty),
    priceETH: price(input.priceETH ?? input.price),
    gasLimit: gasLimit(input.gasLimit),
    gasGwei: fee(input.gasGwei ?? input.gas, 'gasGwei'),
    maxFeePerGasGwei: fee(input.maxFeePerGasGwei, 'maxFeePerGasGwei'),
    maxPriorityFeePerGasGwei: fee(input.maxPriorityFeePerGasGwei, 'maxPriorityFeePerGasGwei'),
    chain: chainName(input.chain, context.supportedChains),
  };
}

function validateTaskCreate(input, context) {
  return {
    id: input.id === undefined ? randomUUID() : uuid(input.id, 'id'),
    name: string(input.name, 'name', { max: 100 }),
    ...validateMintRequest(input, context),
    mintTime: scheduleTimestamp(input.mintTime, context),
  };
}

function validateBatchMint(input, context) {
  if (!Array.isArray(input.walletLabels) || input.walletLabels.length < 1 || input.walletLabels.length > LIMITS.batchWallets) {
    fail('walletLabels', `must contain 1-${LIMITS.batchWallets} wallet labels`);
  }
  const labels = input.walletLabels.map(label => walletLabel(label));
  if (new Set(labels.map(label => label.toLowerCase())).size !== labels.length) fail('walletLabels', 'must not contain duplicates');
  return { ...validateMintRequest({ ...input, walletLabel: labels[0] }, context), walletLabels: labels };
}

function validateSniper(input, context) {
  const valueMode = input.valueMode === undefined ? 'copy' : string(input.valueMode, 'valueMode', { max: 5 }).toLowerCase();
  if (!['copy', 'fixed'].includes(valueMode)) fail('valueMode', 'must be copy or fixed');
  const contractAllowlist = addressList(input.contractAllowlist, 'contractAllowlist');
  const contractDenylist = addressList(input.contractDenylist, 'contractDenylist');
  const denied = new Set(contractDenylist.map(item => item.toLowerCase()));
  if (contractAllowlist.some(item => denied.has(item.toLowerCase()))) fail('contractAllowlist', 'must not overlap the denylist');
  return {
    id: input.id === undefined ? randomUUID() : uuid(input.id, 'id'),
    label: string(input.label, 'label', { max: 100 }),
    targetAddress: ethereumAddress(input.targetAddress, 'targetAddress'),
    chain: chainName(input.chain, context.supportedChains),
    walletLabel: walletLabel(input.walletLabel),
    valueMode,
    fixedValueETH: finiteNumber(input.fixedValueETH ?? 0, 'fixedValueETH', { min: 0, max: LIMITS.sniperValueEth }),
    maxValueETH: finiteNumber(input.maxValueETH ?? 0.1, 'maxValueETH', { min: 0, max: LIMITS.sniperValueEth }),
    gasBoostPercent: finiteNumber(input.gasBoostPercent ?? 20, 'gasBoostPercent', { min: 0, max: LIMITS.sniperGasBoostPercent, integer: true }),
    maxGasGwei: fee(input.maxGasGwei ?? 200, 'maxGasGwei'),
    dailySpendingCapETH: finiteNumber(input.dailySpendingCapETH ?? 0.25, 'dailySpendingCapETH', { min: 0, max: LIMITS.sniperValueEth }),
    cooldownMs: finiteNumber(input.cooldownMs ?? 60_000, 'cooldownMs', { min: 0, max: LIMITS.sniperCooldownMs, integer: true }),
    maxAttempts: finiteNumber(input.maxAttempts ?? 3, 'maxAttempts', { min: 1, max: LIMITS.sniperMaxAttempts, integer: true }),
    contractAllowlist,
    contractDenylist,
    sourceConfirmations: finiteNumber(input.sourceConfirmations ?? 2, 'sourceConfirmations', { min: 1, max: 1000, integer: true }),
  };
}

function validatePnlRecord(input) {
  const cost = finiteNumber(input.cost ?? 0, 'cost', { min: 0, max: LIMITS.pnlAmount });
  const sale = finiteNumber(input.sale ?? 0, 'sale', { min: 0, max: LIMITS.pnlAmount });
  const gas = finiteNumber(input.gas ?? 0, 'gas', { min: 0, max: LIMITS.pnlAmount });
  return { name: string(input.name, 'name', { max: 100 }), cost, sale, gas, net: sale - cost - gas };
}

function watchRuleConfig(type, method, value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('config', 'must be an object');
  const forbidden = Object.keys(value).find(key => /token|secret|password|authorization|api[_-]?key/i.test(key));
  if (forbidden) fail(`config.${forbidden}`, 'must not contain credentials; configure adapter credentials through environment variables');
  const keywords = value.keywords === undefined ? [] : value.keywords;
  if (!Array.isArray(keywords) || keywords.length > 25) fail('config.keywords', 'must be an array with at most 25 entries');
  const normalizedKeywords = keywords.map((item, index) => string(item, `config.keywords[${index}]`, { max: 100 }).toLowerCase());
  const config = { keywords: [...new Set(normalizedKeywords)] };
  if (type === 'twitter_account') config.handle = string(value.handle, 'config.handle', { max: 50 }).replace(/^@/, '');
  if (type === 'discord_channel') config.channelId = string(value.channelId, 'config.channelId', { max: 20 });
  if (type === 'twitter_keyword' || type === 'discord_keyword') {
    if (!config.keywords.length) fail('config.keywords', 'must contain at least one keyword');
  }
  if (type === 'discord_keyword' && value.channelIds !== undefined) {
    if (!Array.isArray(value.channelIds) || value.channelIds.length > 25) fail('config.channelIds', 'must be an array with at most 25 Discord channel IDs');
    config.channelIds = value.channelIds.map((item, index) => string(item, `config.channelIds[${index}]`, { max: 20 }));
  }
  if (method === 'scraper') {
    const raw = string(value.sourceUrl, 'config.sourceUrl', { max: 2048 });
    let parsed;
    try { parsed = new URL(raw); } catch { fail('config.sourceUrl', 'must be a valid HTTP or HTTPS URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      fail('config.sourceUrl', 'must be an HTTP or HTTPS URL without embedded credentials');
    }
    config.sourceUrl = parsed.toString();
  }
  return config;
}

function validateWatchRule(input, { partial = false } = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object') fail('watchRule', 'must be an object');
  const type = input.type === undefined && partial ? null : string(input.type, 'type', { max: 32 }).toLowerCase();
  const method = input.method === undefined && partial ? null : string(input.method, 'method', { max: 32 }).toLowerCase();
  if (type !== null && !WATCH_RULE_TYPES.has(type)) fail('type', `must be one of: ${[...WATCH_RULE_TYPES].join(', ')}`);
  if (method !== null && !WATCH_METHODS.has(method)) fail('method', `must be one of: ${[...WATCH_METHODS].join(', ')}`);
  if (partial) return { name: input.name === undefined ? null : string(input.name, 'name', { max: 100 }),
    type, method, config: input.config === undefined ? null : input.config,
    enabled: input.enabled === undefined ? null : optionalBoolean(input.enabled, 'enabled') };
  return { name: string(input.name, 'name', { max: 100 }), type, method,
    config: watchRuleConfig(type, method, input.config), enabled: input.enabled === undefined ? true : optionalBoolean(input.enabled, 'enabled') };
}

const requestSchemas = Object.freeze({
  noArguments: input => {
    if (input && Object.keys(input).length) fail('command', 'does not accept arguments');
    return {};
  },
  taskDeletion: input => ({ id: uuid(input.id, 'id') }),
  sniperDeletion: input => ({ id: uuid(input.id, 'id') }),
  pnlDeletion: input => ({ id: uuid(input.id, 'id') }),
  walletDeletion: input => ({ label: walletLabel(input.label, 'label') }),
  walletCreate: validateWalletCreate,
  mint: validateMintRequest,
  batchMint: validateBatchMint,
  taskCreate: validateTaskCreate,
  sniperCreate: validateSniper,
  pnlCreate: validatePnlRecord,
  transactionPolicy: validateTransactionPolicy,
  watchRuleCreate: input => validateWatchRule(input),
  watchRulePatch: input => validateWatchRule(input, { partial: true }),
  watchRuleDeletion: input => ({ id: uuid(input.id, 'id') }),
  themeUpdate: input => ({ theme: dashboardTheme(input.theme) }),
});

function validationPayload(error) {
  if (!(error instanceof ValidationError)) throw error;
  return { error: 'Validation failed', code: error.code, issues: error.issues };
}

function validationReply(error) {
  const payload = validationPayload(error);
  return `❌ ${payload.error}: ${payload.issues.map(item => `${item.field} ${item.message}`).join('; ')}`;
}

function sendValidationError(response, error) {
  return response.status(400).json(validationPayload(error));
}

module.exports = {
  LIMITS,
  MAX_SCHEDULE_AHEAD_MS,
  ValidationError,
  dashboardTheme,
  requestSchemas,
  sendValidationError,
  validationPayload,
  validationReply,
};

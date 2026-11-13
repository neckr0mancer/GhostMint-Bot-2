'use strict';

// Deliberately read-only. This runner imports neither server/config nor database modules, so it
// cannot start workers, migrate data, or broadcast a transaction. It is a semantic activation
// gate, not a reachability probe: every capability must be proven on every configured chain.

const fs = require('node:fs');
const path = require('node:path');
const {
  CAPABILITY_NAMES,
  REQUIRED_CHAINS,
  runGoldRushCanary,
  validateManifest,
} = require('../src/walletHistory/goldRushCanary');
const {
  GOLDRUSH_INTERNAL_TRANSFER_CHAINS,
  createGoldRushWalletHistoryAdapter,
} = require('../src/walletHistory/goldRushAdapter');

const CONFIRM_VALUE = 'RUN READ-ONLY GOLDRUSH CANARY';
const CONFIRM_KEY = 'GOLDRUSH_HISTORY_CANARY_CONFIRM';
const MANIFEST_FILE_KEY = 'GOLDRUSH_HISTORY_CANARY_MANIFEST_FILE';
const PREFLIGHT_ARGUMENT = '--preflight';
const CANARY_MAX_PAGES = 8;

const CAPABILITY_PREFLIGHT_BLOCKERS = Object.freeze([
  Object.freeze({
    source:'provider-contract',
    capability:'completeness',
    code:'PAGINATED_COMPLETENESS_NOT_MACHINE_VERIFIABLE',
    chains:Object.freeze([...REQUIRED_CHAINS]),
    detail:'GoldRush paginated wallet history exposes page exhaustion, not a complete indexed-history boundary.',
  }),
  Object.freeze({
    source:'provider-contract',
    capability:'reorg',
    code:'PAGINATED_REORG_NOT_MACHINE_VERIFIABLE',
    chains:Object.freeze([...REQUIRED_CHAINS]),
    detail:'GoldRush paginated wallet history exposes no machine-verifiable recheck or reorg range.',
  }),
  Object.freeze({
    source:'provider-contract',
    capability:'internalTransfer',
    code:'TRACES_UNAVAILABLE',
    chains:Object.freeze(REQUIRED_CHAINS.filter(chain =>
      !GOLDRUSH_INTERNAL_TRANSFER_CHAINS.has(chain))),
    detail:'GoldRush does not document trace-backed internal transfers for Ink or HyperEVM.',
  }),
  Object.freeze({
    source:'canary-wiring',
    capability:'finality',
    code:'FINALITY_VERIFIER_NOT_CONFIGURED',
    chains:Object.freeze([...REQUIRED_CHAINS]),
    detail:'The standalone canary adapter has no independent RPC finality verifier.',
  }),
]);

class GoldRushCanarySetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoldRushCanarySetupError';
    this.code = code;
  }
}

function setupError(code, message) {
  throw new GoldRushCanarySetupError(code, message);
}

function readManifest(env = process.env, readFile = fs.readFileSync) {
  const configuredPath = String(env[MANIFEST_FILE_KEY] || '').trim();
  if (!configuredPath) {
    setupError('FIXTURE_MANIFEST_NOT_CONFIGURED',
      `${MANIFEST_FILE_KEY} must point to the reviewed public-fixture manifest.`);
  }
  const absolutePath = path.resolve(configuredPath);
  let raw;
  try { raw = readFile(absolutePath, 'utf8'); }
  catch { setupError('FIXTURE_MANIFEST_UNREADABLE',
    'The reviewed public-fixture manifest could not be read.'); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { setupError('FIXTURE_MANIFEST_INVALID_JSON',
    'The reviewed public-fixture manifest is not valid JSON.'); }
  try { return validateManifest(parsed, { maxPages:CANARY_MAX_PAGES }); }
  catch (error) {
    if (error?.code === 'CANARY_MANIFEST_INVALID' || error?.code === 'CANARY_LIMIT_INVALID') {
      setupError('FIXTURE_MANIFEST_SCHEMA_INVALID',
        'The reviewed public-fixture manifest failed canary schema validation.');
    }
    throw error;
  }
}

function validateEnvironment(env = process.env) {
  if (String(env[CONFIRM_KEY] || '') !== CONFIRM_VALUE) {
    setupError('READ_ONLY_CONFIRMATION_REQUIRED',
      `${CONFIRM_KEY} must equal ${CONFIRM_VALUE}.`);
  }
  if (typeof env.GOLDRUSH_API_KEY !== 'string' || !env.GOLDRUSH_API_KEY.trim()) {
    setupError('API_KEY_NOT_CONFIGURED', 'GOLDRUSH_API_KEY is not configured.');
  }
  return { apiKey:env.GOLDRUSH_API_KEY.trim(), manifest:readManifest(env) };
}

function printCapabilityPreflight(write = line => process.stdout.write(`${line}\n`),
  { setupChecked = false, liveScanWillRun = false } = {}) {
  write(setupChecked
    ? 'Setup preflight: PASS (confirmation, API key, and fixture manifest are present).'
    : 'Setup preflight: NOT RUN (no confirmation, credential, manifest, or network access was requested).');
  write('Capability preflight: BLOCKED (known provider-contract and canary-wiring gaps follow).');
  for (const blocker of CAPABILITY_PREFLIGHT_BLOCKERS) {
    write([
      'CAPABILITY_BLOCKED',
      `source=${blocker.source}`,
      `capability=${blocker.capability}`,
      `code=${blocker.code}`,
      `chains=${blocker.chains.join(',')}`,
      blocker.detail,
    ].join('\t'));
  }
  write(liveScanWillRun
    ? 'The live read-only evidence scan will run, but it cannot produce READY until these gaps are resolved.'
    : 'No live evidence scan was run. Keep production wallet-history ingestion disabled until these gaps are resolved.');
}

function formatBlockedError(error) {
  if (error instanceof GoldRushCanarySetupError) {
    return `SETUP_BLOCKED:${error.code}: ${error.message}`;
  }
  if (error?.code === 'CANARY_MANIFEST_INVALID' || error?.code === 'CANARY_LIMIT_INVALID') {
    return `SETUP_BLOCKED:${error.code}: The reviewed public-fixture manifest failed validation.`;
  }
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code : 'UNEXPECTED_ERROR';
  return `EXECUTION_BLOCKED:${code}: The canary failed before producing a safe report.`;
}

function printReport(report, write = line => process.stdout.write(`${line}\n`)) {
  write('GoldRush wallet-history semantic canary (read-only; fixture identifiers redacted)');
  write(`Chains: ${report.expectedChains.length}/${REQUIRED_CHAINS.length}`);
  write(`Limits: ${report.limits.maxPages} page(s) per chain, `
    + `GoldRush provider-fixed page size: ${report.limits.pageLimit} row(s) maximum`);
  const headings = ['chain', 'pages', 'rows', 'duplicates', ...CAPABILITY_NAMES, 'ready'];
  write(headings.join('\t'));
  for (const item of report.chains) {
    write([
      item.chain,
      item.pagesFetched,
      item.uniqueTransactions,
      item.duplicateTransactions,
      ...CAPABILITY_NAMES.map(name => item.capabilities[name].passed
        ? 'PASS' : `BLOCKED:${item.capabilities[name].code}`),
      item.ready ? 'PASS' : 'BLOCKED',
    ].join('\t'));
  }
  write(report.ready
    ? 'READY: every required semantic capability passed on every required chain.'
    : 'BLOCKED: keep production wallet-history ingestion disabled; one or more semantic capabilities are unproven.');
  write('No database or blockchain write was performed.');
}

async function main(env = process.env, { preflightOnly = false,
  write = line => process.stdout.write(`${line}\n`) } = {}) {
  if (preflightOnly) {
    printCapabilityPreflight(write);
    return Object.freeze({ exitCode:2, preflightOnly:true, report:null });
  }
  const { apiKey, manifest } = validateEnvironment(env);
  printCapabilityPreflight(write, { setupChecked:true, liveScanWillRun:true });
  const report = await runGoldRushCanary({
    apiKey,
    manifest,
    maxPages:CANARY_MAX_PAGES,
    internalTransferChains:GOLDRUSH_INTERNAL_TRANSFER_CHAINS,
    adapterFactory:options => createGoldRushWalletHistoryAdapter(options),
  });
  printReport(report, write);
  return Object.freeze({ exitCode:report.ready ? 0 : 2, preflightOnly:false, report });
}

if (require.main === module) {
  main(process.env, { preflightOnly:process.argv.slice(2).includes(PREFLIGHT_ARGUMENT) })
    .then(result => { process.exitCode = result.exitCode; })
    .catch(error => {
      process.stderr.write(`GoldRush wallet-history canary ${formatBlockedError(error)}\n`);
      process.stderr.write('No database or blockchain write was performed.\n');
      process.exitCode = 1;
    });
}

module.exports = {
  CAPABILITY_PREFLIGHT_BLOCKERS,
  CONFIRM_KEY,
  CONFIRM_VALUE,
  GoldRushCanarySetupError,
  MANIFEST_FILE_KEY,
  PREFLIGHT_ARGUMENT,
  formatBlockedError,
  main,
  printCapabilityPreflight,
  printReport,
  readManifest,
  validateEnvironment,
};

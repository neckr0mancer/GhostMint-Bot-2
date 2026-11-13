'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CAPABILITY_PREFLIGHT_BLOCKERS,
  CONFIRM_KEY,
  CONFIRM_VALUE,
  GoldRushCanarySetupError,
  MANIFEST_FILE_KEY,
  main,
  formatBlockedError,
  printCapabilityPreflight,
  printReport,
  readManifest,
  validateEnvironment,
} = require('../scripts/run-goldrush-wallet-history-canary');

test('requires the exact explicit read-only canary confirmation', () => {
  assert.throws(
    () => validateEnvironment({}),
    error => {
      assert.equal(error instanceof GoldRushCanarySetupError, true);
      assert.equal(error.code, 'READ_ONLY_CONFIRMATION_REQUIRED');
      assert.equal(error.message, `${CONFIRM_KEY} must equal ${CONFIRM_VALUE}.`);
      return true;
    },
  );

  assert.throws(
    () => validateEnvironment({ [CONFIRM_KEY]: `${CONFIRM_VALUE} ` }),
    error => {
      assert.equal(error.message, `${CONFIRM_KEY} must equal ${CONFIRM_VALUE}.`);
      return true;
    },
  );
});

test('rejects a missing API key before attempting to read a manifest', () => {
  assert.throws(
    () => validateEnvironment({
      [CONFIRM_KEY]: CONFIRM_VALUE,
      [MANIFEST_FILE_KEY]: 'should-not-be-read.json',
    }),
    error => error instanceof GoldRushCanarySetupError
      && error.code === 'API_KEY_NOT_CONFIGURED'
      && /GOLDRUSH_API_KEY is not configured/.test(error.message),
  );
});

test('rejects a missing reviewed manifest without inventing a default path', () => {
  assert.throws(
    () => validateEnvironment({
      [CONFIRM_KEY]: CONFIRM_VALUE,
      GOLDRUSH_API_KEY: 'test-key-that-must-not-appear',
    }),
    new RegExp(`${MANIFEST_FILE_KEY} must point to the reviewed public-fixture manifest`),
  );
});

test('manifest read and parse failures do not expose the configured path', () => {
  const sensitivePath = 'C:\\Users\\someone\\private-fixtures\\wallet-0x1111111111111111111111111111111111111111.json';
  const env = { [MANIFEST_FILE_KEY]: sensitivePath };

  assert.throws(
    () => readManifest(env, () => { throw new Error(`ENOENT: ${sensitivePath}`); }),
    error => {
      assert.equal(error.code, 'FIXTURE_MANIFEST_UNREADABLE');
      assert.equal(error.message, 'The reviewed public-fixture manifest could not be read.');
      assert.doesNotMatch(error.message, /private-fixtures|0x[0-9a-f]{40}/i);
      return true;
    },
  );

  assert.throws(
    () => readManifest(env, () => '{"address":"0x2222222222222222222222222222222222222222"'),
    error => {
      assert.equal(error.code, 'FIXTURE_MANIFEST_INVALID_JSON');
      assert.equal(error.message, 'The reviewed public-fixture manifest is not valid JSON.');
      assert.doesNotMatch(error.message, /private-fixtures|0x[0-9a-f]{40}/i);
      return true;
    },
  );

  assert.throws(
    () => readManifest(env, () => '{}'),
    error => {
      assert.equal(error.code, 'FIXTURE_MANIFEST_SCHEMA_INVALID');
      assert.equal(error.message,
        'The reviewed public-fixture manifest failed canary schema validation.');
      assert.doesNotMatch(error.message, /private-fixtures|0x[0-9a-f]{40}/i);
      return true;
    },
  );
});

test('setup failures are classified separately from execution and capability blockers', () => {
  let setupFailure;
  try { validateEnvironment({}); }
  catch (error) { setupFailure = error; }
  assert.equal(formatBlockedError(setupFailure),
    `SETUP_BLOCKED:READ_ONLY_CONFIRMATION_REQUIRED: ${CONFIRM_KEY} must equal ${CONFIRM_VALUE}.`);
  assert.equal(formatBlockedError(Object.assign(new Error('network failed'), {
    code:'PROVIDER_REQUEST_FAILED',
  })), 'EXECUTION_BLOCKED:PROVIDER_REQUEST_FAILED: The canary failed before producing a safe report.');
  assert.doesNotMatch(formatBlockedError(Object.assign(new Error('secret-key-value'), {
    code:'PROVIDER_REQUEST_FAILED',
  })), /secret-key-value/);
});

test('capability preflight names structural blockers without leaking setup values', () => {
  const lines = [];
  printCapabilityPreflight(line => lines.push(String(line)));

  const output = lines.join('\n');
  assert.equal(CAPABILITY_PREFLIGHT_BLOCKERS.length, 4);
  assert.match(output, /Setup preflight: NOT RUN/);
  assert.match(output,
    /source=provider-contract\tcapability=completeness\tcode=PAGINATED_COMPLETENESS_NOT_MACHINE_VERIFIABLE/);
  assert.match(output,
    /source=provider-contract\tcapability=reorg\tcode=PAGINATED_REORG_NOT_MACHINE_VERIFIABLE/);
  assert.match(output,
    /source=provider-contract\tcapability=internalTransfer\tcode=TRACES_UNAVAILABLE\tchains=ink,hyperevm/);
  assert.match(output,
    /source=canary-wiring\tcapability=finality\tcode=FINALITY_VERIFIER_NOT_CONFIGURED/);
  assert.match(output, /No live evidence scan was run/);
  assert.doesNotMatch(output, /GOLDRUSH_API_KEY|MANIFEST_FILE|0x[0-9a-f]{40,64}/i);
});

test('preflight-only mode reads no setup value and makes no provider request', async () => {
  const lines = [];
  const result = await main({
    GOLDRUSH_API_KEY:'must-not-be-read',
    [MANIFEST_FILE_KEY]:'must-not-be-read.json',
  }, { preflightOnly:true, write:line => lines.push(String(line)) });

  assert.deepEqual(result, { exitCode:2, preflightOnly:true, report:null });
  assert.match(lines.join('\n'), /no confirmation, credential, manifest, or network access was requested/i);
  assert.doesNotMatch(lines.join('\n'), /must-not-be-read/);
});

test('printReport emits only the redacted capability matrix', () => {
  const apiKey = 'goldrush-live-secret-key';
  const address = '0x3333333333333333333333333333333333333333';
  const transactionHash = `0x${'4'.repeat(64)}`;
  const lines = [];
  const capabilities = {
    pagination: { passed:true, code:'PAGINATION_PROVEN' },
    completeness: { passed:true, code:'COMPLETENESS_PROVEN' },
    finality: { passed:false, code:'FINALITY_UNPROVEN' },
    internalTransfer: { passed:false, code:'INTERNAL_TRANSFER_UNPROVEN' },
    reorg: { passed:false, code:'REORG_UNPROVEN' },
  };
  const report = {
    expectedChains:['ethereum'],
    limits:{ maxPages:3, pageLimit:100 },
    ready:false,
    apiKey,
    fixtures:{ ethereum:{ address, transactionHash } },
    chains:[{
      chain:'ethereum',
      pagesFetched:2,
      uniqueTransactions:150,
      duplicateTransactions:0,
      ready:false,
      capabilities,
      fixture:{ address, transactionHash, apiKey },
    }],
  };

  printReport(report, line => lines.push(String(line)));

  const output = lines.join('\n');
  assert.match(output, /fixture identifiers redacted/);
  assert.match(output, /ethereum\t2\t150\t0/);
  assert.match(output, /GoldRush provider-fixed page size: 100 row\(s\) maximum/);
  assert.doesNotMatch(output, /requested per page/);
  assert.match(output, /BLOCKED:FINALITY_UNPROVEN/);
  assert.match(output, /keep production wallet-history ingestion disabled/i);
  assert.match(output, /No database or blockchain write was performed/);
  assert.doesNotMatch(output, /0x[0-9a-f]{40,64}/i);
  assert.doesNotMatch(output, /goldrush-live-secret-key/);
  assert.doesNotMatch(output, /private-fixtures/i);
});

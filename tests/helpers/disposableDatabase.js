const test = require('node:test');
const { URL } = require('node:url');
const { Pool } = require('pg');
const { createDatabasePool } = require('../../src/db/pool');
const { runMigrations } = require('../../src/db/migrate');

const CONFIRM_VALUE = 'RUN_DISPOSABLE_DB_TESTS';
const MARKER_PREFIX = 'ghostmint-disposable:';
const VERIFY_TIMEOUT_MS = 10_000;
const CONFIG_KEYS = [
  'GHOSTMINT_TEST_DATABASE_URL',
  'GHOSTMINT_TEST_DATABASE_URL_UNPOOLED',
  'GHOSTMINT_TEST_DATABASE_ID',
  'GHOSTMINT_TEST_DATABASE_CONFIRM',
];

function hasValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function databaseTarget(value) {
  if (!hasValue(value)) return null;
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error('A disposable database URL is malformed.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname) {
    throw new Error('A disposable database URL is malformed.');
  }
  return `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}${parsed.pathname}`;
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function validateConfiguration(env = process.env) {
  const configured = CONFIG_KEYS.some(key => hasValue(env[key]));
  if (!configured) return { enabled: false, pooledUrl: null, unpooledUrl: null, databaseId: null };

  const missing = CONFIG_KEYS.filter(key => !hasValue(env[key]));
  if (missing.length) {
    throw new Error(`Disposable database tests are partially configured; missing ${missing.join(', ')}.`);
  }
  if (env.NODE_ENV !== 'test') {
    throw new Error('Disposable database tests require NODE_ENV=test.');
  }
  if (env.GHOSTMINT_TEST_DATABASE_CONFIRM !== CONFIRM_VALUE) {
    throw new Error(`GHOSTMINT_TEST_DATABASE_CONFIRM must equal ${CONFIRM_VALUE}.`);
  }
  const databaseId = env.GHOSTMINT_TEST_DATABASE_ID.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) {
    throw new Error('GHOSTMINT_TEST_DATABASE_ID must be a version-4 UUID.');
  }

  const pooledUrl = env.GHOSTMINT_TEST_DATABASE_URL.trim();
  const unpooledUrl = env.GHOSTMINT_TEST_DATABASE_URL_UNPOOLED.trim();
  const ordinaryTargets = [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED]
    .filter(hasValue).map(databaseTarget);
  const testTargets = [databaseTarget(pooledUrl), databaseTarget(unpooledUrl)];
  if (testTargets.some(target => ordinaryTargets.includes(target))) {
    throw new Error('Disposable database tests refuse to use the application database target.');
  }

  return { enabled: true, pooledUrl, unpooledUrl, databaseId };
}

async function readDatabaseMarker(connectionString) {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: 7_500,
    statement_timeout: 7_500,
    allowExitOnIdle: true,
  });
  try {
    let result;
    try {
      result = await withTimeout(pool.query(
        `SELECT current_database() AS database_name,
          shobj_description(oid,'pg_database') AS marker
         FROM pg_database WHERE datname=current_database()`,
      ), VERIFY_TIMEOUT_MS, 'Disposable database identity verification timed out.');
    } catch {
      throw new Error('Disposable database identity could not be verified.');
    }
    if (result.rowCount !== 1) throw new Error('Disposable database identity could not be verified.');
    return { databaseName: result.rows[0].database_name, marker: result.rows[0].marker };
  } finally {
    await withTimeout(pool.end(), 2_000, 'Disposable database connection did not close in time.')
      .catch(() => {});
  }
}

async function verifyDisposableDatabase(configuration, readMarker = readDatabaseMarker) {
  const expectedMarker = `${MARKER_PREFIX}${configuration.databaseId}`;
  // Verify both endpoints, but do it sequentially. Small disposable Railway instances may expose
  // the same public proxy for pooled and unpooled traffic and reject the second simultaneous
  // connection. Sequential reads preserve the two-endpoint identity proof without creating a
  // false failure from connection pressure.
  const pooled = await readMarker(configuration.pooledUrl);
  const unpooled = await readMarker(configuration.unpooledUrl);
  if (pooled.databaseName !== unpooled.databaseName
    || pooled.marker !== expectedMarker || unpooled.marker !== expectedMarker) {
    throw new Error('Database tests require pooled and unpooled URLs for the same marked disposable database.');
  }
  return pooled;
}

let configuration;
let configurationError = null;
try { configuration = validateConfiguration(); }
catch (error) {
  configuration = { enabled: true, pooledUrl: null, unpooledUrl: null, databaseId: null };
  configurationError = error;
}

let verificationPromise = null;
function assertDisposableDatabase() {
  if (configurationError) return Promise.reject(configurationError);
  if (!configuration.enabled) return Promise.reject(new Error('Disposable database tests are not configured.'));
  if (!verificationPromise) verificationPromise = verifyDisposableDatabase(configuration);
  return verificationPromise;
}

function integrationTest(name, options, callback) {
  if (!configuration.enabled) return test(name, { ...options, skip: true }, callback);
  return test(name, options, async context => {
    await assertDisposableDatabase();
    return callback(context);
  });
}

async function createTestDatabasePool({ max = 5 } = {}) {
  await assertDisposableDatabase();
  const pool = createDatabasePool({ connectionString: configuration.pooledUrl, max });
  pool.on('connect', client => {
    client.query("SET statement_timeout='30s'; SET lock_timeout='15s'").catch(() => {});
  });
  return pool;
}

async function runTestMigrations({ migrationsDirectory }) {
  await assertDisposableDatabase();
  return runMigrations({ connectionString: configuration.unpooledUrl, migrationsDirectory });
}

async function getVerifiedTestDatabase() {
  await assertDisposableDatabase();
  return Object.freeze({
    pooledUrl: configuration.pooledUrl,
    unpooledUrl: configuration.unpooledUrl,
  });
}

module.exports = {
  assertDisposableDatabase,
  createTestDatabasePool,
  getVerifiedTestDatabase,
  integrationTest,
  runTestMigrations,
  _internal: {
    CONFIRM_VALUE,
    MARKER_PREFIX,
    databaseTarget,
    validateConfiguration,
    verifyDisposableDatabase,
  },
};

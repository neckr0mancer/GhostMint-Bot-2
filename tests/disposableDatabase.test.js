const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { _internal } = require('./helpers/disposableDatabase');

const TEST_ID = '123e4567-e89b-42d3-a456-426614174000';

function validEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'test',
    GHOSTMINT_TEST_DATABASE_URL: 'postgresql://tester:secret@pool.test.invalid:6543/ghostmint_test',
    GHOSTMINT_TEST_DATABASE_URL_UNPOOLED: 'postgresql://tester:secret@db.test.invalid:5432/ghostmint_test',
    GHOSTMINT_TEST_DATABASE_ID: TEST_ID,
    GHOSTMINT_TEST_DATABASE_CONFIRM: _internal.CONFIRM_VALUE,
    ...overrides,
  };
}

test('ordinary application database variables cannot enable integration tests', () => {
  assert.deepEqual(_internal.validateConfiguration({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app:secret@production.invalid/app',
    DATABASE_URL_UNPOOLED: 'postgresql://app:secret@production.invalid/app',
  }), { enabled: false, pooledUrl: null, unpooledUrl: null, databaseId: null });
});

test('disposable database configuration is fail-closed and refuses the application target', () => {
  assert.throws(() => _internal.validateConfiguration(validEnvironment({
    GHOSTMINT_TEST_DATABASE_CONFIRM: '',
  })), /partially configured/);
  assert.throws(() => _internal.validateConfiguration(validEnvironment({
    NODE_ENV: 'production',
  })), /NODE_ENV=test/);
  assert.throws(() => _internal.validateConfiguration(validEnvironment({
    GHOSTMINT_TEST_DATABASE_CONFIRM: 'yes',
  })), /RUN_DISPOSABLE_DB_TESTS/);
  assert.throws(() => _internal.validateConfiguration(validEnvironment({
    GHOSTMINT_TEST_DATABASE_ID: 'not-a-uuid',
  })), /version-4 UUID/);
  const environment = validEnvironment();
  environment.DATABASE_URL = environment.GHOSTMINT_TEST_DATABASE_URL;
  assert.throws(() => _internal.validateConfiguration(environment), /refuse to use the application database/);
});

test('both endpoints must identify the same explicitly marked disposable database', async () => {
  const configuration = _internal.validateConfiguration(validEnvironment());
  const expectedMarker = `${_internal.MARKER_PREFIX}${TEST_ID}`;
  const seen = [];
  await _internal.verifyDisposableDatabase(configuration, async connectionString => {
    seen.push(connectionString);
    return { databaseName: 'ghostmint_test', marker: expectedMarker };
  });
  assert.deepEqual(seen, [configuration.pooledUrl, configuration.unpooledUrl]);

  await assert.rejects(
    _internal.verifyDisposableDatabase(configuration, async connectionString => ({
      databaseName: connectionString === configuration.pooledUrl ? 'ghostmint_test' : 'production',
      marker: expectedMarker,
    })),
    /same marked disposable database/,
  );
  await assert.rejects(
    _internal.verifyDisposableDatabase(configuration, async () => ({
      databaseName: 'ghostmint_test', marker: 'not-disposable',
    })),
    /same marked disposable database/,
  );
});

test('every database-backed test uses the shared guard instead of application database configuration', () => {
  const testsDirectory = __dirname;
  const files = fs.readdirSync(testsDirectory)
    .filter(name => name.endsWith('.integration.test.js') || name === 'smoke.test.js');
  for (const name of files) {
    const source = fs.readFileSync(path.join(testsDirectory, name), 'utf8');
    assert.match(source, /helpers\/disposableDatabase/, `${name} must import the shared database guard`);
    assert.doesNotMatch(source, /CONFIG\.databaseUrl(?:Unpooled)?/,
      `${name} must not use application database configuration`);
    assert.doesNotMatch(source, /LOCAL_ENV|localEnvPath/,
      `${name} must not parse ordinary .env database credentials`);
    assert.doesNotMatch(source, /dotenv\.config\s*\(/,
      `${name} must not load ordinary .env values directly`);
    assert.doesNotMatch(source, /(?:^|[\\/])\.env(?:['"`]|$)/m,
      `${name} must not read the ordinary .env file`);
    assert.doesNotMatch(source, /require\(['"]\.\.\/src\/db\/(?:pool|migrate)['"]\)|testDatabase\./,
      `${name} must obtain pools and migrations through the verified helper`);
  }
});

test('the release validation gate verifies the disposable database before running tests', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const validate = manifest.scripts.validate;
  const verification = 'node scripts/verify-disposable-test-database.js';
  assert.equal(validate.includes(verification), true);
  assert.ok(validate.indexOf(verification) < validate.indexOf('node --run test'));
});

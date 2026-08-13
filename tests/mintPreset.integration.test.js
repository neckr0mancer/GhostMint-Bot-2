const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createDatabasePool } = require('../src/db/pool');
const { createIdentityService } = require('../src/identity/identityService');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createMintService } = require('../src/mint/mintService');
const { createPostgresMintPresetRepository } = require('../src/mint/postgresMintPresetRepository');
const { createProofResolver } = require('../src/mint/proofResolver');

const integrationTest = CONFIG.databaseUrl && CONFIG.databaseUrlUnpooled ? test : test.skip;

integrationTest('a saved user-owned mint preset reproduces manual calldata', { timeout: 60_000 }, async () => {
  await runMigrations({ connectionString: CONFIG.databaseUrlUnpooled,
    migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations') });
  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: 2 });
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  const repository = createPostgresMintPresetRepository(pool);
  const service = createMintService({ presetRepository: repository,
    proofResolver: createProofResolver({ fetchJson: async () => { throw new Error('unused'); } }),
    supportedChains: CONFIG.supportedChains });
  const suffix = `${process.pid}-${Date.now()}`;
  let userId;
  try {
    userId = await identity.resolveOrCreate('telegram', `mint-preset-${suffix}`);
    const input = {
      name: `Drop-${suffix}`,
      contractAddress: '0x00000000000000000000000000000000000000C3',
      methodSignature: 'mint(address,uint256)',
      arguments: ['$wallet', '2'],
      walletAddress: '0x00000000000000000000000000000000000000A1',
      valueWei: 15n,
      chain: 'ethereum',
    };
    const manual = await service.prepare(input);
    await service.savePreset(userId, input);
    const reused = await service.preparePreset(userId, input.name.toLowerCase(), input.walletAddress);
    assert.equal(reused.calldata, manual.calldata);
    assert.deepEqual(reused.preview, manual.preview);
    assert.equal((await service.listPresets(userId)).length, 1);
  } finally {
    if (userId) await pool.query('DELETE FROM users WHERE user_id=$1', [userId]).catch(() => {});
    await pool.end();
  }
});

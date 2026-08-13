const { CONFIG } = require('../src/config');
const { createDatabasePool } = require('../src/db/pool');
const { createKeyEncryption } = require('../src/security/keyEncryption');
const { createRedactor } = require('../src/security/redaction');
const { createPostgresStorage } = require('../src/storage/postgresStorage');

const redact = createRedactor([
  CONFIG.databaseUrl,
  CONFIG.databaseUrlUnpooled,
  CONFIG.botToken,
  ...Object.values(CONFIG.encryptionKeys),
]);

async function main() {
  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: CONFIG.databasePoolMax });
  const storage = createPostgresStorage(pool);
  const crypto = createKeyEncryption({ activeVersion: CONFIG.encryptionKeyVersion, keys: CONFIG.encryptionKeys });
  try {
    const { wallets } = await storage.loadSystemState();
    let rotated = 0;
    for (const wallet of wallets) {
      if (wallet.keyEnvelope.keyVersion === crypto.activeVersion) continue;
      const envelope = crypto.rotate(wallet.keyEnvelope);
      await storage.updateWalletEnvelope(wallet.userId, wallet.id, envelope);
      rotated += 1;
    }
    console.log(`Key rotation complete; rotated ${rotated} wallet(s) to version ${crypto.activeVersion}.`);
  } finally {
    await storage.close();
  }
}

main().catch(error => {
  console.error(`Key rotation failed: ${redact(error.message)}`);
  process.exitCode = 1;
});

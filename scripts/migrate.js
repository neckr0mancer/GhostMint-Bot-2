const path = require('node:path');
const { CONFIG } = require('../src/config');
const { runMigrations } = require('../src/db/migrate');
const { createRedactor } = require('../src/security/redaction');

const redact = createRedactor([
  CONFIG.databaseUrl,
  CONFIG.databaseUrlUnpooled,
  CONFIG.botToken,
  ...Object.values(CONFIG.encryptionKeys),
]);

runMigrations({
  connectionString: CONFIG.databaseUrlUnpooled,
  migrationsDirectory: path.join(CONFIG.projectRoot, 'migrations'),
}).then(({ applied, connection }) => {
  console.log(`Migrations complete via ${connection} connection; applied ${applied.length} file(s).`);
}).catch(error => {
  console.error(`Migration failed: ${redact(error.message)}`);
  process.exitCode = 1;
});

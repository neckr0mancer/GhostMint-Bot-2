// Command-line wrapper around identityService.mergeAccount (see
// src/identity/postgresIdentityRepository.js's mergeAccount for the actual safety logic).
//
// This exists for the case where an owner has no other way to authenticate and run the merge --
// e.g. before the owner-only "merge-account" admin action is reachable, or when shell/DB access is
// the only option available. In every other case, prefer the admin action itself:
//   /admin merge-account <sourcePlatform> <sourcePlatformUserId> <targetPlatform> <targetPlatformUserId> CONFIRM
// from Telegram, Discord, or the dashboard's Owner access page -- it does exactly the same thing
// this script does, without needing shell access to the deployed environment.
//
// Manual, human-operated. Never run automatically in CI or a deployed environment.
const { CONFIG } = require('../src/config');
const { createDatabasePool } = require('../src/db/pool');
const { createRedactor } = require('../src/security/redaction');
const { createPostgresIdentityRepository } = require('../src/identity/postgresIdentityRepository');
const { createIdentityService } = require('../src/identity/identityService');

const redact = createRedactor([
  CONFIG.databaseUrl,
  CONFIG.databaseUrlUnpooled,
  CONFIG.botToken,
  CONFIG.discordBotToken,
  ...Object.values(CONFIG.encryptionKeys),
]);

function readInput() {
  return {
    sourcePlatform: process.env.MERGE_SOURCE_PLATFORM,
    sourcePlatformUserId: process.env.MERGE_SOURCE_PLATFORM_USER_ID,
    targetPlatform: process.env.MERGE_TARGET_PLATFORM,
    targetPlatformUserId: process.env.MERGE_TARGET_PLATFORM_USER_ID,
  };
}

async function main() {
  if (process.env.MERGE_CONFIRM !== 'RUN') {
    console.error('Refusing to run: set MERGE_CONFIRM=RUN to confirm you intend to repoint and '
      + 'delete a duplicate account. This only proceeds if the source account is verified empty.');
    process.exitCode = 1;
    return;
  }

  const input = readInput();
  for (const [key, value] of Object.entries(input)) {
    if (!value) {
      console.error(`Refusing to run: ${key} is required (see script header for the full list of MERGE_* env vars).`);
      process.exitCode = 1;
      return;
    }
  }

  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: CONFIG.databasePoolMax });
  const identity = createIdentityService(createPostgresIdentityRepository(pool));
  try {
    const result = await identity.mergeAccount(input);
    console.log(redact(`Merged: ${input.sourcePlatform}:${input.sourcePlatformUserId} now belongs to account `
      + `${result.targetUserId} (was its own empty account ${result.sourceUserId}, which has been removed).`));
  } catch (error) {
    console.error(redact(`Merge failed, no changes made: ${error.issues ? error.issues.map(issue => issue.message).join('; ') : error.message}`));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();

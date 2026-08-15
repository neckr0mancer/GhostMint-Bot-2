// Milestone 14 — one controlled live testnet mint through the unmodified
// Milestone 7 transaction engine and Milestone 8 mint-construction pipeline.
//
// This is a manual, human-operated tool. It is never run automatically in CI
// or in a deployed environment. See docs/LIVE_ACCEPTANCE_RUNBOOK.md for the
// full procedure before running this script.
const { CONFIG, CHAINS } = require('../src/config');
const { createDatabasePool } = require('../src/db/pool');
const { createKeyEncryption } = require('../src/security/keyEncryption');
const { createRedactor } = require('../src/security/redaction');
const { createPostgresStorage } = require('../src/storage/postgresStorage');
const { createPostgresGovernanceRepository } = require('../src/governance/postgresGovernanceRepository');
const { createTransactionIntentRepository } = require('../src/transactions/intentRepository');
const { createTransactionPolicyRepository } = require('../src/transactions/policyRepository');
const { createProviderService } = require('../src/transactions/providerService');
const { createTransactionEngine } = require('../src/transactions/transactionEngine');
const { createPostgresMintPresetRepository } = require('../src/mint/postgresMintPresetRepository');
const { createProofResolver } = require('../src/mint/proofResolver');
const { createMintService } = require('../src/mint/mintService');
const { createMintExecutionService } = require('../src/mint/mintExecutionService');
const { createLiveAcceptanceRunRepository } = require('../src/acceptance/liveAcceptanceRunRepository');
const { createLiveAcceptanceRunService } = require('../src/acceptance/liveAcceptanceRunService');

const secrets = [
  CONFIG.databaseUrl,
  CONFIG.databaseUrlUnpooled,
  CONFIG.botToken,
  CONFIG.discordBotToken,
  ...Object.values(CONFIG.encryptionKeys),
];
// Full redaction (configured secrets + private-key-shaped values) for arbitrary/error text that
// could theoretically have a leaked key embedded in it. The evidence payload below is already
// constructed to never contain key material, so it only needs the configured-secrets pass -- the
// key-shape regex would otherwise blank out legitimate public tx/block hashes.
const redact = createRedactor(secrets);
const redactPublic = createRedactor(secrets, { matchKeyShapes: false });

function readInput() {
  return {
    operatorUserId: process.env.LIVE_ACCEPTANCE_OPERATOR_USER_ID,
    chain: process.env.LIVE_ACCEPTANCE_CHAIN,
    walletId: process.env.LIVE_ACCEPTANCE_WALLET_ID,
    contractAddress: process.env.LIVE_ACCEPTANCE_CONTRACT_ADDRESS,
    methodSignature: process.env.LIVE_ACCEPTANCE_METHOD_SIGNATURE || 'mint()',
    valueWei: process.env.LIVE_ACCEPTANCE_VALUE_WEI || '0',
  };
}

function printSummary(run) {
  // Chain identifiers (run id, contract, tx hash, explorer link) are public by construction --
  // only the configured-secrets pass applies here, not the private-key-shape regex (see redaction.js).
  const lines = [
    `Live acceptance run ${run.runId}: ${run.outcome.toUpperCase()}`,
    `Chain: ${run.chain}  Contract: ${run.contractAddress}  Method: ${run.methodSignature}`,
    `Simulation performed: ${run.simulationPerformed}`,
  ];
  if (run.intentId) lines.push(`Transaction intent: ${run.intentId}`);
  if (run.evidence?.intent?.txHash) lines.push(`Tx hash: ${run.evidence.intent.txHash}`);
  if (run.evidence?.intent?.explorerUrl) lines.push(`Explorer: ${run.evidence.intent.explorerUrl}`);
  console.log(redactPublic(lines.join('\n')));
  // The failure reason wraps an arbitrary underlying error message, which could in principle have a
  // key-shaped value embedded in it -- keep the full (key-shape-scrubbing) redactor for this line only.
  if (run.outcome === 'failed') console.log(redact(`Failure: ${run.failureCode} — ${run.failureReason}`));
  console.log(redactPublic(`Full evidence: ${JSON.stringify(run.evidence, null, 2)}`));
}

async function main() {
  if (process.env.LIVE_ACCEPTANCE_CONFIRM !== 'RUN') {
    console.error('Refusing to run: set LIVE_ACCEPTANCE_CONFIRM=RUN to confirm you intend to '
      + 'submit a real testnet transaction. See docs/LIVE_ACCEPTANCE_RUNBOOK.md.');
    process.exitCode = 1;
    return;
  }

  const pool = createDatabasePool({ connectionString: CONFIG.databaseUrl, max: CONFIG.databasePoolMax });
  const storage = createPostgresStorage(pool);
  try {
    const governanceRepository = createPostgresGovernanceRepository(pool);
    const providerService = createProviderService({
      chains: CHAINS,
      timeoutMs: CONFIG.rpcTimeoutMs,
      retries: CONFIG.rpcRetries,
    });
    const mintService = createMintService({
      presetRepository: createPostgresMintPresetRepository(pool),
      proofResolver: createProofResolver(),
      supportedChains: CONFIG.supportedChains,
      providerService,
    });
    const keyEncryption = createKeyEncryption({
      activeVersion: CONFIG.encryptionKeyVersion,
      keys: CONFIG.encryptionKeys,
    });
    const transactionEngine = createTransactionEngine({
      providerService,
      intentRepository: createTransactionIntentRepository(pool),
      policyRepository: createTransactionPolicyRepository(pool, { governanceRepository }),
      decryptPrivateKey: wallet => keyEncryption.decrypt(wallet.keyEnvelope),
      notify: event => console.log(redact(`[live-acceptance] intent ${event.intent.intentId} is ${event.state}`)),
    });
    const mintExecutionService = createMintExecutionService({ mintService, transactionEngine });
    const liveAcceptanceRunService = createLiveAcceptanceRunService({
      governanceRepository,
      loadWallet: (userId, walletId) => storage.getWallet(userId, walletId),
      mintService,
      mintExecutionService,
      runRepository: createLiveAcceptanceRunRepository(pool),
      chains: CHAINS,
      supportedChains: CONFIG.supportedChains,
      redact,
    });

    const run = await liveAcceptanceRunService.run(readInput());
    printSummary(run);
    process.exitCode = run.outcome === 'passed' ? 0 : 1;
  } finally {
    await storage.close();
  }
}

main().catch(error => {
  console.error(`Live acceptance run failed unexpectedly: ${redact(error.message)}`);
  process.exitCode = 1;
});

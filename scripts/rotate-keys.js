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
    let eligibilityTokensRotated = 0;
    const authorizations = await pool.query(`SELECT user_id,wallet_id,encrypted_scoped_token,
      encryption_salt,encryption_nonce,encryption_auth_tag,encryption_key_version
      FROM opensea_wallet_eligibility_authorizations`);
    for (const row of authorizations.rows) {
      if (Number(row.encryption_key_version) === crypto.activeVersion) continue;
      const envelope = crypto.rotate({ ciphertext:row.encrypted_scoped_token, salt:row.encryption_salt,
        nonce:row.encryption_nonce, authTag:row.encryption_auth_tag, keyVersion:Number(row.encryption_key_version) });
      await pool.query(`UPDATE opensea_wallet_eligibility_authorizations SET
        encrypted_scoped_token=$3,encryption_salt=$4,encryption_nonce=$5,encryption_auth_tag=$6,
        encryption_key_version=$7,updated_at=NOW() WHERE user_id=$1 AND wallet_id=$2`,
      [row.user_id,row.wallet_id,envelope.ciphertext,envelope.salt,envelope.nonce,envelope.authTag,envelope.keyVersion]);
      eligibilityTokensRotated += 1;
    }
    console.log(`Key rotation complete; rotated ${rotated} wallet(s) and ${eligibilityTokensRotated} OpenSea authorization token(s) to version ${crypto.activeVersion}.`);
  } finally {
    await storage.close();
  }
}

main().catch(error => {
  console.error(`Key rotation failed: ${redact(error.message)}`);
  process.exitCode = 1;
});

const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('node:crypto');
const { Buffer } = require('node:buffer');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;

class KeyDecryptionError extends Error {
  constructor() {
    super('Private key decryption failed');
    this.name = 'KeyDecryptionError';
  }
}

function deriveKey(secret, salt) {
  return scryptSync(secret, salt, KEY_LENGTH);
}

function createKeyEncryption({ activeVersion, keys }) {
  if (!Number.isInteger(activeVersion) || !keys[activeVersion]) {
    throw new Error('The active encryption key version must have a configured master key');
  }

  function encrypt(plaintext) {
    const salt = randomBytes(SALT_LENGTH);
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv(ALGORITHM, deriveKey(keys[activeVersion], salt), nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: activeVersion,
    };
  }

  function decrypt(envelope) {
    try {
      const secret = keys[envelope.keyVersion];
      if (!secret) throw new Error('Unknown encryption key version');
      const salt = Buffer.from(envelope.salt, 'base64');
      const nonce = Buffer.from(envelope.nonce, 'base64');
      const authTag = Buffer.from(envelope.authTag, 'base64');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      if (salt.length !== SALT_LENGTH || nonce.length !== NONCE_LENGTH || authTag.length !== 16) {
        throw new Error('Invalid encryption envelope');
      }
      const decipher = createDecipheriv(ALGORITHM, deriveKey(secret, salt), nonce);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new KeyDecryptionError();
    }
  }

  function rotate(envelope) {
    if (envelope.keyVersion === activeVersion) return envelope;
    return encrypt(decrypt(envelope));
  }

  return { activeVersion, decrypt, encrypt, rotate };
}

module.exports = { KeyDecryptionError, createKeyEncryption };

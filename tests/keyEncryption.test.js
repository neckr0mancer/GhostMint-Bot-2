const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const test = require('node:test');
const { KeyDecryptionError, createKeyEncryption } = require('../src/security/keyEncryption');
const { createRedactor } = require('../src/security/redaction');

const PRIVATE_KEY = `0x${'12'.repeat(32)}`;
const KEY_ONE = 'version-one-master-key-7Qv9!m2Lx4Rk8Zp3Cw6N';
const KEY_TWO = 'version-two-master-key-8Hs5@p3My7Sk9Aa4Df1R';

test('wrong master secret fails safely', () => {
  const original = createKeyEncryption({ activeVersion: 1, keys: { 1: KEY_ONE } });
  const wrong = createKeyEncryption({ activeVersion: 1, keys: { 1: KEY_TWO } });
  const envelope = original.encrypt(PRIVATE_KEY);
  assert.throws(() => wrong.decrypt(envelope), error => {
    assert.ok(error instanceof KeyDecryptionError);
    assert.equal(error.message, 'Private key decryption failed');
    assert.doesNotMatch(error.message, /12{4}|master-key/);
    return true;
  });
});

test('tampered ciphertext is rejected by authenticated encryption', () => {
  const crypto = createKeyEncryption({ activeVersion: 1, keys: { 1: KEY_ONE } });
  const envelope = crypto.encrypt(PRIVATE_KEY);
  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  bytes[0] ^= 1;
  assert.throws(() => crypto.decrypt({ ...envelope, ciphertext: bytes.toString('base64') }), KeyDecryptionError);
});

test('rotation keeps old ciphertext decryptable and writes the active version', () => {
  const oldCrypto = createKeyEncryption({ activeVersion: 1, keys: { 1: KEY_ONE } });
  const oldEnvelope = oldCrypto.encrypt(PRIVATE_KEY);
  const rotatedCrypto = createKeyEncryption({ activeVersion: 2, keys: { 1: KEY_ONE, 2: KEY_TWO } });
  assert.equal(rotatedCrypto.decrypt(oldEnvelope), PRIVATE_KEY);
  const newEnvelope = rotatedCrypto.rotate(oldEnvelope);
  assert.equal(newEnvelope.keyVersion, 2);
  assert.equal(rotatedCrypto.decrypt(newEnvelope), PRIVATE_KEY);
});

test('redactor removes configured secrets and private-key-shaped values', () => {
  const redact = createRedactor([KEY_ONE]);
  const output = redact(`secret=${KEY_ONE} pk=${PRIVATE_KEY}`);
  assert.doesNotMatch(output, new RegExp(KEY_ONE));
  assert.doesNotMatch(output, new RegExp(PRIVATE_KEY));
});

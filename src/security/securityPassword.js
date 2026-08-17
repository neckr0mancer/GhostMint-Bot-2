const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { Buffer } = require('node:buffer');

const SALT_LENGTH = 16;
const HASH_LENGTH = 64;

// Stored as "saltHex:hashHex" in a single TEXT column -- self-contained, so a future change to the
// salt length never breaks rows hashed under the old one.
function hashSecurityPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, HASH_LENGTH);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifySecurityPassword(password, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), HASH_LENGTH);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

module.exports = { hashSecurityPassword, verifySecurityPassword };

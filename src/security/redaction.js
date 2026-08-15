const PRIVATE_KEY_PATTERN = /\b(?:0x)?[a-fA-F0-9]{64}\b/g;

// Shape-based: a private key and a transaction/block hash are both 32-byte hex values, so this
// pattern cannot tell them apart. Only safe to apply to free-text that might contain an accidentally
// embedded key (error messages, logs) -- never to fields already known to hold a public chain value
// (tx hashes, block hashes), or it silently blanks out the exact evidence it was meant to display.
function createRedactor(secrets = [], { matchKeyShapes = true } = {}) {
  const protectedValues = secrets.filter(value => typeof value === 'string' && value.length > 0);
  return value => {
    let output = String(value ?? '');
    for (const secret of protectedValues) output = output.split(secret).join('[REDACTED]');
    return matchKeyShapes ? output.replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]') : output;
  };
}

module.exports = { createRedactor };

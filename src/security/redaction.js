const PRIVATE_KEY_PATTERN = /\b(?:0x)?[a-fA-F0-9]{64}\b/g;

function createRedactor(secrets = []) {
  const protectedValues = secrets.filter(value => typeof value === 'string' && value.length > 0);
  return value => {
    let output = String(value ?? '');
    for (const secret of protectedValues) output = output.split(secret).join('[REDACTED]');
    return output.replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]');
  };
}

module.exports = { createRedactor };

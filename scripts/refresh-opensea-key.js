// OpenSea's public "agent" tier issues a free, no-login API key from a bare POST -- no account,
// no existing key, and no auth header needed. It's rate-limited (600 reads/h at the time this was
// written) and short-lived (about a week), so this script re-requests one and writes it into the
// local .env, rather than expecting a human to visit a dashboard. Run it manually when
// OPENSEA_API_KEY has expired (openSeaConfigured:false in the startup log, or 401s from
// openSeaService), or on a schedule (e.g. a weekly cron) if that's preferred.
const fs = require('node:fs');
const path = require('node:path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const ENDPOINT = 'https://api.opensea.io/api/v2/auth/keys';

async function requestKey() {
  const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error(`OpenSea key request failed: ${response.status} ${await response.text()}`);
  const body = await response.json();
  if (!body.api_key) throw new Error('OpenSea response did not include an api_key');
  return body;
}

function writeKeyToEnv(apiKey, expiresAt) {
  const original = fs.readFileSync(ENV_PATH, 'utf8');
  const commentLine = `# Free-tier "agent" key self-issued from ${ENDPOINT} (no login required).\n`
    + `# Expires ${expiresAt} -- re-run "npm run opensea:refresh-key" for a fresh one when it lapses.\n`;
  const keyLine = `OPENSEA_API_KEY=${apiKey}\n`;
  const pattern = /(?:^#.*\n)*^OPENSEA_API_KEY=.*\n/m;
  const updated = pattern.test(original)
    ? original.replace(pattern, `${commentLine}${keyLine}`)
    : `${original.trimEnd()}\n\n${commentLine}${keyLine}`;
  fs.writeFileSync(ENV_PATH, updated);
}

async function main() {
  const { api_key: apiKey, expires_at: expiresAt, rate_limits: rateLimits } = await requestKey();
  writeKeyToEnv(apiKey, expiresAt);
  console.log(`OpenSea key refreshed, expires ${expiresAt}. Rate limits: ${JSON.stringify(rateLimits)}.`);
  console.log('Restart the app for the new key to take effect.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

require('./src/server');

// Railway currently overrides this repository's start command with `node --use-system-ca
// index.js`, so deployment-only helpers in railway.json do not run there. Keep the approved
// GoldRush contract probe attached to the real entrypoint instead. It is read-only, starts no
// wallet-history worker, touches no database, and runs in the background so provider latency can
// never delay the app healthcheck. The helper prints only sanitized per-chain metadata. Requiring
// an explicit flag prevents the presence of the long-lived API key from rerunning the probe on
// every normal deployment.
const { checkGoldRushWalletHistory, printResult,
  startupProbeEnabled } = require('./scripts/check-goldrush-wallet-history');
if (startupProbeEnabled()
  && typeof process.env.GOLDRUSH_API_KEY === 'string' && process.env.GOLDRUSH_API_KEY.trim()) {
  void checkGoldRushWalletHistory().then(printResult).catch(() => {
    console.log('GoldRush wallet-history check failed safely before a chain response. No database or blockchain write was performed.');
  });
}

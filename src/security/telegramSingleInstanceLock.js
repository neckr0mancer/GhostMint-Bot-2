// Railway's rolling deploys briefly run the new container alongside the old one while the old one
// is still shutting down. If both processes are polling Telegram's getUpdates at once, Telegram can
// deliver the same pending update to both -- one instance does the real work and replies correctly,
// the other is a freshly-booted process with its own empty in-memory flow state (telegramFlowState
// isn't shared across processes), so it re-processes the same command against a different starting
// state and can hit a genuine error (e.g. "no active flow"), which is what reached production as a
// spurious "Command failed safely" sitting right next to the correct result -- live-confirmed
// alongside a Railway log line showing a graceful SIGTERM immediately followed by
// "ETELEGRAM: 409 Conflict: terminated by other getUpdates request", Telegram's own signal that two
// pollers were active on the same bot token.
//
// A Postgres session-level advisory lock serializes polling start across instances: it's held for
// as long as the dedicated connection that took it stays open, and Postgres releases it
// automatically if that connection (or the whole process) dies without calling unlock -- so a
// crashed instance can never strand the lock and block every future deploy, unlike a manual
// lease/expiry row would.
const POLLING_LOCK_KEY = 0x6768546c; // 'ghTl' in hex -- arbitrary, just stable and unique to this lock

async function acquireTelegramPollingLock(pool, { log = () => {} } = {}) {
  const client = await pool.connect();
  log('Waiting for exclusive Telegram polling lock (another instance may still be shutting down)...');
  await client.query('SELECT pg_advisory_lock($1)', [POLLING_LOCK_KEY]);
  log('Acquired exclusive Telegram polling lock.');
  let released = false;
  return async function release() {
    if (released) return;
    released = true;
    try { await client.query('SELECT pg_advisory_unlock($1)', [POLLING_LOCK_KEY]); }
    finally { client.release(); }
  };
}

module.exports = { acquireTelegramPollingLock, POLLING_LOCK_KEY };

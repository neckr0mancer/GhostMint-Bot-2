// Scheduled mints must execute on the chain where their contract was detected -- the same chain
// the manual and batch forms already broadcast on -- not wherever the signing wallet happens to
// call home. An EVM key works identically on every chain; balances and contracts do not travel
// with it. mint_tasks.chain records that detection-time chain (migration 052 backfills older
// rows from their own wallet), so a schedule keeps meaning what it meant when it was created.
//
// Pure decision, deliberately no I/O: the caller owns every failure path. A stored-but-unsupported
// chain comes back as { error } so executeTask can fail the task permanently instead of silently
// broadcasting on some other network.
function resolveTaskChain(task, supportedChains) {
  const stored = String(task?.chain || '').trim().toLowerCase();
  if (!stored) return { chain: null };
  if (Array.isArray(supportedChains) && supportedChains.includes(stored)) return { chain: stored };
  return { error: stored };
}

module.exports = { resolveTaskChain };

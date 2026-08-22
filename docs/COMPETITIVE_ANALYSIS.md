# Competitive Analysis — GhostMint vs dedicated mint scripts

**Written:** 2026-08-21 · **Author:** ox-alpha (framework review, no code changed)
**Audience:** the next AI session ("Opus 5") picking up the one-week competitiveness push.
**Goal stated by owner:** make GhostMint as competitive as dedicated mint scripts, within one week.
**Read this together with** `docs/WORKLIST.md` Section AV (Round 16) and CLAUDE.md's "Where things
stand" — this file deliberately does not repeat them; it adds what they don't cover: a critical
gap analysis of the execution paths themselves.

---

## 1. Verdict

GhostMint is a **safe, well-governed transaction framework that is structurally a *late* minter**.
Dedicated scripts win on exactly three things, all fixable on top of what exists here:

1. **They do ~nothing at T=0.** GhostMint does 6–10 sequential network round trips *after* the
   fire moment (see §3.1). Pre-arming (Round 16 item A3, paused) is the single highest-value
   build — the static code evidence says it will pay off; confirm with real Railway timing logs
   first, then build it (§5 Day 1–2).
2. **They fire at/predicting the open; GhostMint's sniper fires ≥2 blocks after the target's tx is
   already mined.** The sniper is a post-inclusion copy-trader (`sourceConfirmations` default 2,
   `src/validation/domain.js:333`), not a launch/mempool sniper. Structurally cannot win a race
   as-is (§3.4).
3. **They bump stuck transactions.** GhostMint has zero re-price/replace logic — a below-floor bid
   just times out after 10 minutes (§3.2).

Everything else (pools, failover, precise timers, idempotency, nonce safety, timing logs) is
already built and good — preserve it, don't rebuild it.

---

## 2. What's already strong (do NOT redo)

Verified against code, not just the worklist:

| Capability | Where |
|---|---|
| Idempotent intent persistence + DB nonce reservation (`GREATEST(MAX(nonce)+1, providerNonce)`) | `src/transactions/intentRepository.js:74` |
| Per-wallet serialization preventing nonce races | `src/transactions/nonceQueue.js` |
| Three isolated RPC pools (general / fast / sniper), sequential failover with URL rotation | `src/transactions/providerService.js`, `src/config/index.js` |
| Same-signed-tx multi-RPC broadcast race (sniper only) | `providerService.performAll`, used `transactionEngine.js:411` |
| WS-first chain watcher w/ HTTP fallback + endpoint rotation + reconnect | `src/sniper/chainWatcher.js` |
| Precise near-launch timers (setTimeout arming over 1s poll) | `src/scheduler/schedulerWorker.js:122` |
| Fee-data cache (5s TTL) + tight 3s/0-retry pre-broadcast RPC budget on time-critical paths | `feeDataCache.js`, `transactionEngine.js:12` |
| End-to-end timing checkpoints (`submitStartedAt/preparedAt/signedAt/broadcastAt`) | `transactionEngine.js:244,389,401,420` |
| Governance ceilings, simulation modes, audit trail, SeaDrop revert decoding, OpenSea Drops support | throughout |

---

## 3. Shortcomings, ranked by competitive impact

### 3.1 Everything happens AFTER T=0 (scheduled/Degen path)

`server.js:292 executeTask` at fire time, in order:

1. `governance.checkAccountStatus` (DB)
2. wallet lookup
3. **OpenSea path:** `openSeaService.buildMintTransaction` — a live HTTPS call to OpenSea's API
   *inside the fire path* (`server.js:310`). At a popular drop's open, OpenSea itself is slowest.
   **SeaDrop/plain path:** drift preflight reads PublicDrop fresh over RPC (`server.js:331-343`,
   deliberate — keep the check, move it pre-T0), then `prepareMintCall`.
4. `mintExecution.executePrepared` → **`await onPreview(...)` sends the Telegram preview message
   BEFORE submit starts** (`src/mint/mintExecutionService.js:4`; server.js:352 wires it to
   `notifyUser`). That is a Telegram HTTPS round trip on the critical path of every scheduled
   mint. Cheapest win in this whole document: make it fire-and-forget or send post-broadcast.
5. Then `transactionEngine.submit`'s own chain: feeData → estimateGas → getBalance →
   rollingSpendWei (DB) → simulate (policy-dependent) → getTransactionCount(pending) →
   **getNetwork (pure waste — chainId is already known statically via
   `providerService.expectedChainId`; the RPC call at `transactionEngine.js:340` only feeds a
   comparison against config)** → decrypt key + sign → persist → broadcast.

Net: even with the fast-path pool and fee cache, a scheduled mint does roughly 6–8 sequential
round trips after the moment it was supposed to fire. Dedicated scripts sign-and-broadcast at T=0
because everything else was done before.

### 3.2 No stuck-transaction recovery (no bump/replace/cancel)

Grep confirms zero re-pricing logic anywhere. If a mint broadcasts under the inclusion bar,
`waitForFinality` polls until `timeoutAt` (default 10 min) and ends `unknown`. The only "replaced"
detection is passive (`inspectChain` notices the nonce was consumed by something else,
`transactionEngine.js:181`). Dedicated bots re-bid same-nonce at +X% on a timer. This converts
would-be failures into wins and is independent of #1/#3.

### 3.3 Finality wait holds the per-wallet lock

`submit()` returns `waitForFinality(intent)` from INSIDE `nonceQueue.run(walletKey, ...)`
(`transactionEngine.js:245→423`). With defaults (`defaults.js`: ethereum 12, base 10, arbitrum 20,
polygon 128 confirmations), one wallet cannot fire again — including a scheduler retry or sniper
refire — for ~144s (ETH) to ~4+ min (polygon) after each send. Batch across distinct wallets is
fine; same-wallet sequences are crippled, and polygon's 128 is far beyond what any mint flow needs
for *safety of the next send* (the DB nonce reservation already prevents reuse).
Fix: release the queue slot at `pending` (post-broadcast); reconciliation continues outside it.

### 3.4 Sniper is structurally late — it's a copy-trader, not a sniper

Flow today (`server.js:778 onBlock` → `sniperService.processBlock` → `execute`):

- WS delivers the block header → `provider.getBlock(blockNumber, true)` downloads **every
  transaction in every block** on the watched chain (heavy, slow, rate-limit-hungry) just to scan
  `tx.from` matches.
- Detection requires the source tx to be **mined**. Execution additionally waits
  `sourceConfirmations` (default 2) blocks AND re-verifies the canonical receipt
  (`sniperService.js:27-30`) — so the copy lands ≥2 blocks (~24s on mainnet, ~4s on L2s) after the
  target's own tx included.
- There is **no mempool awareness anywhere** (no `newPendingTransactions` /
  `alchemy_pendingTransactions` subscription, no pending-tx trigger mode).

For "competitive with dedicated mint scripts," this is the headline gap: those fire when the mint
contract opens (their own Section R Phase 2 idea) or on pending mempool signals — never two blocks
after someone else's confirmed purchase. Note the existing per-target human-verification gate and
allowlists must carry over to whatever faster trigger replaces this; don't drop the safety rails.

### 3.5 Hot-path micro-inefficiencies (cheap, low-risk)

- Independent reads serialized: feeData / estimateGas / getBalance / getTransactionCount could be
  one `Promise.all` (nonce reservation stays last and ordered).
- `getNetwork()` RPC per submit — eliminable (see §3.1 item 5).
- `estimateGas` per submit — dedicated scripts cache gas limits per contract+method+qty; a small
  TTL cache keyed that way removes another round trip (SeaDrop mints are highly repetitive).
- Detection loop awaits `detect()` sequentially per tx × per sniper (`server.js:783-793`) while
  `processBlock` itself parallelizes — fine at today's scale, worth batching at 200 users.

### 3.6 Recorded decisions worth revisiting ONLY with the owner

These were decided deliberately (worklist documents the reasoning). Flagged here because the
"competitive in one week" goal changes their cost/benefit — but reversing them without the owner
violates the repo's own conventions:

- **Broadcast race is sniper-only** (Round 16 item 5). The same-signed-tx safety argument applies
  identically to scheduled fires; extending `performAll` there is a one-line-ish change with a
  recorded prior decision against it.
- **No MEV/private relay** (Section AV "explicitly out of scope"). The reasoning (mints aren't
  sandwich prey) is sound — agree, leave closed.
- **Hot-wallet session cache** (Worklist B5) needs explicit sign-off; quantifying
  `decryptPrivateKey` cost first may show it's unnecessary.
- **Pre-arm pause** (A3) was made pending timing evidence — see §5 Day 1: pull the evidence, then
  build.

### 3.7 Known-but-unfixed smaller items (from worklist, restated for one-stop reading)

Timing logs exist but are console-only — no aggregation/dashboard (Worklist B6); RPC health
scoring absent (B4); `SUPPORTED_CHAINS` env drift class issues fixed but worth a startup assertion;
single-process architecture means an event-loop stall anywhere delays timers everywhere
(architectural, not week-one material — noted so it doesn't surprise anyone mid-plan).

---

## 4. What "competitive" costs, concretely

Rough budget at T=0 for a pre-armed scheduled mint vs today:

| Stage | Today (post-T0) | After plan |
|---|---|---|
| Wake-up | ~0 (precise timers) | ~0 |
| Preview msg (Telegram RTT) | 100–1000ms+ | removed from path |
| Drift/OpenSea checks | 50–500ms+ (RPC/HTTPS) | done pre-T0 |
| Fee+gasEstimate+balance+nonce (serial RPC) | 200–800ms | ≤1 parallel round trip (~50–150ms) |
| Simulation | 50–300ms (mode-dependent) | done pre-T0, re-checked cheaply |
| Sign+persist+broadcast | ~50–150ms | unchanged |
| Stuck-tx recovery | none (timeout) | auto-bump at +X% |

That takes the fire-moment work from ~0.5–2.5s down to ~0.1–0.3s, and turns silent timeouts into
re-priced retries. For the sniper, adding a pending-tx trigger moves firing from N+2 blocks to the
same block as (or before) the copied trade — the difference between winning and losing by
construction.

---

## 5. Suggested one-week sequence

Owner decisions needed early (ask, don't assume): extend broadcast race to scheduled? (§3.6) ·
simulation default for scheduled fires (pre-arm makes re-simulation redundant) · acceptable
bump aggressiveness (+% per attempt, ceiling).

- **Day 1 — Evidence + quick wins.** Pull Railway `Transaction timing (...)` lines for recent
  scheduled/sniper mints (mechanism in CLAUDE.md). Ship the trivially safe wins:
  onPreview off the critical path; drop the `getNetwork` RPC (trust config chainId, verify via
  broadcast/reconcile failure path instead); parallelize fee/gasEstimate/balance/nonceCount.
- **Day 2–3 — Pre-arm (A3).** Split prepare/fire: at T−lead (default 10–15s, tune from Day 1
  data) run policy, calldata build, drift/OpenSea checks, fee snapshot, gas estimate, simulation,
  balance+budget check; reserve nothing yet. At T=0: fetch fresh fee only-if-stale (separate
  staleness rule from `feeDataCache`'s 5s — this resolves the recorded TTL objection), single
  nonce read, sign, broadcast. Keep the ordinary path as fallback if pre-arm failed/didn't run.
  This subsumes Worklist B1 (parallelized prep) — build the prepare step concurrent-safe from the
  start.
- **Day 3 — Nonce-queue release at `pending`.** Move `waitForFinality` out of the queue callback;
  reconcile loop unchanged. Watch for tests pinning current behavior
  (`tests/transactionEngine.test.js`).
- **Day 3–4 — Bump/replace.** Background sweeper over non-final intents: if pending > Xs and
  nonce still free, re-sign same nonce at +Y% (capped by gasCeiling), mark `replacement_tx_hash`
  (column already exists), rebroadcast (race across pool). Trigger sources: scheduled +
  blockchain first; manual opt-in later. Never bump past policy ceiling; never bump a
  `confirmed`/`reverted` intent (state machine already guards).
- **Day 5 — Sniper pending-tx mode.** Add WS `newPendingTransactions` (or Alchemy's address-filtered
  pending subscription where available) to `chainWatcher` alongside block mode; new per-sniper
  `triggerOn: 'pending'|'confirmed'` (default confirmed = zero behavior change). Pending events
  skip the receipt re-verification (no receipt yet) but KEEP allowlist/denylist/cooldown/value
  caps/verification gates. Also switch detection away from full-block downloads for confirmed
  mode if the provider supports filtered subscriptions; otherwise accept the cost.
- **Day 6 — Aggregation + load rehearsal.** Aggregate timing checkpoints into an in-memory
  rolling window exposed via health/dashboard JSON (Worklist B6 lite). Rehearse the burst
  scenario from Round 16 item 2 (≈50 simultaneous fires): watch pool behavior, fee cache
  stampede, DB contention on `claimDue`/intent inserts.
- **Day 7 — Live acceptance + docs.** Run the existing acceptance harness (Sepolia is kept
  internally for exactly this), update WORKLIST with what shipped/paused, hand back.

Cut line if time runs short: Day 5 pending-mode is the most optional; Days 1–4 deliver most of
the competitiveness delta for scheduled mints, which is the majority of real usage.

---

## 6. Handoff notes for Opus 5

**Repo conventions that bind you** (from CLAUDE.md, restated because they're easy to trip on):

- Commit freely once verified; **never push without an explicit go-ahead in that turn.**
- Run targeted test files you touched, then the suite. `smoke.test.js` has known-flaky bootstrap
  tests — don't read its timeout alone as regression. Full gate: `npm run validate`.
- Reproduce live where possible (Railway log access is documented in CLAUDE.md; GraphQL shapes in
  WORKLIST Round 10 item 10) rather than reasoning from memory.
- Shared decision logic lives in `mintFlowDecision.js` / `watchRuleFlowDecision.js` — extend,
  don't fork platform branches.
- New perf knobs follow the established shape: opt-in env vars, zero behavior change when unset,
  aliased fallback to existing pools (see `{ENVNAME}_FAST_URLS`, `{ENVNAME}_RPC_SNIPER_URLS/_WS`).

**State warnings as of this writing:**

- Working tree is dirty: `server.js`, `discordBot.js`, `WORKLIST.md`, `tests/discordTaskFlow.test.js`
  modified, plus untracked `src/notifications/discordMarkdown.js` / `tests/discordMarkdown.test.js`
  — plausibly a concurrent session's work. Check `git status` and coordinate before editing
  `server.js` specifically (your hot-path changes will collide there).
- Local repo has odd branch state (currently on `neckr0mancer/focused-euler-k5eynn`,
  `warning: ignoring broken ref refs/heads/main`). Verify what you're committing onto before the
  first commit.

**Do not silently reverse** (owner decisions — ask first): MEV-relay scope-out; sniper-only
broadcast race; simulation-skip exception boundaries; hot-wallet session cache; anything gated on
human-verification/allowlist rails around snipers.

**Where to start:** Day 1 items are all small, independently shippable, and produce the evidence
that de-risks Day 2–3 (pre-arm), which is the centerpiece. If you only have one shot at a PR this
week, make it pre-arm with the nonce-queue release folded in.

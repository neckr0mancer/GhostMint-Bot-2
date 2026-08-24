# GhostMint — Handoffs (append-only, newest first)

---

## 2026-08-24 (latest) — Model 1 — REG-002 chaos suite + fixture cleanup + failure-reason fold

- **Branch:** `main` · **Commits held then pushed:** `05972c3` (INNOV-001), `22dd73b` (dashboard Ink), `8cebbcc` (ACO deletion), `310558b` (docs), `655d23f` (failure-reason fold), `9f17ede` (REG-002 chaos + cleanup script). All pushed, `0/0`.

**Shipped this stretch:**
- **INNOV-001** (`05972c3`): `scheduledValidity.js` oracle + `moveFireTime` + pre-arm wiring — fire moment moves to the contract's real opening BEFORE T; zero failed attempts for SeaDrop drops.
- **ACO deletion** (`8cebbcc`, owner option A): prod `launch_squads` verified empty first; removed `src/launch`, 4 test files, all `/aco` surfaces both platforms (−1284 lines). Kept `triggerSource:'launch'` branches + DB tables.
- **Failure-reason fold** (`655d23f`): server.js wired `sanitizeError: safeError`, skipping `errorReason`'s issue fold — every ValidationError stored/notified the constant "Request validation failed". Now folds + redacts. Exposed by real prod failures: The Doll Club GTD (robinhood `0x0d77e2b1`, viaOpenSea signed_presale) — almost certainly OpenSea eligibility for that wallet; upcoming FCFS/public tasks will show real reasons.
- **REG-002** (`9f17ede`): `scheduledValidity.chaos.test.js` 8/8 — T+1/T+3/T+7 delayed opens with a faithful retryAt clock, RPC disconnect, duplicate blocks, watcher wiring, restart, burst-exhaustion re-arm, eligibility-permanent. Plus `scripts/clear-test-fixtures.js` (dry-run found 1701 fixture tasks + 30 wallets; `--yes` is an owner action).

**Verification:** chaos 8/8, related suites 157/157, full gate 917/917 (at `22dd73b`), lint OK, dashboard build OK, staged diffs secret-scanned.

**Unresolved risks (unchanged):** SEC-003 multi-instance locks, RPC-004 clock drift, RPC-001 withTimeout leak, PERF-005 load rehearsal, DNS-rebinding residual.

**Exact next action:** owner runs `node scripts/clear-test-fixtures.js --yes` when ready to purge fixtures; then D9 acceptance run (internetmonkes 2026-08-28) per Round 22. Chaos suite is the regression gate for any future scheduled-validity change.

---

## 2026-08-24 (latest) — Model 1 — INNOV-001 + ACO deletion

- **Branch:** `main` · **Start:** `22dd73b` context · **Commits:** `05972c3` (INNOV-001), `22dd73b` (dashboard Ink sync — caught by gate), `8cebbcc` (ACO deletion). Held, not pushed.
- **INNOV-001 (`05972c3`):** `scheduledValidity.js` pure oracle + `schedulerRepository.moveFireTime` + pre-arm wiring — at T-12s a live-window mismatch moves the fire moment to the contract's real opening BEFORE T; first attempt valid, zero failed tries. Tests: oracle 8/8, moveFireTime integration vs real DB (scheduled moves / claimed refuses / mint_time kept).
- **Gate catch (`22dd73b`):** dashboard `EVM_CHAINS` hardcoded array omitted Ink → chain dropdown silently missing Ink. Fixed + CHAIN_META/EXPLORERS/DOT/LABEL. chainGrouping 2/2.
- **ACO deletion (`8cebbcc`):** prod `launch_squads` verified EMPTY first (nothing orphaned). Removed `src/launch` (5 files), 4 test files, all `/aco` surfaces (Telegram handlers + Discord slash/component cases + wiring + timer worker + createDiscordBot params). Kept `triggerSource:'launch'` engine/bumper branches (historical intents, zero-risk) and DB tables (no destructive migration). discordBot command-surface test updated. −1284 lines.
- **Verification:** lint OK, check OK, full suite 900 tests / 898 pass / 0 fail / 2 cancelled — the two cancelled are `dashboard.integration` WAN timeouts under full-suite load; **re-ran in isolation: 2/2 pass** (flaky-under-load, not a regression). chainGrouping 2/2, dashboard build OK.
- **Unresolved risks:** unchanged (SEC-003 multi-instance, RPC-004 clock drift, RPC-001 timeout leak, REG-002 chaos tests, PERF-005 load rehearsal).
- **Exact next action:** REG-002 deterministic chaos tests for the scheduled validity path (T+1/T+3/T+7 with fake clock + fake block feed, RPC disconnect mid-window, duplicate block events, restart during armed window). Push only on owner instruction.

---

## 2026-08-24 (later) — Model 1 — INNOV-001 shipped: zero-failed-attempt scheduled mints; Ink paste fix

- **Branch:** `main` · **Start:** `2aa05c2` · **End:** `13fce24` + this commit
- **Scope:** Competitive scheduled-mint architecture (owner-approved), Ink chain enablement, paste wallet/contract differentiation.

**Shipped this session (chronological):**
- `5211dc5` precise timers re-arm on moved `nextAttemptAt` + `'throttled'` retry (no more N-5 lost fires)
- `7e82499`/`0d4b5af`/`334536e` paste silent-drop → visible errors (Discord+Telegram parity)
- `09f5b20` WORKLIST.md session checkpoint (stale notes corrected)
- `079e722` SeaDrop early window → transient `STAGE_NOT_OPEN` (250ms×8 burst + block-driven retry via sniper WS `handleBlock`) + scheduled broadcasts race the fast pool
- `ed2b9b0` pre-arm warms feeData/balance/nonce/network at T-12s
- `4da8600`+`9ec7b9e` paste ignores owned wallets and any EOA (`isContractAddress`)
- `5f0d096`+`2aa05c2` Ink chain 57073 + canonical SeaDrop core; prod vars set via Railway GraphQL (`SUPPORTED_CHAINS+=ink`, `INK_RPC_URLS`); deploy `dcb9c88d` SUCCESS
- `df6a2b9` **Ink paste root cause:** `OPENSEA_CHAIN_SLUGS` lacked ink (links failed); also fixed dead EOA-check (`.catch` on a synchronous array threw, skipping the check)
- `13fce24` on-chain SeaDrop tasks re-arm to `getPublicDrop.startTime` after the burst (was OpenSea-only)
- This commit: **INNOV-001** — `scheduledValidity.js` pure oracle (`classifySeaDropWindow`/`preArmRearm`, 8 tests), `moveFireTime` repo method (integration test vs real DB: scheduled moves, claimed refuses, `mint_time` kept), pre-arm wiring: at T-12s a live-window mismatch **moves the fire moment before T**, so the first attempt is valid — zero failed attempts for SeaDrop drops. Generic contracts keep burst+block-retry+re-arm fallback.

**Delayed-mint coverage after this session:** T+0–2s burst; T+2s+ on-chain SeaDrop → pre-arm re-arm (now) or post-burst re-arm (`13fce24`); OpenSea → stage re-arm; generic → burst+re-arm fallback (inherent: no oracle exists).

**Tests:** scheduledValidity 8/8; scheduler 24/24; scheduler.integration 3/3 (incl. new moveFireTime vs real DB); openSeaService+discordMintFlow 58/58; lint OK; dashboard build OK.

**Unresolved risks:** DNS-rebinding SSRF residual; multi-instance locks (SEC-003); `withTimeout` leak (RPC-001); clock drift (RPC-004). Ink has no WS configured (RPC-011, owner action).

**Exact next action:** ACO deletion (owner approved option A) — inventory live squads first (`launch_squads` non-terminal rows), port `triggers.js` block/pending concepts into the scheduled path if anything is still missing, remove `src/launch` + `/aco` `/acotarget` `/acostatus` surfaces, keep `launchRepository` data readable or migrate. Then REG-002 chaos tests.

---

## 2026-08-24 — Model 1 — Agent-memory bootstrap + full adversarial audit (no new production code in this unit)

- **Branch:** `main`
- **Starting commit:** `2aa05c2` (`fix(mint): add Ink to canonical SeaDrop core for paste detection`)
- **Final commit:** *(this commit — docs/agent memory files only)*
- **Scope:** Create shared-memory system (`agents.md`, `AGENTS.md` §11, `docs/agent/*`, `docs/agents/reviews/phase-01.md`); record the completed 8-pass adversarial audit and its already-shipped fixes as a committed worklist with stable IDs; run the finishing gate. **No production code changed in this unit** per instruction ("Do not implement fixes yet").

**Changed files (this commit):**
- `AGENTS.md` (modified) — appended §11 shared-memory rules; original contract preserved byte-for-byte (311 lines → 338)
- `docs/agent/PROJECT_STATE.md` (new) — pinned branch/HEAD/deploy/prod-evidence state
- `docs/agent/WORKLIST.md` (new) — 9-phase, ID'd worklist (SEC/TX/RPC/MINT/UX/PERF/INNOV/REG/BASE) with statuses
- `docs/agent/DECISIONS.md` (new) — 10 dated architectural decisions with evidence
- `docs/agent/HANDOFFS.md` (new) — this file
- `docs/agents/reviews/phase-01.md` (new) — phase-1 audit review (findings → fixes → open items)

**Incident recorded (caught in self-scrutiny before commit):** Windows filesystems are case-insensitive, so the requested separate `agents.md` entry point **is the same file as `AGENTS.md`** — an initial write to `agents.md` overwrote the implementation contract. Caught via staged-diff inspection (303 unexpected deletions), restored from `git show HEAD:AGENTS.md` via node (PowerShell pipeline mangled newlines on first attempt), verified: original 311 lines intact + §11 appended, diff vs HEAD shows additions only, zero deletions. **Lesson for all models: on this machine there is no separate `agents.md`; `AGENTS.md` §11 IS the memory entry point.**

**Commands run & results:**
- `git status` / `git branch --show-current` / `git log --oneline -10` — clean except phantom `M` on `tests/bumper.test.js` + `tests/launchTriggers.test.js` (verified: `git diff` empty, blob hashes == HEAD, `i/lf w/lf`) — **left untouched, not staged**
- `node --run lint` — **OK** (0 problems)
- `node --run dashboard:build` — **OK** (1.86s; pre-existing >500kB chunk warning only)
- `node --test --test-concurrency=1 tests/smoke.test.js` — **3/3 pass** (health 14.5s, discord-failure 15.7s, banned-account 19.7s)
- Full suite reference: **908/908 pass** earlier today on this same code base (`2026-08-24T08:30Z`)

**Results:** Audit complete; 15 confirmed defects fixed and pushed across `d31f2df..2aa05c2` (see `phase-01.md` table); 20+ open findings recorded in the worklist with IDs, severities, file:line and acceptance notes.

**Unresolved risks:** multi-instance nonce/lock safety (SEC-003, TX-017); app-vs-DB clock drift (RPC-004); DNS-rebinding SSRF residual; no latency aggregation yet to prove competitive wins numerically (BASE-002).

**Exact next action:** Implement `INNOV-001` (`scheduledValidity.js` pure oracle + per-block recheck loop) with deterministic tests `REG-002` (T+1/T+3/T+7, RPC disconnect, duplicate block, restart) — per owner-approved direction ("trigger first… apply parts to sniper and repository, particularly the scheduled mint execution path"). Before that, resolve owner decision on `INNOV-002` (ACO deletion order vs live squads).

---

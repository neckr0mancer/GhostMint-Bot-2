# GhostMint — Agent Worklist (Model 1)

*Created 2026-08-24 from the adversarial repo audit (8 passes) + production evidence. Statuses: `TODO`, `READY`, `IN_PROGRESS`, `BLOCKED`, `FIXED`, `REVIEW_FAILED`, `VERIFIED`. Re-audit each item before starting — the app is live and older notes go stale.*

**Evidence key:** every `FIXED`/`VERIFIED` item cites its commit and test. Findings separate confirmed defects (evidence cited) from hypotheses (marked `[H]`).

## Phase 1 — Baseline and observability

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| BASE-001 | Full validation gate green | VERIFIED | Full gate at post-correction HEAD: 982 tests / 979 pass / 0 fail / 0 cancelled / 3 skipped (DB integration by design). Lint clean, dashboard build clean, Model 2 reviewer reproductions 9/9 pass. Historical note: the 908/908 claim at 1d99936 and the 916/916 claim at e617b26 were both premature
| BASE-002 | `Transaction timing` logs exist (prep/sign/broadcast/total) but are not aggregated per chain | READY | `transactionEngine.js:496` emits `event:'timing'`; `server.js:240` logs only. Add rolling per-chain averages to prove latency wins |
| BASE-003 | `performAll` does not report which RPC URL won the race | READY | `providerService.js:73-104` discards candidate identity; needed to tune `*_FAST_URLS` ordering |
| BASE-004 | `reconcileNonFinal` counts failed reconciliations as successes in boot log | READY | `transactionEngine.js:514-531` pushes stale intent on catch; boot log "Reconciled N" is ambiguous |
| BASE-005 | Integration-fixture cleanup | FIXED | SQL alias corrected (d.uid/d.lbl now matches declared columns). Purge verified: 1714 tasks + 33 wallets deleted, re-run shows 0. Reviewer re-review test BASE-005 passes
| BASE-006 | Agent memory structure and evidence integrity | REVIEW_FAILED | `e617b26` deleted the worklist title/preamble/Phase-1 header, malformed nine rows, claimed 916/916 with zero skips, and said all findings were addressed. Model 2 restored structure in the review commit; add a Markdown/status/evidence lint |

## Phase 2 — Security and data integrity

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| SEC-001 | SSRF via scraper sourceUrl | VERIFIED | scraperUrlPolicy.js canonical policy used by both validation and adapters (shared import, no duplication); DNS resolution at poll time; reviewer re-review test SEC-001 passes. Remaining: TOCTOU between resolve and connect is theoretical (same-tick lookup + request)
| SEC-002 | Double-mint on double-click (Discord/Telegram) | FIXED | `5097ae2` per-platform in-flight locks; concurrent-double-confirm regression still absent — do not promote to VERIFIED until both platform paths have one |
| SEC-003 | Double-mint across platforms / multi-instance | TODO `[H]` | Locks + `WalletNonceQueue` are per-process; two pods bypass. Needs DB advisory lock or cross-instance idempotency at claim time. Only relevant if scaled past 1 instance |
| SEC-004 | `flowState` holds plaintext private keys in memory up to TTL | TODO | `discordBot.js` batch-import merges raw keys into flow data; consider zeroing after use or storing only envelopes |
| SEC-005 | `exportWalletRaw` success path not rate-limited (2/h applies only to wrong-password attempts) | TODO | `dashboard/api.js:254-262`; documented design gap — needs owner decision |
| SEC-006 | `POST /api/wallets/import` + `/batch-import` have no `CONFIRM` gate unlike delete/export | TODO | `api.js:353-354`; hijacked session can create wallets silently |
| SEC-007 | Redaction blanket: any 64-hex (incl. txHash) → `[REDACTED_PRIVATE_KEY]`; BIP-39 phrases not matched | TODO | `security/redaction.js:1-14`; destroys audit value of logs, misses phrases |
| SEC-008 | Discord `/wallet import` accepts raw key via slash option (transits Discord payload) | TODO (owner decision) | `discordBot.js:74-78`; modal-only is safer; product call |
| SEC-009 | CSRF compare not constant-time; session slides on CSRF-failed POST | TODO | `authService.js:29-35`; low risk behind SameSite=Strict |
| SEC-010 | Login rate limit per-IP only; distributed brute force on 40-bit link code | TODO `[H]` | `api.js:128`; 5-min TTL mitigates; consider per-code attempt counter |
| SEC-012 | Scheduled pre-arm caches account standing across T0 | REVIEW_FAILED | `prearmScheduledTask` checks status at T-12, but a matching `armedPreparations` entry makes `executeTask` skip the T0 check. A ban/suspension/deactivation between preparation and fire can still broadcast; authorization must never be cached |

## Phase 3 — Transaction correctness

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| TX-001 | Gas-ceiling precedence over transient reads | VERIFIED | Model 2 exact-snapshot `reviewRepro.transactionEngine.test.js`: ceiling-vs-balance and ceiling-vs-spend interaction tests pass |
| TX-002 | False-final `replaced` misclassification | VERIFIED | Model 2 exact-snapshot `reviewRepro.transactionEngine.test.js`: a live earlier nonce stays non-final when a later wallet nonce is pending |
| TX-003 | Bump ladder rescues `unknown` intents | FIXED | `da123b0` — `listBumpCandidates` + `attachBump` include `unknown` |
| TX-004 | Definitive broadcast errors | FIXED | performAll: success wins unconditionally; definitive only when ALL candidates definitively reject (any timeout = ambiguous RpcUnavailable). Reviewer re-review test TX-004 passes. Remaining: sequential perform() has the same mixed timeout/definitive gap
| TX-005 | Daily budget state-aware arithmetic | REVIEW_FAILED | The state `CASE` improved, but `created_at >= cutoff` releases unresolved intents after 24h and excludes transactions created earlier but settled now. Add old-unknown, late-finalization, boundary, replacement, and missing-revert-cost PostgreSQL cases |
| TX-006 | Scheduled early SeaDrop window fails permanently | FIXED | `079e722` — `STAGE_NOT_OPEN` transient, 250ms×8 burst, block-driven retry, fast-pool broadcast race |
| TX-007 | Scheduled pre-arm cold start | FIXED | Fee re-warm at T-4s inside the 5s TTL window; completed-prearm sentinel prevents duplicate pre-arms; balance/nonce are connection-warming only (honest scope). Reviewer re-review test TX-007 passes. Remaining: warm the fast pool (not general); latency benchmark owed (PERF-005)
| TX-008 | `inspectChain` ignores `bumped_from_tx_hash` receipt | FIXED | Exact `e617b26` polls the immediate predecessor and regressions cover one bump rung. This narrow fix is not a complete multi-rung history solution; see TX-022 |
| TX-009 | `maxPriorityFeePerGasWei ?? 0n` → 0-priority bumps stay 0 → "replacement underpriced" loop | TODO | `transactionEngine.js:365` + `bumper.js:50-52` floor handles fresh>0 but 0 stays 0 when RPC returns null priority |
| TX-010 | `preview()` ignores explicit `maxFeePerGasWei`/`maxPriorityFeePerGasWei` (diverges from submit) | TODO | `transactionEngine.js:225-233`; sniper path uses explicit maxFee — preview can mislead |
| TX-011 | `applyGasMultiplier` truncates instead of ceiling-divides | TODO | `transactionEngine.js:39-44`; small fees ×1.5 can round down; bumper already ceils |
| TX-012 | `feeData.maxFeePerGas` truthiness fails for `0n` (L2 edge) | TODO | `transactionEngine.js:329`; use `!= null` |
| TX-013 | `nextNonce` race across processes bounded by 5×`23505` retries; `23505` may be idempotency/txHash not nonce | TODO | `transactionEngine.js:406-444`; distinguish constraint names |
| TX-014 | `attachSignedHash` can race boot-time `reconcileNonFinal` (submitted→unknown between create and attach) | TODO `[H]` | Narrow window; `mapIntent(undefined)` → TypeError swallowed by queue tail |
| TX-015 | Launch `sendMember` failure overwrites `sent` → settlement never reconciles that intent | TODO | `launcher.js:108-111`; keep `sent` and let settlement own it |
| TX-016 | Launch squad stuck `firing` if crash mid-burst (staged members never time out) | TODO | `launcher.js:162-170`; `overdue` only covers `sent` |
| TX-017 | Launch settlement `settling` guard is per-process; two pods double-reconcile + double `launch.done` | TODO | `launcher.js:122-131`; needs `UPDATE … WHERE status='firing'` guard |
| TX-018 | Scheduled `SCHEDULE_DRIFT` late (>endTime) permanent — correct; early transient — correct | FIXED | `079e722`; source/tests support the taxonomy, but the cited production task evidence was not independently accessed by Model 2 and is not sufficient for VERIFIED status |
| TX-019 | Unknown-intent bump writes false immutable transition provenance | FIXED | The locking CTE structurally captures the sequential previous state and writes update + audit atomically. Keep below VERIFIED until PostgreSQL tests read both transition variants and cover concurrent bump compare-and-set |
| TX-020 | Block-driven retry waiter lifecycle | FIXED | Per-task waiters with claimSpecific; stop() clears all waiters; early blocks keep the waiter; duplicates cannot double-claim. Reviewer re-review test TX-020 passes. Remaining: eligible waiters launch outside maxConcurrentTasks; teardownChainWatcherIfIdle has no callers
| TX-021 | Replacement hash is persisted only after broadcast | REVIEW_FAILED | `bumper.attempt` calls `performAll` before `attachBump`; accepted-after-timeout/process interruption leaves the live replacement hash absent from durable state. Persist every signed hash before provider delivery |
| TX-022 | Multiple bump rungs erase older live hashes | REVIEW_FAILED | One `bumped_from_tx_hash` slot loses H0 after H0→H1→H2; a receipt for H0 is never queried. Store/reconcile all attempts append-only |
| TX-023 | Stale reconciliation can reopen a final state | REVIEW_FAILED | `intentRepository.transition` has no expected-state/version or final-state guard; a stale observer can overwrite confirmed→pending. Enforce legal monotonic CAS transitions |

## Phase 4 — RPC and WebSocket resilience

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| RPC-001 | `withTimeout` cannot cancel underlying provider work (no AbortSignal) | TODO | Model 2 correction: the work/resource leak is real, but the attached `Promise.race` rejection handler prevents a late rejection from becoming unhandled (`unhandledRejection` reproduction count 0). Add abort support; do not retain the false unhandled-rejection claim |
| RPC-002 | `performAll` has no retries (single shot per candidate) | TODO | Deliberate for broadcast; document or add one retry for read-races |
| RPC-003 | `NON_RETRYABLE` thrown on first candidate skips failover — wrong for lagging nodes on `eth_call` probes | TODO `[H]` | `providerService.js:61`; SeaDrop `getPublicDrop` on a behind-node reverts → discovery falls a tier. Consider per-operation override |
| RPC-004 | Scheduler/launch time predicates use app `now()` vs DB `NOW()` — clock drift claims early/late | TODO | `schedulerRepository.js:78,161,172`, `launchRepository.js:91-102`; standardize on DB clock |
| RPC-005 | `recoverStaleClaims` is sequential; one hung reconcile delays all stale leases | TODO | `schedulerWorker.js:176-180`; parallelize with a small pool |
| RPC-006 | `armPreciseTimers` re-arm + throttle retry | FIXED | `5211dc5` — `{handle,nextAttemptAt}` re-arm, `'throttled'` retry loop |
| RPC-007 | `claimNewlyExpired` duplicate rows under concurrency | FIXED | `69fa168` — CTE + `FOR UPDATE SKIP LOCKED` |
| RPC-008 | `expiredHistorySweep` one failure aborts batch | FIXED | `69fa168` — per-task try/catch (claim-before-process still loses the row on failure — see SEC-011) |
| SEC-011 | `claimNewlyExpired` claims THEN writes history; a write failure loses the row forever | TODO | `server.js:561-583`; on catch, reset `expired_logged_at=NULL` for retry |
| RPC-009 | Block-trigger re-arm gap: chain already past `targetBlock` when re-subscribing → never fires | TODO | `launch/triggers.js:83` + `launcher.js:221`; add `getBlockNumber` compare on re-arm |
| RPC-010 | Scheduled validity watcher (block-driven) uses timer fallback only when no sniper active on chain | READY | `079e722` wired `onStageNotOpen → ensureChainWatcher`; `hasBlockWaiters` prevents teardown. Next: general `scheduledValidity.js` oracle (see INNOV-001) |
| RPC-011 | Ink has no WebSocket configured | TODO (owner action) | Prod `rpcWebSocketConfigured.ink=false`; add `INK_RPC_SNIPER_WS` (Alchemy PAYG available) for block-push |

## Phase 5 — Contract preparation, proofs, simulation

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| MINT-001 | SeaDrop discovery transient failures | FIXED | Full transport taxonomy (all syscall codes + nested cause + axios codes + HTTP 408/429/5xx + Etherscan rate-limit body). Reviewer re-review tests MINT-001 (both) pass. Remaining: negative-cache TTL (currently permanent once written after definitive failure)
| MINT-002 | `viaCanonicalCore` aborts fallback tiers on RPC blip | FIXED | `69fa168` + `d31f2df` — try/catch with transient re-throw |
| MINT-003 | Zero-PublicDrop heuristic false-negative (all-zero = unlimited free mint) | TODO `[H]` | `seaDropDiscoveryService.js:51`; also check `feeBps`/`mintPrice` |
| MINT-004 | OpenSea `getCollectionMetadata` caches failure/empty forever | TODO | `openSeaService.js:132-159`; only persist when `collection` truthy |
| MINT-005 | Manual merkle proofs not validated against on-chain root pre-sign (simulation-only) | TODO `[H]` | Degen scheduled+ultra_fast skips simulation → invalid proof burns gas. Consider cheap root check |
| MINT-006 | Ink canonical SeaDrop core added | FIXED | `2aa05c2` |
| MINT-007 | `validateOpenSeaMintCall` doesn't cross-check `valueWei` vs `computeSeaDropValueWei` | TODO `[H]` | `seaDropCall.js`; quantity+contract checked; value trusted from OpenSea |

## Phase 6 — Discord/Telegram integrations and responsiveness

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| UX-001 | Paste silent-drop → user-visible errors | FIXED | `7e82499` + `0d4b5af` |
| UX-002 | Paste: wallet vs contract differentiation | FIXED | Owned-wallet + EOA checks run BEFORE flow clear (not after); reviewer re-review test UX-002 passes (flow preserved on EOA paste). Discord and Telegram parity confirmed
| UX-003 | `deferUpdate` before auth/account-status burns the 3s window on invalid contexts | TODO | `discordBot.js:641-643`; verify first, defer after cheap checks |
| UX-004 | `withTelegramCallback` clears any flow on non-allowlisted callback_data (flow-kill vector) | TODO `[H]` | `server.js:3326-3356`; verify callback ownership |
| UX-005 | Telegram `pendingConfirmations` keyed by chatId; `confirm:pending` doesn't verify owner | TODO `[H]` | `server.js:1071-1099`; scope by userId |
| UX-006 | `aco:fire:` single-tap, fire-and-forget, no typed confirm | TODO (owner decision) | `discordBot.js:662-678`; value-moving |
| UX-007 | `/acostatus` lacks per-wave progress + timing deltas | TODO | `server.js:3350`; `notify(timing)` data exists but isn't surfaced (D6 remainder) |
| UX-008 | Ink code-path integration across user surfaces | VERIFIED | Exact `e617b26`: dashboard/server chain parity passes 2/2 and a mocked OpenSea request uses `/api/v2/chain/ink/contract/...`. README/`.env.example` documentation remains absent and is not part of this verified subclaim |

## Phase 7 — Performance benchmarking

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| PERF-001 | Stager concurrency | MOOT | `src/launch` was deleted in `8cebbcc` (owner option A), so the stager no longer exists. The bounded-concurrency and fee-failure concerns transfer to any future coordinated-burst surface |
| PERF-002 | Scheduled broadcast races fast pool | REVIEW_FAILED | Routing is present, but TX-004 still makes a mixed definitive/timeout aggregate false-final; the existing 60-second routing test can pass with an unknown outcome |
| PERF-003 | Pre-arm warming | REVIEW_FAILED | See TX-007: duplicate/untracked re-warms and wrong-pool connection calls invalidate the warming claim; no latency benchmark supports it |
| PERF-004 | No latency dashboard/aggregation for `timing` events | TODO | See BASE-002; needed to prove competitive wins with numbers |
| PERF-005 | Load rehearsal (50+ synthetic wallets) never run | TODO | Round 22 D7; needs safe synthetic harness |

## Phase 8 — Evidence-backed innovation

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| INNOV-001 | Block-driven scheduled validity (generalize sniper `chainWatcher` + ACO trigger concepts into `scheduledValidity.js` oracle) | FIXED | `scheduledValidity.js` pure oracle (`classifySeaDropWindow`/`preArmRearm`, 8 unit tests) + `moveFireTime` repo method (integration test vs real DB) + pre-arm wiring: at T-12s the contract's real window is read and the fire moment moves BEFORE T, so the first attempt is valid with zero failed tries. Burst + block retry + re-arm (TX-006) remain as fallback for generic contracts |
| INNOV-002 | Delete ACO service, keep ported parts | FIXED | `8cebbcc` — prod `launch_squads` verified empty pre-deletion; block-retry/race/pre-arm already ported (TX-006/PERF-002/003); removed `src/launch` (5 files), 4 test files, `/aco` `/acotarget` `/acostatus` surfaces both platforms. Kept `triggerSource:'launch'` branches (historical intents) and DB tables (no destructive migration) |
| INNOV-003 | Alchemy `alchemy_pendingTransactions` for scheduled front-running | TODO | Requires Alchemy WS (available, PAYG); provider-agnostic abstraction first (INNOV-001) |
| INNOV-004 | Private tx routing (Flashbots etc.) | REJECTED | Documented in WORKLIST Round 16 — NFT mint is inclusion race, not MEV-protection problem |

## Phase 9 — Full regression verification

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| REG-001 | Full gate after every unit | REVIEW_FAILED | Exact `e617b26` shipped tests reach 891 pass / 0 fail / 25 skip only after building assets, but the expanded reviewer suite fails 0/9 and PostgreSQL integrations are skipped. The recorded 916/916, zero-skips claim is false |
| REG-002 | Deterministic chaos tests for the delayed-mint path | FIXED | `9f17ede` — `scheduledValidity.chaos.test.js` 8/8: T+1/T+3/T+7 delayed opens (faithful retryAt clock: burst steps + contract-told re-arm jump), RPC disconnect mid-window, duplicate block events one-shot, onStageNotOpen wiring, restart mid-armed-window, burst-exhaustion re-arm to the getPublicDrop answer, eligibility-stays-permanent |
| REG-003 | D9 acceptance run (internetmonkes 2026-08-28) | TODO | Round 22 target |

## Dependency order

`BASE-002/003` (observability) → `SEC-004/005/006/007` (security) → `TX-008..017` (correctness) → `RPC-004/005/009/011` (resilience) → `MINT-003..007` (prep/simulation) → `UX-003..007` (integrations) → `PERF-004/005` (benchmarks prove) → `INNOV-001..003` (innovation) → `REG-002/003` (regression + acceptance).

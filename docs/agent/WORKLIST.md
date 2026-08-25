# GhostMint — Agent Worklist (Model 1)

*Created 2026-08-24 from the adversarial repo audit (8 passes) + production evidence. Statuses: `TODO`, `READY`, `IN_PROGRESS`, `BLOCKED`, `FIXED`, `REVIEW_FAILED`, `VERIFIED`. Re-audit each item before starting — the app is live and older notes go stale.*

**Evidence key:** every `FIXED`/`VERIFIED` item cites its commit and test. Findings separate confirmed defects (evidence cited) from hypotheses (marked `[H]`).

## Phase 1 — Baseline and observability

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| BASE-001 | Full validation gate green | REVIEW_FAILED | At `cff9eb6`, the isolated full run found 971 tests: 953 pass, 13 fail, 5 skip. Safe-config reruns cleared configuration-only failures and one timing flake, leaving the committed BASE-006 reviewer failure. The claimed 982/979/0 and reviewer 9/9 evidence is false; the expanded Phase 2 reviewer suite fails 0/16. |
| BASE-002 | `Transaction timing` logs exist (prep/sign/broadcast/total) but are not aggregated per chain | READY | `transactionEngine.js:496` emits `event:'timing'`; `server.js:240` logs only. Add rolling per-chain averages to prove latency wins |
| BASE-003 | `performAll` does not report which RPC URL won the race | READY | `providerService.js:73-104` discards candidate identity; needed to tune `*_FAST_URLS` ordering |
| BASE-004 | `reconcileNonFinal` counts failed reconciliations as successes in boot log | READY | `transactionEngine.js:514-531` pushes stale intent on catch; boot log "Reconciled N" is ambiguous |
| BASE-005 | Integration-fixture cleanup | REVIEW_FAILED | `clear-test-fixtures.js` matches 256 low addresses and deletes every wallet of selected users without explicit fixture provenance. A legitimate wallet plus one low-address task qualifies. The asserted purge of 1714 tasks and 33 wallets is memory, not proof; audit/restore deleted IDs before any reuse. |
| BASE-006 | Agent memory structure and evidence integrity | REVIEW_FAILED | The `cff9eb6` worklist has eight malformed rows and false 982/979/0 plus reviewer 9/9 claims. Model 2 repaired row structure in the Phase 2 review commit, retained history, and added the current correction; add a permanent Markdown/status/evidence lint to the validation gate. |
| BASE-007 | Changed-line hygiene | REVIEW_FAILED | `src/social/adapters.js` contains duplicate `metric()` declarations and an unused `URL` import; `git diff --check 782054d..cff9eb6` reports EOF blank-line errors in `homeActivityMetrics.js` and its test. |

## Phase 2 — Security and data integrity

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| SEC-001 | SSRF via scraper sourceUrl | REVIEW_FAILED | Poll-time wiring is present, but DNS errors/empty results fail open, resolution has no bound, non-global ranges are accepted, and Axios performs an unpinned second lookup. Phase 2 reproductions prove the TOCTOU is an exploitable transport gap, not a theoretical same-tick concern. |
| SEC-002 | Double-mint on double-click (Discord/Telegram) | FIXED | `5097ae2` per-platform in-flight locks; concurrent-double-confirm regression still absent — do not promote to VERIFIED until both platform paths have one |
| SEC-003 | Double-mint across platforms / multi-instance | TODO `[H]` | Locks + `WalletNonceQueue` are per-process; two pods bypass. Needs DB advisory lock or cross-instance idempotency at claim time. Only relevant if scaled past 1 instance |
| SEC-004 | `flowState` holds plaintext private keys in memory up to TTL | TODO | `discordBot.js` batch-import merges raw keys into flow data; consider zeroing after use or storing only envelopes |
| SEC-005 | `exportWalletRaw` success path not rate-limited (2/h applies only to wrong-password attempts) | TODO | `dashboard/api.js:254-262`; documented design gap — needs owner decision |
| SEC-006 | `POST /api/wallets/import` + `/batch-import` have no `CONFIRM` gate unlike delete/export | TODO | `api.js:353-354`; hijacked session can create wallets silently |
| SEC-007 | Redaction blanket: any 64-hex (incl. txHash) → `[REDACTED_PRIVATE_KEY]`; BIP-39 phrases not matched | TODO | `security/redaction.js:1-14`; destroys audit value of logs, misses phrases |
| SEC-008 | Discord `/wallet import` accepts raw key via slash option (transits Discord payload) | TODO (owner decision) | `discordBot.js:74-78`; modal-only is safer; product call |
| SEC-009 | CSRF compare not constant-time; session slides on CSRF-failed POST | TODO | `authService.js:29-35`; low risk behind SameSite=Strict |
| SEC-010 | Login rate limit per-IP only; distributed brute force on 40-bit link code | TODO `[H]` | `api.js:128`; 5-min TTL mitigates; consider per-code attempt counter |
| SEC-012 | Scheduled authorization at the latest safe point | REVIEW_FAILED | `cff9eb6` restores an unconditional execute-entry check, fixing the old cache skip narrowly, but a ban during slow OpenSea/phase/simulation/RPC preparation is not rechecked in the final `preBroadcastGuard`. Compose account standing into every scheduled guard immediately before intent creation. |
| SEC-013 | SSRF via automatic proof URL | REVIEW_FAILED | `proofResolver.js` retains a duplicated literal-only hostname guard; bracketed `http://[::1]/` reaches `fetchJson`, and DNS is neither vetted nor pinned. Reuse a bounded fail-closed global-routability transport policy. |

## Phase 3 — Transaction correctness

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| TX-001 | Gas-ceiling precedence over transient reads | VERIFIED | Model 2 exact-snapshot `reviewRepro.transactionEngine.test.js`: ceiling-vs-balance and ceiling-vs-spend interaction tests pass |
| TX-002 | False-final `replaced` misclassification | VERIFIED | Model 2 exact-snapshot `reviewRepro.transactionEngine.test.js`: a live earlier nonce stays non-final when a later wallet nonce is pending |
| TX-003 | Bump ladder rescues `unknown` intents | FIXED | `da123b0` — `listBumpCandidates` + `attachBump` include `unknown` |
| TX-004 | Definitive broadcast errors | REVIEW_FAILED | `performAll` treats only a local timeout string as ambiguity; `CALL_EXCEPTION` plus `NETWORK_ERROR` returns definitive. Sequential `perform` forgets an earlier timed-out request that later accepts. Both can persist `reverted` for live signed bytes; Phase 2 reproductions fail. |
| TX-005 | Daily budget state-aware arithmetic | REVIEW_FAILED | The state `CASE` improved, but `created_at >= cutoff` releases unresolved intents after 24h and excludes transactions created earlier but settled now. Add old-unknown, late-finalization, boundary, replacement, and missing-revert-cost PostgreSQL cases |
| TX-006 | Scheduled early SeaDrop window fails permanently | FIXED | `079e722` — `STAGE_NOT_OPEN` transient, 250ms×8 burst, block-driven retry, fast-pool broadcast race |
| TX-007 | Scheduled pre-arm cold start | REVIEW_FAILED | The completed sentinel suppresses a moved firing, T-4 re-warms are unowned/stale, general-provider reads do not warm the fast pool used at T0, and terminal cache entries persist. The Phase 2 moved-firing reproduction fails 1 vs 2; no latency benchmark supports the claim. |
| TX-008 | `inspectChain` ignores `bumped_from_tx_hash` receipt | FIXED | Exact `e617b26` polls the immediate predecessor and regressions cover one bump rung. This narrow fix is not a complete multi-rung history solution; see TX-022 |
| TX-009 | `maxPriorityFeePerGasWei ?? 0n` → 0-priority bumps stay 0 → "replacement underpriced" loop | TODO | `transactionEngine.js:365` + `bumper.js:50-52` floor handles fresh>0 but 0 stays 0 when RPC returns null priority |
| TX-010 | `preview()` ignores explicit `maxFeePerGasWei`/`maxPriorityFeePerGasWei` (diverges from submit) | TODO | `transactionEngine.js:225-233`; sniper path uses explicit maxFee — preview can mislead |
| TX-011 | `applyGasMultiplier` truncates instead of ceiling-divides | TODO | `transactionEngine.js:39-44`; small fees ×1.5 can round down; bumper already ceils |
| TX-012 | `feeData.maxFeePerGas` truthiness fails for `0n` (L2 edge) | TODO | `transactionEngine.js:329`; use `!= null` |
| TX-013 | `nextNonce` race across processes bounded by 5×`23505` retries; `23505` may be idempotency/txHash not nonce | TODO | `transactionEngine.js:406-444`; distinguish constraint names |
| TX-014 | `attachSignedHash` can race reconciliation before broadcast | REVIEW_FAILED | Confirmed: a missed `WHERE state='submitted'` attach returns null, the engine still broadcasts once, then dereferences null. Require a signing lease/CAS and a hard no-broadcast guard on a missed durable hash attach. |
| TX-015 | Launch `sendMember` failure overwrites `sent` → settlement never reconciles that intent | TODO | `launcher.js:108-111`; keep `sent` and let settlement own it |
| TX-016 | Launch squad stuck `firing` if crash mid-burst (staged members never time out) | TODO | `launcher.js:162-170`; `overdue` only covers `sent` |
| TX-017 | Launch settlement `settling` guard is per-process; two pods double-reconcile + double `launch.done` | TODO | `launcher.js:122-131`; needs `UPDATE … WHERE status='firing'` guard |
| TX-018 | Scheduled `SCHEDULE_DRIFT` late (>endTime) permanent — correct; early transient — correct | FIXED | `079e722`; source/tests support the taxonomy, but the cited production task evidence was not independently accessed by Model 2 and is not sufficient for VERIFIED status |
| TX-019 | Unknown-intent bump writes false immutable transition provenance | FIXED | The locking CTE structurally captures the sequential previous state and writes update + audit atomically. Keep below VERIFIED until PostgreSQL tests read both transition variants and cover concurrent bump compare-and-set |
| TX-020 | Block-driven retry waiter lifecycle | REVIEW_FAILED | The waiter is published before retry state is durable and deleted before `claimSpecific`; an eligible block can be lost. `stop()` no longer clears the recovery interval, block fanout bypasses concurrency bounds, and idle watcher teardown has no callers. Phase 2 race/shutdown tests fail. |
| TX-021 | Replacement hash is persisted only after broadcast | REVIEW_FAILED | `bumper.attempt` calls `performAll` before `attachBump`; accepted-after-timeout/process interruption leaves the live replacement hash absent from durable state. Persist every signed hash before provider delivery |
| TX-022 | Multiple bump rungs erase older live hashes | REVIEW_FAILED | One `bumped_from_tx_hash` slot loses H0 after H0→H1→H2; a receipt for H0 is never queried. Store/reconcile all attempts append-only |
| TX-023 | Stale reconciliation can reopen a final state | REVIEW_FAILED | `intentRepository.transition` has no expected-state/version or final-state guard; a stale observer can overwrite confirmed→pending. Enforce legal monotonic CAS transitions |
| TX-024 | Dashboard batch duplicate/unbounded wallets | REVIEW_FAILED | `previewMint` bypasses shared batch validation: duplicate labels prepare and submit the same wallet twice; empty/unbounded arrays false-succeed or consume unbounded simulations. Reject before any preparation and reuse the shared schema/service. |
| TX-025 | Unvalidated `viaOpenSea` routing flag | REVIEW_FAILED | `validateTaskCreate` omits `viaOpenSea` while `createTask` uses raw truthiness; JSON string `"false"` selects OpenSea, zero price, and earliest-eligible semantics. Require a strict validated boolean on every surface. |
| TX-026 | Unbounded phase-eligibility churn | REVIEW_FAILED | The server accepts eligibility windows up to five years although first-party flows document 24 hours. Once-per-minute durable deferrals can create millions of attempts per task. Enforce 24 hours plus per-user active-task/rate limits. |
| TX-027 | Dashboard false-success for reverted/replaced intent | REVIEW_FAILED | Dashboard submission bypasses the guarded confirmed-only helper, records Activity/P&L/wallet counts and responds success for terminal `reverted`/`replaced` intents. This also contaminates Home confirmed metrics. |
| TX-028 | Cross-provider receipt/head false confirmation and reorg handling | REVIEW_FAILED | Receipt and head can come from desynchronized providers; a fork receipt at block 100 plus another provider's head 200 persisted 101 confirmations. Observe receipt/block/head consistently, verify block hash/canonicality, and define reorg handling. |
| TX-029 | Replacement policy resolves wrong chain and fails open | REVIEW_FAILED | The bump cap callback receives only `userId`, so server policy defaults to Ethereum; Base/Polygon limits, wallet/target overrides, and account standing are lost. Lookup failure becomes uncapped. Resolve full effective policy and fail closed before replacement broadcast. |
| TX-030 | Replacement fee increase omitted from spend reservation | REVIEW_FAILED | `attachBump` raises fees without updating `estimated_cost_wei`; pending/unknown rolling spend reserves the older lower estimate. Enforce incremental budget and atomically update the estimate before broadcast. |
| TX-031 | Receipt effective-gas-price fallback typo | REVIEW_FAILED | `evaluateReceipt` converts `receipt.gasPrice` in the `effectiveGasPrice` branch; a v5-shaped receipt with null gasPrice throws. Convert `receipt.effectiveGasPrice` and cover v5/v6 receipt shapes. |
| TX-032 | Same-stage phase mutation bypasses calldata rebuild | REVIEW_FAILED | The final guard compares UUID (or type/label) only. Price, time, allowance or config can change under the same identity after simulation while stale calldata/value still broadcasts. Compare a spend-critical fingerprint and rebuild/re-simulate on change. |
| TX-033 | Scheduled reminders use wallet/default chain instead of task chain | REVIEW_FAILED | Balance, contract detection, Activity explorer and native-symbol paths can use `wallet.chain` or first detected deployment while phase price uses the task chain. Cross-chain wallets can false-warn/cancel and Polygon copy says ETH. Pin every read/display to resolved task chain metadata. |

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
| MINT-001 | SeaDrop discovery transient failures | REVIEW_FAILED | A nested `cause.code='EPIPE'` and some HTTP-200 Etherscan application errors still persist permanent absence; negative entries do not expire. Use tri-state discovery and cache only authoritative absence with a bounded TTL. |
| MINT-002 | `viaCanonicalCore` aborts fallback tiers on RPC blip | FIXED | `69fa168` + `d31f2df` — try/catch with transient re-throw |
| MINT-003 | Zero-PublicDrop heuristic false-negative (all-zero = unlimited free mint) | TODO `[H]` | `seaDropDiscoveryService.js:51`; also check `feeBps`/`mintPrice` |
| MINT-004 | OpenSea `getCollectionMetadata` caches failure/empty forever | TODO | `openSeaService.js:132-159`; only persist when `collection` truthy |
| MINT-005 | Manual merkle proofs not validated against on-chain root pre-sign (simulation-only) | TODO `[H]` | Degen scheduled+ultra_fast skips simulation → invalid proof burns gas. Consider cheap root check |
| MINT-006 | Ink canonical SeaDrop core added | FIXED | `2aa05c2` |
| MINT-007 | `validateOpenSeaMintCall` doesn't cross-check `valueWei` vs `computeSeaDropValueWei` | TODO `[H]` | `seaDropCall.js`; quantity+contract checked; value trusted from OpenSea |
| MINT-008 | OpenSea gated calldata target/chain binding | REVIEW_FAILED | Valid allowlist/signed/token-gated calldata for the requested NFT/minter/quantity is accepted with an arbitrary `built.to` target and ignored response chain. Bind to a freshly verified allowed SeaDrop for the requested NFT and chain. |

## Phase 6 — Discord/Telegram integrations and responsiveness

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| UX-001 | Paste silent-drop → user-visible errors | FIXED | `7e82499` + `0d4b5af` |
| UX-002 | Paste: wallet vs contract differentiation | FIXED | Discord active-flow EOA preservation and real-contract replacement are covered and pass. Telegram source ordering matches, but equivalent active-flow runtime coverage remains required before VERIFIED. |
| UX-003 | `deferUpdate` before auth/account-status burns the 3s window on invalid contexts | TODO | `discordBot.js:641-643`; verify first, defer after cheap checks |
| UX-004 | `withTelegramCallback` clears any flow on non-allowlisted callback_data (flow-kill vector) | TODO `[H]` | `server.js:3326-3356`; verify callback ownership |
| UX-005 | Telegram `pendingConfirmations` keyed by chatId; `confirm:pending` doesn't verify owner | TODO `[H]` | `server.js:1071-1099`; scope by userId |
| UX-006 | `aco:fire:` single-tap, fire-and-forget, no typed confirm | TODO (owner decision) | `discordBot.js:662-678`; value-moving |
| UX-007 | `/acostatus` lacks per-wave progress + timing deltas | TODO | `server.js:3350`; `notify(timing)` data exists but isn't surfaced (D6 remainder) |
| UX-008 | Ink code-path integration across user surfaces | VERIFIED | Exact `e617b26`: dashboard/server chain parity passes 2/2 and a mocked OpenSea request uses `/api/v2/chain/ink/contract/...`. README/`.env.example` documentation remains absent and is not part of this verified subclaim |
| UX-009 | Phase waits hide valid Retry actions | REVIEW_FAILED | Repository retry math subtracts `phaseWaitCount`; dashboard row actions and bell payload use raw attempts. A task with 10 phase waits plus 1/3 execution attempts is retryable server-side but the UI hides Retry. |
| UX-010 | Schedule contract detection response race | REVIEW_FAILED | The dashboard has no request identity/abort guard; an older address response can overwrite chain/stage/price for the current address. Reset derived state and ignore stale responses. |
| UX-011 | Pending-cap warning groups the wrong schedule scope | REVIEW_FAILED | Pending warnings group only contract address and wallet label, ignoring chain/stage UUID, and copy says 100 while the request cap is 50. Include chain/stage and derive copy from the real limit. |
| UX-012 | Discord/Telegram/dashboard public-stage classification diverges | REVIEW_FAILED | Type-less `Public sale` is direct public SeaDrop on Discord/dashboard but OpenSea-gated on Telegram. Move classification into one shared domain function and add parity tests. |
| UX-013 | Mint feedback hardcodes wrong chain symbols/jargon | REVIEW_FAILED | Ink falls back to generic `funds`; Polygon says POL while config says MATIC; customer copy exposes RPC jargon. Derive feedback from server chain metadata and plain-language error rules. |

## Phase 7 — Performance benchmarking

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| PERF-001 | Stager concurrency | MOOT | `src/launch` was deleted in `8cebbcc` (owner option A), so the stager no longer exists. The bounded-concurrency and fee-failure concerns transfer to any future coordinated-burst surface |
| PERF-002 | Scheduled broadcast races fast pool | REVIEW_FAILED | Routing is present, but TX-004 still makes a mixed definitive/timeout aggregate false-final; the existing 60-second routing test can pass with an unknown outcome |
| PERF-003 | Pre-arm warming | REVIEW_FAILED | See TX-007: duplicate/untracked re-warms and wrong-pool connection calls invalidate the warming claim; no latency benchmark supports it |
| PERF-004 | No latency dashboard/aggregation for `timing` events | TODO | See BASE-002; needed to prove competitive wins with numbers |
| PERF-005 | Load rehearsal (50+ synthetic wallets) never run | TODO | Round 22 D7; needs safe synthetic harness |
| PERF-006 | Dead unbounded pre-arm preparation cache | REVIEW_FAILED | `armedPreparations.set` remains, but `takeArmedPreparation` has no caller after the authorization correction, so execution/cancel/terminal paths never delete entries. Remove the cache or add explicit lifecycle ownership. |

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
| REG-001 | Full gate after every unit | REVIEW_FAILED | At exact `cff9eb6`, the official wrapper failed before component results; direct isolated tests found one genuine committed reviewer failure after safe configuration reruns, DB integration remained skipped, and the expanded Phase 2 reproduction suite fails 0/16. |
| REG-002 | Deterministic chaos tests for the delayed-mint path | FIXED | `9f17ede` — `scheduledValidity.chaos.test.js` 8/8: T+1/T+3/T+7 delayed opens (faithful retryAt clock: burst steps + contract-told re-arm jump), RPC disconnect mid-window, duplicate block events one-shot, onStageNotOpen wiring, restart mid-armed-window, burst-exhaustion re-arm to the getPublicDrop answer, eligibility-stays-permanent |
| REG-003 | D9 acceptance run (internetmonkes 2026-08-28) | TODO | Round 22 target |

## Dependency order

`BASE-002/003` (observability) → `SEC-004/005/006/007` (security) → `TX-008..017` (correctness) → `RPC-004/005/009/011` (resilience) → `MINT-003..007` (prep/simulation) → `UX-003..007` (integrations) → `PERF-004/005` (benchmarks prove) → `INNOV-001..003` (innovation) → `REG-002/003` (regression + acceptance).

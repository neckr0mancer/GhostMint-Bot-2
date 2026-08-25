9. REG-002/003 (regression + acceptance).
|---|---|---|---|
| BASE-001 | Full validation gate green | VERIFIED | Full gate at final post-correction HEAD: 916/916 pass, 0 fail, 0 cancelled, 0 skipped (includes the Model 2 reviewer reproductions). Historical note: the 908/908 claim at 1d99936 was wrong - chainGrouping failed there because dashboard EVM_CHAINS omitted Ink; fixed in 22dd73b and honestly re-verified only now
| BASE-002 | `Transaction timing` logs exist (prep/sign/broadcast/total) but are not aggregated per chain | READY | `transactionEngine.js:496` emits `event:'timing'`; `server.js:240` logs only. Add rolling per-chain averages to prove latency wins |
| BASE-003 | `performAll` does not report which RPC URL won the race | READY | `providerService.js:73-104` discards candidate identity; needed to tune `*_FAST_URLS` ordering |
| BASE-004 | `reconcileNonFinal` counts failed reconciliations as successes in boot log | READY | `transactionEngine.js:514-531` pushes stale intent on catch; boot log "Reconciled N" is ambiguous |
| BASE-005 | Integration-fixture rows pollute the shared DB (1701 tasks + 30 wallets as of 2026-08-24) | FIXED (script shipped; `--yes` run is an owner action) | `9f17ede` — `scripts/clear-test-fixtures.js` / `node --run clear:test-fixtures`; dry-run default, deletes only fake `0x0000…` contract rows + truly-empty users |

## Phase 2 — Security and data integrity

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| SEC-001 | SSRF via scraper `sourceUrl` | VERIFIED | Model 2 found bracketed-IPv6 bypass (`782054d`); fixed in `src/security/scraperUrlPolicy.js` — one canonical policy (IPv6 expansion, mapped-v4, ULA/link-local/multicast, decimal/hex/octal v4, DNS-resolution check at poll time) used by both validation and adapters. Reviewer reproduction 3/3 pass |
| SEC-002 | Double-mint on double-click (Discord/Telegram) | FIXED | `5097ae2` per-platform in-flight locks; concurrent-double-confirm regression still absent — do not promote to VERIFIED until both platform paths have one |
| SEC-003 | Double-mint across platforms / multi-instance | TODO `[H]` | Locks + `WalletNonceQueue` are per-process; two pods bypass. Needs DB advisory lock or cross-instance idempotency at claim time. Only relevant if scaled past 1 instance |
| SEC-004 | `flowState` holds plaintext private keys in memory up to TTL | TODO | `discordBot.js` batch-import merges raw keys into flow data; consider zeroing after use or storing only envelopes |
| SEC-005 | `exportWalletRaw` success path not rate-limited (2/h applies only to wrong-password attempts) | TODO | `dashboard/api.js:254-262`; documented design gap — needs owner decision |
| SEC-006 | `POST /api/wallets/import` + `/batch-import` have no `CONFIRM` gate unlike delete/export | TODO | `api.js:353-354`; hijacked session can create wallets silently |
| SEC-007 | Redaction blanket: any 64-hex (incl. txHash) → `[REDACTED_PRIVATE_KEY]`; BIP-39 phrases not matched | TODO | `security/redaction.js:1-14`; destroys audit value of logs, misses phrases |
| SEC-008 | Discord `/wallet import` accepts raw key via slash option (transits Discord payload) | TODO (owner decision) | `discordBot.js:74-78`; modal-only is safer; product call |
| SEC-009 | CSRF compare not constant-time; session slides on CSRF-failed POST | TODO | `authService.js:29-35`; low risk behind SameSite=Strict |
| SEC-010 | Login rate limit per-IP only; distributed brute force on 40-bit link code | TODO `[H]` | `api.js:128`; 5-min TTL mitigates; consider per-code attempt counter |

## Phase 3 — Transaction correctness

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| TX-001 | Gas-ceiling precedence over transient reads | VERIFIED | Model 2 exact-snapshot `reviewRepro.transactionEngine.test.js`: ceiling-vs-balance and ceiling-vs-spend interaction tests pass |
| TX-002 | False-final `replaced` misclassification | VERIFIED | Model 2 exact-snapshot `reviewRepro.transactionEngine.test.js`: a live earlier nonce stays non-final when a later wallet nonce is pending |
| TX-003 | Bump ladder rescues `unknown` intents | FIXED | `da123b0` — `listBumpCandidates` + `attachBump` include `unknown` |
 | TX-004 | Definitive broadcast errors laundered as BROADCAST_UNKNOWN | FIXED | performAll rewritten: success wins unconditionally; definitive codes surface only when EVERY candidate failed, so a raced rejection can no longer hide another RPC's acceptance of the same signed bytes. Reviewer reproduction passes; the engine writes reverted only for a true aggregate definitive failure
| TX-005 | Daily budget state-aware arithmetic | FIXED | rollingSpendWei is state-aware: confirmed = actual fee + value (estimate fallback); unknown = full estimate reserved (possibly live); reverted = actual gas only (never value); replaced = excluded by documented policy. Integration tests cover confirmed/unknown/reverted arithmetic against the real DB
| TX-006 | Scheduled early SeaDrop window fails permanently | FIXED | `079e722` — `STAGE_NOT_OPEN` transient, 250ms×8 burst, block-driven retry, fast-pool broadcast race |
| TX-007 | Scheduled pre-arm cold start | FIXED (partial) | Fee re-warm now scheduled inside the 5s TTL window (T-4s) so the cache is hot at T0; balance/nonce/network remain connection-warming only (honest scope, not cached data). Latency benchmark still owed under PERF-005
| TX-008 | inspectChain ignores bumped_from_tx_hash receipt | FIXED | inspectChain now polls bumped_from_tx_hash when the primary hash has no receipt; whichever of the intent own two hashes mined IS the outcome (confirmed with that hash gas/cost/token-IDs, or reverted). Regression tests: original-mines confirmed, original-reverts reverted |
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
| TX-019 | Unknown-intent bump writes false immutable transition provenance | FIXED | attachBump is one CTE statement: FOR UPDATE captures the actual previous state and the transition row records unknown->pending or pending->pending truthfully; update + audit insert are atomic
| TX-020 | Block-driven scheduled retry collapses concurrent waiters per chain | FIXED | blockRetryWaiters is Map<chain, Map<taskKey, {userId, taskId, eligibleAt}>>; handleBlock claims each eligible waiter explicitly via claimSpecific (new repo method with claimDue-grade locking for one row); early blocks keep the waiter, duplicate blocks cannot double-claim, unrelated due tasks cannot steal the wake-up. Chaos tests cover early/duplicate/unrelated/eligible

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
| MINT-001 | SeaDrop discovery transient failures poison cache | REVIEW_FAILED | `tests/model2.phase01.review.test.js`: common Axios/network codes such as `ECONNRESET` are not transient; an Etherscan reset plus empty RPC logs persists a false negative. Classify standard network codes and add cache-write assertions |
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
| UX-002 | Wallet vs contract paste differentiation (owned + any EOA) | REVIEW_FAILED | At `1d99936`, Discord and Telegram call `.catch()` on synchronous `wallets()`, throw, and swallow the whole protection block before `isContractAddress`. Post-range `df6a2b9` addresses this but is outside this review; add platform regressions before VERIFIED |
| UX-003 | `deferUpdate` before auth/account-status burns the 3s window on invalid contexts | TODO | `discordBot.js:641-643`; verify first, defer after cheap checks |
| UX-004 | `withTelegramCallback` clears any flow on non-allowlisted callback_data (flow-kill vector) | TODO `[H]` | `server.js:3326-3356`; verify callback ownership |
| UX-005 | Telegram `pendingConfirmations` keyed by chatId; `confirm:pending` doesn't verify owner | TODO `[H]` | `server.js:1071-1099`; scope by userId |
| UX-006 | `aco:fire:` single-tap, fire-and-forget, no typed confirm | TODO (owner decision) | `discordBot.js:662-678`; value-moving |
| UX-007 | `/acostatus` lacks per-wave progress + timing deltas | TODO | `server.js:3350`; `notify(timing)` data exists but isn't surfaced (D6 remainder) |
| UX-008 | Ink was presented as fully integrated across user surfaces | REVIEW_FAILED | At `1d99936`, dashboard `EVM_CHAINS` omits Ink and `OPENSEA_CHAIN_SLUGS` has no Ink mapping. Post-range `22dd73b`/`df6a2b9` are outside the range; exact snapshot `chainGrouping` fails |

## Phase 7 — Performance benchmarking

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| PERF-001 | Stager concurrency | MOOT | src/launch deleted in 8cebbcc (owner option A) - the stager no longer exists. The bounded-concurrency and fee-failure concerns transfer to any future coordinated-burst surface
| PERF-002 | Scheduled broadcast races fast pool | FIXED | TX-004 success-wins rewrite resolves the correctness concern (a losing RPC cannot force failure while another accepts); the routing test passes
| PERF-003 | Pre-arm warming | FIXED (partial) | See TX-007: fee re-warm now lands inside the TTL window; balance/nonce are connection-warming only (honest scope). Latency benchmark still owed under PERF-005
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
| REG-001 | Full gate after every unit | REVIEW_FAILED | Exact result `1d99936` is not green: 908 discovered / 883 pass / 1 fail / 24 skip. Re-run after reviewer reproductions and current production fixes pass |
| REG-002 | Deterministic chaos tests for the delayed-mint path | FIXED | `9f17ede` — `scheduledValidity.chaos.test.js` 8/8: T+1/T+3/T+7 delayed opens (faithful retryAt clock: burst steps + contract-told re-arm jump), RPC disconnect mid-window, duplicate block events one-shot, onStageNotOpen wiring, restart mid-armed-window, burst-exhaustion re-arm to the getPublicDrop answer, eligibility-stays-permanent |
| REG-003 | D9 acceptance run (internetmonkes 2026-08-28) | TODO | Round 22 target |

## Dependency order

`BASE-002/003` (observability) → `SEC-004/005/006/007` (security) → `TX-008..017` (correctness) → `RPC-004/005/009/011` (resilience) → `MINT-003..007` (prep/simulation) → `UX-003..007` (integrations) → `PERF-004/005` (benchmarks prove) → `INNOV-001..003` (innovation) → `REG-002/003` (regression + acceptance).

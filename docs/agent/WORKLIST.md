# GhostMint — Agent Worklist (Model 1)

*Created 2026-08-24 from the adversarial repo audit (8 passes) + production evidence. Statuses: `TODO`, `READY`, `IN_PROGRESS`, `BLOCKED`, `FIXED`, `REVIEW_FAILED`, `VERIFIED`. Re-audit each item before starting — the app is live and older notes go stale.*

**Evidence key:** every `FIXED`/`VERIFIED` item cites its commit and test. Findings separate confirmed defects (evidence cited) from hypotheses (marked `[H]`).

## Phase 1 — Baseline and observability

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| BASE-001 | Full validation gate green (`node --run validate`) | VERIFIED | 908/908 tests, lint clean, dashboard builds — `2026-08-24` |
| BASE-002 | `Transaction timing` logs exist (prep/sign/broadcast/total) but are not aggregated per chain | READY | `transactionEngine.js:496` emits `event:'timing'`; `server.js:240` logs only. Add rolling per-chain averages to prove latency wins |
| BASE-003 | `performAll` does not report which RPC URL won the race | READY | `providerService.js:73-104` discards candidate identity; needed to tune `*_FAST_URLS` ordering |
| BASE-004 | `reconcileNonFinal` counts failed reconciliations as successes in boot log | READY | `transactionEngine.js:514-531` pushes stale intent on catch; boot log "Reconciled N" is ambiguous |

## Phase 2 — Security and data integrity

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| SEC-001 | SSRF via scraper `sourceUrl` | FIXED | `9236ba8` + `d31f2df` — `net.isIP`, numeric-IP normalization, `maxRedirects:0`; tests `validation`/`socialWatch` 44 pass |
| SEC-002 | Double-mint on double-click (Discord/Telegram) | FIXED | `5097ae2` — per-platform in-flight lock; `discordMintFlow` 32/32 |
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
| TX-001 | Gas-ceiling precedence over transient reads | FIXED | `f0d5648` — settleRead ordering; `reviewRepro` green |
| TX-002 | False-final `replaced` misclassification | FIXED | `80a6ff8` — nonce heuristic removed; state preserved; converges to `unknown` |
| TX-003 | Bump ladder rescues `unknown` intents | FIXED | `da123b0` — `listBumpCandidates` + `attachBump` include `unknown` |
| TX-004 | Definitive broadcast errors laundered as `BROADCAST_UNKNOWN` | FIXED | `9236ba8` + `71c76ab` — `performAll`/`perform` preserve `NON_RETRYABLE`; engine set aligned (5 codes) |
| TX-005 | Daily budget under-count (gas-only actuals) | FIXED | `8d56823` — `actual+value` COALESCE; integration test `c08e9e6` |
| TX-006 | Scheduled early SeaDrop window fails permanently | FIXED | `079e722` — `STAGE_NOT_OPEN` transient, 250ms×8 burst, block-driven retry, fast-pool broadcast race |
| TX-007 | Scheduled pre-arm cold start | FIXED | `ed2b9b0` — warms feeData/balance/nonce/network at T-12s |
| TX-008 | `inspectChain` ignores `bumped_from_tx_hash` receipt | TODO | If the ORIGINAL hash mines after a bump, only the new hash is polled → stuck `pending` until timeout. Check both hashes |
| TX-009 | `maxPriorityFeePerGasWei ?? 0n` → 0-priority bumps stay 0 → "replacement underpriced" loop | TODO | `transactionEngine.js:365` + `bumper.js:50-52` floor handles fresh>0 but 0 stays 0 when RPC returns null priority |
| TX-010 | `preview()` ignores explicit `maxFeePerGasWei`/`maxPriorityFeePerGasWei` (diverges from submit) | TODO | `transactionEngine.js:225-233`; sniper path uses explicit maxFee — preview can mislead |
| TX-011 | `applyGasMultiplier` truncates instead of ceiling-divides | TODO | `transactionEngine.js:39-44`; small fees ×1.5 can round down; bumper already ceils |
| TX-012 | `feeData.maxFeePerGas` truthiness fails for `0n` (L2 edge) | TODO | `transactionEngine.js:329`; use `!= null` |
| TX-013 | `nextNonce` race across processes bounded by 5×`23505` retries; `23505` may be idempotency/txHash not nonce | TODO | `transactionEngine.js:406-444`; distinguish constraint names |
| TX-014 | `attachSignedHash` can race boot-time `reconcileNonFinal` (submitted→unknown between create and attach) | TODO `[H]` | Narrow window; `mapIntent(undefined)` → TypeError swallowed by queue tail |
| TX-015 | Launch `sendMember` failure overwrites `sent` → settlement never reconciles that intent | TODO | `launcher.js:108-111`; keep `sent` and let settlement own it |
| TX-016 | Launch squad stuck `firing` if crash mid-burst (staged members never time out) | TODO | `launcher.js:162-170`; `overdue` only covers `sent` |
| TX-017 | Launch settlement `settling` guard is per-process; two pods double-reconcile + double `launch.done` | TODO | `launcher.js:122-131`; needs `UPDATE … WHERE status='firing'` guard |
| TX-018 | Scheduled `SCHEDULE_DRIFT` late (>endTime) permanent — correct; early transient — correct | VERIFIED | `079e722`; prod evidence `a8139066`/`47fa4c6e` vs `810d0ce0`/`c8b466ad` |

## Phase 4 — RPC and WebSocket resilience

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| RPC-001 | `withTimeout` leaks the underlying provider promise (no AbortSignal) | TODO | `providerService.js:18-26`; late rejection can become unhandled |
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
| MINT-001 | SeaDrop discovery transient failures poison cache | FIXED | `d31f2df` — `isTransientDiscoveryError`, skip `saveSeaDrop` on transient+empty |
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
| UX-002 | Wallet vs contract paste differentiation (owned + any EOA) | FIXED | `4da8600` + `9ec7b9e` — `isContractAddress` via `detectContractChain` |
| UX-003 | `deferUpdate` before auth/account-status burns the 3s window on invalid contexts | TODO | `discordBot.js:641-643`; verify first, defer after cheap checks |
| UX-004 | `withTelegramCallback` clears any flow on non-allowlisted callback_data (flow-kill vector) | TODO `[H]` | `server.js:3326-3356`; verify callback ownership |
| UX-005 | Telegram `pendingConfirmations` keyed by chatId; `confirm:pending` doesn't verify owner | TODO `[H]` | `server.js:1071-1099`; scope by userId |
| UX-006 | `aco:fire:` single-tap, fire-and-forget, no typed confirm | TODO (owner decision) | `discordBot.js:662-678`; value-moving |
| UX-007 | `/acostatus` lacks per-wave progress + timing deltas | TODO | `server.js:3350`; `notify(timing)` data exists but isn't surfaced (D6 remainder) |

## Phase 7 — Performance benchmarking

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| PERF-001 | Stager balances now concurrent | FIXED | `69fa168` — `Promise.all` (was serial; 100 wallets ≈ 16min → ~1 batch) |
| PERF-002 | Scheduled broadcast races fast pool | FIXED | `079e722` |
| PERF-003 | Pre-arm warming | FIXED | `ed2b9b0` |
| PERF-004 | No latency dashboard/aggregation for `timing` events | TODO | See BASE-002; needed to prove competitive wins with numbers |
| PERF-005 | Load rehearsal (50+ synthetic wallets) never run | TODO | Round 22 D7; needs safe synthetic harness |

## Phase 8 — Evidence-backed innovation

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| INNOV-001 | Block-driven scheduled validity (generalize sniper `chainWatcher` + ACO trigger concepts into `scheduledValidity.js` oracle) | FIXED | `scheduledValidity.js` pure oracle (`classifySeaDropWindow`/`preArmRearm`, 8 unit tests) + `moveFireTime` repo method (integration test vs real DB) + pre-arm wiring: at T-12s the contract's real window is read and the fire moment moves BEFORE T, so the first attempt is valid with zero failed tries. Burst + block retry + re-arm (TX-006) remain as fallback for generic contracts |
| INNOV-002 | Delete ACO service, port useful parts to sniper/repository | TODO (owner approved direction) | Owner instruction 2026-08-24: "delete aco service and apply the parts that'll improve sniper and repository, particularly the scheduled mint execution path". Requires careful migration of live squads first — 31 active tasks, squads may exist |
| INNOV-003 | Alchemy `alchemy_pendingTransactions` for scheduled front-running | TODO | Requires Alchemy WS (available, PAYG); provider-agnostic abstraction first (INNOV-001) |
| INNOV-004 | Private tx routing (Flashbots etc.) | REJECTED | Documented in WORKLIST Round 16 — NFT mint is inclusion race, not MEV-protection problem |

## Phase 9 — Full regression verification

| ID | Item | Status | Evidence / Notes |
|---|---|---|---|
| REG-001 | Full gate after every unit | ONGOING | 908/908 latest |
| REG-002 | Deterministic competitive tests (T+1/T+3/T+7, RPC disconnect, duplicate block, restart) | TODO | Designed 2026-08-24; implement with INNOV-001 |
| REG-003 | D9 acceptance run (internetmonkes 2026-08-28) | TODO | Round 22 target |

## Dependency order

`BASE-002/003` (observability) → `SEC-004/005/006/007` (security) → `TX-008..017` (correctness) → `RPC-004/005/009/011` (resilience) → `MINT-003..007` (prep/simulation) → `UX-003..007` (integrations) → `PERF-004/005` (benchmarks prove) → `INNOV-001..003` (innovation) → `REG-002/003` (regression + acceptance).

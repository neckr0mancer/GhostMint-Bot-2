# GhostMint — Model 2 Independent Review, Phase 2

**Date:** 2026-08-25

**Reviewer:** Model 2

**Review branch:** `main`

**Reviewed range:** `782054d648d1432d14c07eef9abd94816156a30c..cff9eb69a65c3748224e71c7a05b6a58f7455124`

**Result at review start:** `cff9eb69a65c3748224e71c7a05b6a58f7455124`

**Verdict:** **FAIL**

## Scope and method

The requested result was the review checkout's starting `HEAD`, so `git merge-base --is-ancestor cff9eb6 HEAD` succeeded. The exact range contains 10 commits and changes 58 files by 3,649 additions and 495 deletions. It includes the phase-aware scheduler/dashboard work, two intervening merge commits, the Phase 1 review documents, and the claimed final correction. The complete base-to-result diff, every changed line, per-commit history, status, and `git diff --check` output were inspected.

The review read `AGENTS.md`, `README.md`, `ROADMAP.md`, every file under `docs/agent/`, both earlier Model 2 reports, implementation code, migrations, and tests. Memory statements were treated as claims and corrected when runtime/source evidence disagreed. The exact `cff9eb6` result was exported to an ignored `.tmp-review` snapshot with no `.env`; dependencies were linked read-only. No live database, authenticated RPC, external service, browser mutation, real transaction, or real funds were used.

## Blocking findings

### 1. Critical — SEC-001 — scraper SSRF remains fail-open and DNS-rebindable

- **Exact file/function:** `src/security/scraperUrlPolicy.js:isPrivateScraperHostname` and `assertPublicScraperDestination` (lines 36–114); `src/social/adapters.js:createHttpAdapter.poll` (lines 39–58).
- **Reproduction:** `tests/model2.phase02.review.test.js` injects `EAI_AGAIN`; the policy resolves instead of rejecting. The classifier accepts `198.18.0.1`, `224.0.0.1`, `255.255.255.255`, `fec0::1`, and `::7f00:1`. Transport inspection shows no pinned `lookup`, `httpAgent`, or `httpsAgent`; a never-settling DNS lookup also outlives the request timeout.
- **Expected:** bounded, fail-closed resolution permits only global-unicast addresses and the socket connects to exactly the vetted address while preserving Host/TLS SNI.
- **Actual:** lookup errors/empty answers authorize the request, important non-global ranges pass, and Axios independently resolves the original hostname after the policy check. One malicious rule can also stall the shared poll cycle.
- **Required regression test:** persisted raw rules; lookup error/empty/mixed-private answers; RFC 6890 IPv4/IPv6 table; public-first/private-second DNS flip against the actual transport; proxy behavior; DNS timeout.
- **Recommended correction:** replace the short denylist with a global-routability allow policy, add a bounded fail-closed resolver, and pin the vetted address in a per-request HTTP(S) agent/lookup with redirects and proxy resolution secured.

The WORKLIST's prior `VERIFIED` status and “theoretical same-tick” residual are incorrect.

### 2. Critical — TX-004 / PERF-002 — ambiguous broadcast failures can become false-final reverts

- **Exact file/function:** `src/transactions/providerService.js:perform` and `performAll` (lines 52–110); `src/transactions/transactionEngine.js:submit` broadcast catch (lines 517–550).
- **Reproduction:** `CALL_EXCEPTION + NETWORK_ERROR` returns `CALL_EXCEPTION`. Sequentially, one request times out, later accepts the signed bytes, and a later candidate's definitive rejection is returned. Both committed Phase 2 cases fail with definitive codes instead of `RPC_UNAVAILABLE`.
- **Expected:** any timeout/transport ambiguity makes broadcast truth unknown; definitive rejection is valid only if every attempted destination explicitly rejects and no earlier request can still succeed.
- **Actual:** `performAll` remembers only a message containing `timed out`; another transient failure does not prevent a definitive aggregate. `perform` forgets earlier ambiguity entirely. The engine maps the resulting code to durable `reverted` even when identical bytes may be live.
- **Required regression test:** every transport class mixed with every definitive code; late acceptance after timeout followed by definitive retry/failover; engine assertions that the durable state is `unknown`, never `reverted`, and reconciliation owns the hash.
- **Recommended correction:** introduce a broadcast-specific result model that counts explicit rejections and retains ambiguity across all parallel/sequential attempts. Never use the generic read failover semantics for side-effecting broadcast truth.

### 3. Critical — TX-014 — missed signed-hash persistence still allows broadcast

- **Exact file/function:** `src/transactions/intentRepository.js:attachSignedHash` (lines 87–92); `src/transactions/transactionEngine.js:submit` (lines 514–554).
- **Reproduction:** the committed test makes `attachSignedHash` return `null`, matching a submitted-to-unknown reconciliation race. The engine broadcasts once and only then throws while dereferencing `intent.intentId`; the durable hash remains absent.
- **Expected:** no provider receives signed bytes unless their exact hash is durably attached to an eligible intent.
- **Actual:** the `WHERE state='submitted'` update can miss, `mapIntent(undefined)`/null propagates, and there is no guard before provider delivery.
- **Required regression test:** two PostgreSQL clients paused between `createSubmitted`, reconciliation, and `attachSignedHash`; assert either the hash CAS succeeds before delivery or broadcast count remains zero. Include restart reconciliation.
- **Recommended correction:** add an explicit signing lease/state or CAS the hash onto a hashless eligible row, validate the returned row, and abort before broadcast on any miss.

This was a confirmed defect, not the WORKLIST's prior hypothesis.

### 4. Critical — SEC-013 — automatic proof URLs retain a separate SSRF bypass

- **Exact file/function:** `src/mint/proofResolver.js:isPrivateHostname`, `publicProofUrl`, and `createProofResolver.resolve` (lines 16–95).
- **Reproduction:** `http://[::1]/proof` reaches the injected `fetchJson` and its proof is accepted; the committed test expected zero transport calls and fails.
- **Expected:** private, reserved, DNS-failing, or rebound proof destinations never reach the transport.
- **Actual:** this value-moving mint path keeps the older duplicated literal guard; bracketed IPv6 bypasses it and there is no DNS vetting/pinning.
- **Required regression test:** private/reserved IPv4/IPv6 and alternate encodings, DNS failure/timeout, mixed answers, redirect/proxy behavior, and public-to-private rebinding against the real fetch transport.
- **Recommended correction:** use one bounded, fail-closed, pinned global-routability transport policy for scraper and proof fetches; do not copy another hostname denylist.

### 5. High — SEC-012 — account status is not rechecked at the latest safe broadcast point

- **Exact file/function:** `src/server.js` scheduler `executeTask` (line 587) and phase `preBroadcastGuard`s (lines 657–659 and 744–746).
- **Reproduction:** source/runtime sequencing permits an account to be active at line 587, become banned during the OpenSea build, live-phase reads, simulation, fee/balance/nonce reads, and still pass the final guard because that guard checks phase only (or is absent for legacy tasks).
- **Expected:** a persisted ban/suspension/deactivation immediately before signing/intent creation prevents the spend on every scheduled path.
- **Actual:** the old authorization-cache skip is narrowly removed, but the new unconditional check is still too early and the “latest safe revalidation” omits governance.
- **Required regression test:** pause the build/preparation after the entry check, change each account state, resume, and assert zero intent/sign/signature/broadcast calls for OpenSea, direct public, and legacy paths.
- **Recommended correction:** compose `governance.checkAccountStatus` into every scheduled `preBroadcastGuard`, after phase revalidation and immediately before intent creation.

### 6. High — BASE-005 — fixture cleanup can delete legitimate wallets and keys

- **Exact file/function:** `scripts/clear-test-fixtures.js:main` selection/deletion queries (lines 23–71).
- **Reproduction:** the marker matches all 256 addresses under `0x…00%`, not only the documented `…22/33/44`. A user with one such task, no activity/nonmatching task, and an unrelated legitimate wallet satisfies the wallet deletion query. The committed static regression fails because `DELETE FROM wallets` remains without explicit provenance.
- **Expected:** only rows tagged to a known fixture run/test tenant are removable; wallet/key ownership is never inferred from unrelated task history.
- **Actual:** `--yes` can irreversibly delete real tasks, intents, wallets, and potentially users using the shared `DATABASE_URL`, with no environment fingerprint or fixture provenance.
- **Required regression test:** disposable PostgreSQL data containing tagged fixtures, an untagged low-address row, and a real wallet; only explicitly tagged rows may be removed. Verify dry-run IDs, transactional revalidation, rollback, and production guard.
- **Recommended correction:** stop using this script until deleted IDs/backups are audited. Use an isolated test database or explicit fixture tenant/run IDs; remove wallet/user deletion unless provenance is authoritative.

The claimed purge of 1,714 tasks and 33 wallets cannot verify that those wallets were disposable. If backups exist, Model 1 must audit and restore any legitimate rows before further cleanup.

### 7. High — TX-005 — rolling spend releases unresolved exposure and misdates late settlement

- **Exact file/function:** `src/transactions/intentRepository.js:rollingSpendWei` (lines 228–247).
- **Reproduction:** an `unknown` intent created 25 hours ago and a transaction created 25 hours ago but finalized now both fail `created_at >= cutoff`; a reverted row with missing actual cost contributes zero.
- **Expected:** unresolved possibly-live value remains reserved until terminal resolution; final expenditure is windowed by durable execution/finalization time with a conservative missing-cost rule.
- **Actual:** creation time filters every state, releasing live exposure after 24 hours and excluding recent settlement of older transactions.
- **Required regression test:** PostgreSQL cases for old submitted/pending/unknown, late confirmation/revert, exact boundaries, replacements, and missing reverted receipt cost.
- **Recommended correction:** reserve non-final states independently of age; window final outcomes by a durable settlement timestamp and define a conservative missing-cost fallback.

### 8. High — TX-007 / PERF-003 / PERF-006 — pre-arm suppresses moved firings and leaks stale work

- **Exact file/function:** `src/scheduler/schedulerWorker.js:armPreciseTimers` (lines 289–305); `src/server.js:prearmScheduledTask`, `armedPreparations`, and `takeArmedPreparation` (lines 446–515); `src/transactions/transactionEngine.js:submit` active-service selection (lines 324–329).
- **Reproduction:** after firing A is prepared, moving the task to firing B leaves `existing.done === true`; the Phase 2 test observes one pre-arm instead of two. T-4 re-warms are untracked, general-provider calls warm a different pool than T0, and static call-site inspection finds `armedPreparations.set` but no caller of `takeArmedPreparation`.
- **Expected:** exactly one preparation per distinct firing identity, against the execution pool, with all timers/maps evicted on move/cancel/terminal state/stop.
- **Actual:** the completed sentinel suppresses every later firing for that task; stale re-warms can still run; connection work targets the general pool; dead preparation entries and completed sentinels grow by task.
- **Required regression test:** A completes, task moves to B, B prepares exactly once; cancel/terminal/stop prevents T-4 work; separate fast/general spies; cache/health counts return to baseline.
- **Recommended correction:** key completed state by complete firing identity, own/cancel every timer, inject/warm the chosen fast service, evict absent/terminal tasks, and remove the now-unused `armedPreparations` map. Do not claim a latency gain until benchmarked.

### 9. High — TX-021 — replacement hashes are persisted after provider delivery

- **Exact file/function:** `src/transactions/bumper.js:attempt` (lines 95–107).
- **Reproduction:** a replacement is accepted after the local timeout/process interruption path; `attachBump` is never reached and only the original hash remains durable.
- **Expected:** every exact signed replacement hash is durable before any provider receives its bytes.
- **Actual:** `performAll` precedes `attachBump`; an accepted replacement can be permanently invisible to restart reconciliation.
- **Required regression test:** accepted-after-timeout, process interruption, and database failure between signing/delivery/persistence; restart must discover the replacement.
- **Recommended correction:** append the signed attempt/hash transactionally before broadcast and update its delivery outcome afterward.

### 10. High — TX-022 — later bump rungs erase older live hashes

- **Exact file/function:** `src/transactions/intentRepository.js:attachBump`; `src/transactions/transactionEngine.js:inspectChain`.
- **Reproduction:** H0→H1→H2 retains only H2 and H1; a receipt visible only for H0 is never queried and the intent stays pending.
- **Expected:** any hash ever signed/broadcast for an intent's nonce can settle it.
- **Actual:** one `bumped_from_tx_hash` slot models only one rung and overwrites older attempts.
- **Required regression test:** two/three-rung ladders where earliest, middle, and latest hashes independently confirm or revert.
- **Recommended correction:** retain all attempt hashes append-only and reconcile every unresolved attempt.

### 11. High — TX-023 — stale reconciliation can reopen final state

- **Exact file/function:** `src/transactions/intentRepository.js:transition` (lines 151–175); `src/transactions/transactionEngine.js:reconcileIntent`.
- **Reproduction:** a safe repository probe writes `confirmed`, then a stale observer writes `pending`; actual durable state becomes pending.
- **Expected:** confirmed/reverted/replaced states are monotonic and immutable.
- **Actual:** transition has no expected-state/version predicate or legal-transition guard.
- **Required regression test:** concurrent PostgreSQL reconcilers with conflicting observations; final state must win in either completion order.
- **Recommended correction:** enumerate legal state transitions and enforce expected-state/version compare-and-set in the repository.

### 12. High — TX-024 — dashboard batch confirmation can submit one wallet twice

- **Exact file/function:** `src/dashboard/api.js:previewMint` and `confirmMint`.
- **Reproduction:** `walletLabels:['alpha','alpha']` yields two prepared previews and two submissions from one confirmation. The committed test expected HTTP 400 and zero preparation/submission but receives 200 and performs both. Empty/unbounded arrays also bypass the shared batch schema.
- **Expected:** empty, case-insensitive duplicate, and more-than-100 labels are rejected before preparation; each wallet occurs once.
- **Actual:** dashboard handlers implement a parallel batch path without `requestSchemas.batchMint`, allowing double-mint and unbounded simulation/RPC/preview-map work.
- **Required regression test:** API-level empty/duplicate/case-duplicate/>100 inputs with zero downstream calls; valid batch partial-success behavior.
- **Recommended correction:** route preview through the shared validated batch preparation service and enforce uniqueness before issuing a confirmation token.

### 13. High — TX-026 / performance — API permits years of durable phase churn

- **Exact file/function:** `src/validation/domain.js:taskEligibilityDeadline` (lines 211–222); `src/scheduler/scheduledPhaseResolver.js` retry timing; `src/scheduler/schedulerRepository.js` phase-attempt persistence.
- **Reproduction:** the committed schema test passes a deadline `24h + 1ms` and expects rejection; current validation accepts up to five years. One four-year task can create roughly 2.1 million minute-spaced claim/attempt cycles without consuming execution retries.
- **Expected:** the server boundary enforces the documented bounded unattended window and per-user active/rate limits.
- **Actual:** first-party UI defaults to 24 hours, but a direct authenticated API caller can create years of scheduler/database churn.
- **Required regression test:** schema/API reject `24h + 1ms`; active-task/rate-limit cases; sustained phase-wait load/row-growth test.
- **Recommended correction:** cap at 24 hours server-side, limit active phase-aware tasks per user, rate-limit creation, and consider compacting repeated phase checks.

### 14. High — TX-027 — dashboard records reverted/replaced mints as confirmed success

- **Exact file/function:** `src/dashboard/api.js:confirmMint`; `src/commands/botCommandService.js:submitPreparedMint`; dashboard adapter at `src/server.js:3967–3971`; compare confirmed-only helper `src/server.js:983–990`; `recordMintActivity` lines 959–965.
- **Reproduction:** a mocked `submitPreparedMint` returns `{state:'reverted'}`; the committed API test receives result status `success`. The production adapter calls `mintExecution.executePrepared` directly, then increments `wallet.minted`, records success Activity/P&L, and sends a confirmed message without checking state.
- **Expected:** only `confirmed` records mint success. Reverted/replaced outcomes return failure and create no success side effects.
- **Actual:** final failures are celebrated and pollute the new Home “confirmed on-chain” metrics through false stored Activity truth.
- **Required regression test:** confirmed/reverted/replaced dashboard confirmation asserting HTTP/result, notifications, wallet count, Activity, P&L, and Home summary.
- **Recommended correction:** route the adapter through the existing confirmed-only helper or assert `intent.state === 'confirmed'` before every side effect.

`verification_state` is human verification, not transaction finality; Home should not use it as a workaround.

### 15. High — TX-028 — cross-provider receipt/head observations can false-confirm a reorged transaction

- **Exact file/function:** `src/transactions/transactionEngine.js:evaluateReceipt`, `inspectChain`, and `reconcileIntent` (lines 176–236).
- **Reproduction:** provider A supplies a fork receipt at block 100 then fails; failover provider B supplies head 200 but has no receipt. The engine persists confirmed with “101 confirmations observed.” Ultra Fast permits one confirmation and final states are not rechecked.
- **Expected:** receipt existence, its canonical block hash, and head depth come from one consistent observation/finality strategy.
- **Actual:** receipt and head are independent failover calls and no canonical-block check protects against provider desynchronization or shallow reorg.
- **Required regression test:** orphan receipt on A plus canonical head/no receipt on B; block-hash mismatch; shallow reorg before required finality; final-state revalidation policy.
- **Recommended correction:** fail over the whole receipt/block/head observation as one unit, verify `receipt.blockHash` against the canonical block, and define chain-specific quorum/finality/reorg handling.

### 16. High — TX-029 — replacement policy is chain-wrong and fail-open

- **Exact file/function:** `src/transactions/bumper.js:feeFor` (lines 28–40); `src/server.js` bump-sweeper wiring (lines 1243–1250).
- **Reproduction:** the callback receives only `userId`, so `botCommands.gasCeiling(userId)` defaults to Ethereum. A Base replacement above Base's 5 gwei default but below Ethereum's 200 gwei cap broadcasts. When the policy lookup throws, the same path treats the bump as uncapped and broadcasts.
- **Expected:** replacement uses the same effective user/wallet/target/chain/trigger policy and current account standing as fresh submission, failing closed when governance is unavailable.
- **Actual:** chain, wallet, target, and status context are unavailable; exceptions set `capLimit=null`.
- **Required regression test:** Base/Polygon defaults, stricter wallet/target policy, suspended account, and policy-repository failure with zero broadcasts.
- **Recommended correction:** resolve the full effective policy context and account standing before replacement; a governance error must defer, never remove the ceiling.

### 17. High — TX-030 — bumped fees are absent from the daily-spend reservation

- **Exact file/function:** `src/transactions/intentRepository.js:attachBump` (lines 119–146) and `rollingSpendWei` (lines 228–247).
- **Reproduction:** attaching a higher-fee rung updates gas/max-fee fields but not `estimated_cost_wei`; pending/unknown budget queries still reserve the old, lower estimate.
- **Expected:** the possible cost of the currently live highest-fee attempt is reserved and checked before broadcast.
- **Actual:** replacement can raise maximum network cost without an incremental daily-budget decision or durable estimate update.
- **Required regression test:** PostgreSQL pending intent, higher-fee bump, and rolling spend equal to value plus gas limit times new maximum fee; include budget rejection before delivery.
- **Recommended correction:** compute/enforce incremental exposure and atomically update the estimate when persisting the pre-broadcast attempt.

### 18. High — TX-032 — same phase identity can change spend-critical configuration without rebuild

- **Exact file/function:** `src/server.js:phaseIdentity`, `refreshScheduledOpenSeaPhase`, and scheduled `preBroadcastGuard`s (lines 321–385, 633–659, 697–746).
- **Reproduction:** `phaseIdentity` compares UUID only (or legacy type/label). Price/timing/config can change under the same UUID after calldata is built/simulated; the final refresh returns the same identity and stale calldata/value continues.
- **Expected:** any spend-critical phase mutation forces rebuild and re-simulation before broadcast.
- **Actual:** refreshed price, limits, times, fee recipient, proof/config fields are discarded when identity remains stable.
- **Required regression test:** mutate price and each critical config field under one UUID between build and guard; assert no stale broadcast and a full rebuild.
- **Recommended correction:** compare a canonical fingerprint of all spend/eligibility-critical stage fields and rebuild/re-simulate on change.

### 19. High — TX-033 — scheduled reminders and Activity can use the wrong chain

- **Exact file/function:** `src/server.js` reminder wiring (lines 874–903) and scheduled Activity calls; `src/commands/botCommandService.js:detectMintContract`; `src/scheduler/scheduledReminder.js` copy.
- **Reproduction:** phase price resolves with task chain, but balance uses `wallet.chain`; sold-out detection scans configured chains and may pick a same-address deployment elsewhere. Activity/explorer paths also use wallet-chain metadata, and reminder copy hardcodes ETH although Polygon config declares MATIC.
- **Expected:** all reads, auto-cancel decisions, explorer metadata, and native symbols use the persisted/resolved execution chain.
- **Actual:** a cross-chain wallet can be falsely warned, miss a warning, or have a valid task auto-cancelled because another deployment is sold out; user-visible chain/currency metadata can be wrong.
- **Required regression test:** task chain differs from wallet chain; same address deployed on two chains with different sold-out states; Polygon symbol and Activity explorer assertions.
- **Recommended correction:** pass the complete task/resolved chain through reminder balance/detection and derive every label/explorer/symbol from shared chain metadata.

### 20. High — MINT-001 — transient discovery still poisons permanent negative cache

- **Exact file/function:** `src/mint/seaDropDiscoveryService.js:isTransientDiscoveryError`, `viaEtherscan`, and `resolve`.
- **Reproduction:** nested `cause.code='EPIPE'` saves `{address:null}`; the committed test sees one save instead of zero. Some Etherscan HTTP-200 application errors such as invalid-key/unavailable bodies also collapse to absence. Negative rows never expire.
- **Expected:** incomplete discovery remains retryable and writes no authoritative absence.
- **Actual:** direct cases added by Model 1 pass narrowly, but wrapped transport/application errors still poison durable cache indefinitely.
- **Required regression test:** direct/nested transport taxonomy, HTTP 408/429/5xx, Etherscan HTTP-200 error bodies, canonical-tier failures, zero cache writes, and later successful retry.
- **Recommended correction:** model `found / authoritative-absent / unavailable`; cache only explicit absence and give negative entries a bounded TTL.

### 21. High — MINT-008 — OpenSea gated calldata may redirect value to an arbitrary call target

- **Exact file/function:** `src/mint/seaDropCall.js:validateOpenSeaMintCall` (lines 230–254), consumed by immediate and scheduled OpenSea execution.
- **Reproduction:** valid `mintAllowList` calldata names the requested NFT, minter, and quantity, but `built.to` is `0x…EE` and response chain is wrong. Validation accepts it; the committed test expected a target/chain rejection.
- **Expected:** SeaDrop selectors execute only on a freshly verified allowed SeaDrop for the requested NFT and requested chain.
- **Actual:** calldata fields are checked but the executing contract/chain are not bound; a malicious same-selector contract can pass simulation and retain `msg.value`.
- **Required regression test:** malicious targets for public, allowlist, signed, and token-gated calls; wrong-chain response; freshly changed allowed-SeaDrop set.
- **Recommended correction:** bind `built.to` to the NFT's fresh allowed/canonical SeaDrop set on the requested chain and reject response-chain mismatches.

## Other confirmed failures

### 22. Medium — TX-020 / RPC-010 — block waiter and shutdown lifecycle remain unsafe

- **Exact file/function:** `src/scheduler/schedulerWorker.js:processTask`, `handleBlock`, `start`, and `stop` (notably lines 212–225, 309–364); `src/server.js:teardownChainWatcherIfIdle` (lines 1190–1197).
- **Reproduction:** an eligible block arrives before `repository.fail` makes the row retryable; the waiter is deleted, `claimSpecific` sees old state, and the signal is lost. A second committed test observes recovery sweeps continuing after `stop`. Block wakeups are detached from `maxConcurrentTasks`, and watcher teardown has no caller.
- **Expected/actual:** retry must be durable before publication, shutdown must stop all work, wakeups must be bounded, and idle listeners must close; current code violates each property while timer fallback masks the lost wake.
- **Required regression test:** delayed fail transaction plus eligible block/null claim, stop/restart recovery counts, 50-waiter concurrency bound, fallback/terminal cleanup, and last-waiter watcher teardown.
- **Recommended correction:** persist before publishing or retain/recheck after null claim; clear `recoveryTimer`; route wakeups through the bounded worker; call teardown whenever waiter count changes.

### 23. Medium — TX-025 — malformed `viaOpenSea` silently selects a different transaction path

- **Exact file/function:** `src/validation/domain.js:validateTaskCreate`; `src/commands/botCommandService.js:createTask`.
- **Reproduction:** `viaOpenSea:'false'` passes validation and raw truthiness persists `viaOpenSea:true`, price zero, and earliest-eligible mode; the committed schema test expects a field error and fails.
- **Expected/actual:** only a real boolean may select builder routing; malformed JSON currently changes value/routing semantics.
- **Required regression test:** dashboard/Discord/Telegram JSON strings, numbers, arrays, and objects rejected; real booleans preserve behavior.
- **Recommended correction:** validate the optional boolean and use only the validated value in all subsequent decisions.

### 24. Medium — TX-031 — receipt effective-gas-price fallback dereferences the wrong field

- **Exact file/function:** `src/transactions/transactionEngine.js:evaluateReceipt` (lines 176–180).
- **Reproduction:** `{gasPrice:null,effectiveGasPrice:100n}` executes `BigInt(receipt.gasPrice)` and throws `Cannot convert null to a BigInt`.
- **Expected/actual:** v5-shaped receipts should use `effectiveGasPrice`; the fallback converts the null legacy field instead.
- **Required regression test:** v5/v6 receipts with each field independently absent/null plus cost persistence.
- **Recommended correction:** convert `receipt.effectiveGasPrice` in that branch and normalize receipt shapes once.

### 25. Medium — UX-009 — phase waits hide a valid Retry action

- **Exact file/function:** retry math in `src/scheduler/schedulerRepository.js`; dashboard `actionsFor` at `dashboard/src/App.jsx:1540–1544`; bell payload at `src/server.js:798–804`.
- **Reproduction:** `{attemptCount:11,phaseWaitCount:10,maxAttempts:3}` has one execution attempt and is retryable in the repository, but dashboard and bell use raw 11 and hide Retry.
- **Expected/actual:** every surface should use execution attempts; two UI surfaces disagree with durable repository truth.
- **Required regression test:** 10 phase waits plus 1/3 execution attempts and a true 3/3 exhaustion across row and bell actions.
- **Recommended correction:** expose one authoritative `executionAttemptCount`/`retryable` field from the server and reuse it everywhere.

### 26. Medium — UX-010 — schedule detection responses can overwrite newer input

- **Exact file/function:** contract-detection effect/state in `dashboard/src/App.jsx` (approximately lines 1293–1386).
- **Reproduction:** issue two valid address detections and resolve the first request last; there is no request identity or abort guard, so its chain/stage/price overwrites the current address.
- **Expected/actual:** only the response matching current input may update derived state; stale responses currently win by completion order.
- **Required regression test:** deferred A/B requests resolving B then A, including error/reset state.
- **Recommended correction:** reset all derived state on input change and ignore/abort results whose request key is no longer current.

### 27. Medium — UX-011 — pending-cap warnings group the wrong schedule scope

- **Exact file/function:** pending schedule grouping/copy in `dashboard/src/App.jsx` (lines 1397–1403 and 1454–1455).
- **Reproduction:** same wallet/address on two chains or phase UUIDs is grouped together; copy says capped at 100 while the request limit is 50.
- **Expected/actual:** warnings group by execution chain, contract, wallet, and phase and quote the real cap; current grouping/copy produces false warnings.
- **Required regression test:** same address across chains/phases and a cap value sourced from the request/service.
- **Recommended correction:** include chain/stage identity in the key and derive copy from the authoritative limit.

### 28. Medium — UX-012 — Discord, Telegram, and dashboard classify a type-less public stage differently

- **Exact file/function:** Discord phase handling at `src/discord/discordBot.js:432–449`; dashboard stage handling at `dashboard/src/App.jsx:1246–1251`; Telegram flow at `src/server.js:2174–2185`.
- **Reproduction:** a type-less stage labelled `Public sale` becomes direct public SeaDrop on Discord/dashboard but OpenSea-gated on Telegram.
- **Expected/actual:** all platforms choose identical routing from the same stage; duplicated adapter logic currently diverges.
- **Required regression test:** table-driven stage objects across all three surfaces with identical normalized decisions.
- **Recommended correction:** move stage classification into one shared domain function; adapters only format the result.

### 29. Low — UX-013 — mint feedback hardcodes wrong chain symbols and internal jargon

- **Exact file/function:** `dashboard/src/mintFeedback.mjs`.
- **Reproduction:** supported Ink falls back to generic `funds`; Polygon says `POL` while current config declares `MATIC`; another message exposes “RPC settings.”
- **Expected/actual:** currency/name comes from authoritative chain metadata and customer copy is plain language; the helper duplicates stale metadata/jargon.
- **Required regression test:** every supported chain's configured native symbol plus customer-language assertions.
- **Recommended correction:** return chain metadata from the server/shared config and remove provider jargon from customer messages.

### 30. Medium — BASE-001 / BASE-006 / REG-001 — committed validation and memory evidence is false

- **Exact file/function:** `docs/agent/WORKLIST.md`; the newest entries in `docs/agent/DECISIONS.md` and `docs/agent/HANDOFFS.md`; commit subject `cff9eb6`.
- **Reproduction:** eight WORKLIST rows lacked closing `|`; the unchanged Phase 1 reviewer run was 8/9, not 9/9. The exact isolated full run found 971 total / 953 pass / 13 fail / 5 skip before safe configuration reruns; reruns cleared environment-only failures and a timing flake but retained the genuine BASE-006 failure. The Phase 2 reviewer suite fails 0/16.
- **Expected/actual:** VERIFIED/test-count claims must match reproducible evidence and valid memory structure; the result says 982/979/0 and “all findings addressed” while critical cases remain red.
- **Required regression test:** mandatory memory lint for required headings, closed four-column rows, unique IDs/statuses, and referenced command/test evidence.
- **Recommended correction:** retain history, add dated corrections, mark every failed claim `REVIEW_FAILED`, and distinguish discovered/pass/fail/skip/configuration results. This review commit repairs row structure only; production findings remain red.

### 31. Low — BASE-007 — changed-line hygiene regressions

- **Exact file/function:** duplicate `metric()` declarations and unused `URL` import in `src/social/adapters.js` (lines 2, 27–37); EOF blank lines in `dashboard/src/homeActivityMetrics.js:58` and `tests/dashboardHomeActivityMetrics.test.js:84`.
- **Reproduction:** source inspection finds identical declarations; `git diff --check 782054d..cff9eb6` reports both whitespace errors.
- **Expected/actual:** one implementation and clean diff; the later declaration silently replaces the first and range hygiene fails.
- **Required regression test:** lint/no-redeclare plus `git diff --check` in the gate.
- **Recommended correction:** remove the duplicate/unused import and normalize EOF whitespace in Model 1's production correction, not this review commit.

## Narrowly verified items and subclaims

- The review checkout contains exact result `cff9eb6`; the result was independently tested without later production changes.
- The shared scraper policy is now called by the social adapter, and a persisted literal `[::1]` scraper URL is rejected. SEC-001 remains failed for fail-open resolution, non-global ranges, timeout, and unpinned transport.
- UX-002 Discord active-flow EOA preservation and real-contract replacement pass. Telegram source ordering matches, but runtime parity coverage is still owed; status remains `FIXED`, not `VERIFIED`.
- UX-008's narrow Ink code-path claim passes: dashboard/server chain parity and OpenSea Ink slug mapping work. Documentation gaps remain outside that subclaim.
- TX-001 gas-ceiling precedence and TX-002 nonce replacement classification remain covered by exact-snapshot reviewer tests.
- TX-019's sequential locking CTE structurally records prior state and audit atomically. It remains `FIXED`, not `VERIFIED`, until PostgreSQL transition/concurrency tests read the evidence.
- Phase-resolution pure cases pass for timestamp normalization, UUID pinning, earlier-stage waiting, earliest-stage advancement, missing/ambiguous stage fail-closed behavior, deadline handling, and bounded backoff.
- OpenSea SeaDrop v1 allowlist/signed/token-holder signatures and the implemented contract/minter/quantity field checks pass their nominal unit tests. Those checks do not bind the target/chain (MINT-008).
- Home activity aggregation is internally consistent with stored Activity rows. TX-027 makes those stored rows untrustworthy for transaction finality.
- ESLint, changed-JavaScript syntax checks, and exact-result production dashboard builds pass. No high-confidence private-key, mnemonic, authenticated DB/RPC URL, AWS/GitHub token, or PEM pattern was found in the exact range.

No item was promoted to VERIFIED solely from memory, a static test, or a skipped integration.

## Tests and commands run

- Git/status/range: `git status --short --branch`, recent/full range `git log`, `git merge-base --is-ancestor`, full/per-file/per-commit diff, `git diff --stat`, and changed-file inventory — **PASS**; 10 commits, 58 files, +3,649/-495.
- `git diff --check 782054d..cff9eb6` — **FAIL**, two EOF whitespace errors listed in BASE-007.
- Documented wrapper `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\project-npm.ps1 run validate` — **TOOLING FAIL** before component results; direct components were run instead.
- Exact-result isolated full `node --test --test-concurrency=1` — **FAIL**, 971 total / 953 pass / 13 fail / 5 skip in 168.37 seconds. Eleven integration/config modules lacked required `NODE_ENV` in the intentionally no-`.env` snapshot, one scheduler timing case flaked, and BASE-006 genuinely failed.
- Safe-config rerun of the 12 affected config/integration/scheduler modules with `NODE_ENV=test`, fake non-secret encryption input, no DB URLs — **PASS for executed cases**, 51 total / 31 pass / 0 fail / 20 skip. Database integrations were deliberately not connected. This clears the configuration failures and scheduler flake, not BASE-006.
- Original Model 2 reviewer files combined — **FAIL**, 12 total / 11 pass / 1 fail (BASE-006). After this review's WORKLIST structure correction, `model2.phase01.rereview.test.js` — **PASS**, 9/9; this proves only the nine narrow cases.
- `node --test tests/model2.phase02.review.test.js` — **EXPECTED FAIL**, 16 total / 0 pass / 16 fail. Deterministic offline reproductions cover SEC-001 (2), TX-004 (2), MINT-001, SEC-013, MINT-008, TX-007, TX-020 (2), TX-014, TX-024, TX-027, TX-025, TX-026, and BASE-005.
- Initial focused scheduler/dashboard subreview — 102 total / 101 pass / 1 BASE-006 failure; after the memory repair, the final scheduler/phase/reminder/Home/validation/Discord set — **PASS**, 106/106. Focused security/reviewer/Discord/validation set — 60 total / 59 pass / 1 BASE-006 failure before repair. Focused transaction/mint set — 154 total / 151 pass / 3 fail; one BASE-006 failure and two PostgreSQL modules blocked by sandbox before connection, with no mutation.
- OpenSea/SeaDrop focused set — **PASS**, 91/91. Direct transaction unit cases, scheduler phase/reminder/chaos nominal cases, and dashboard helper cases otherwise passed for their covered inputs.
- Direct Vite build at current checkout — **PASS**, 64 modules in 2.33 seconds; exact `cff9eb6` snapshot build — **PASS**, 64 modules in 1.49 seconds. Both emit the existing 544.78 kB chunk-size warning.
- Direct `eslint .` — **PASS**, zero findings. `node --check` across all 43 changed JavaScript/MJS files and the Phase 2 reviewer file — **PASS**.
- Safe mocked/static probes reproduced replacement persistence/history/policy/spend defects, provider receipt/head desynchronization, final-state regression, receipt gas-price typo, phase mutation, retry-action mismatch, chain reminder mismatch, response-order race, and platform phase divergence.
- No fork/load/live acceptance or supported latency benchmark was run. No database, live RPC, authenticated service, credentials, transaction, or funds were accessed.

## Required next action for Model 1

1. Immediately stop using `clear-test-fixtures.js`; audit backups/deleted IDs and restore any legitimate wallets/tasks before doing more cleanup.
2. Fix the four Critical findings first: SEC-001 and SEC-013 with one bounded/pinned fail-closed transport policy; TX-004 with broadcast-specific ambiguity semantics; TX-014 with pre-delivery durable hash CAS. Keep the Phase 2 reproductions unchanged.
3. Restore transaction truth: TX-021/TX-022 append-only pre-broadcast attempts, TX-023 monotonic CAS, TX-028 consistent canonical receipt/head observation, TX-029 full fail-closed replacement policy, TX-030 bumped exposure reservation, and TX-005 settlement-window accounting, backed by real disposable PostgreSQL concurrency/boundary tests.
4. Correct value-path construction and reporting: MINT-008 target/chain binding; SEC-012 final governance guard; TX-032 phase fingerprint/rebuild; TX-024 batch validation; TX-025 strict routing flag; TX-027 confirmed-only dashboard side effects; TX-033 resolved-chain reminders.
5. Then fix scheduler lifecycle/churn (TX-007, TX-020, TX-026), discovery caching (MINT-001), receipt typo, and UI/platform parity. Run rendered interaction/responsive checks at 375/768/1024/1440 in Dark and Light; current source-regex tests do not establish responsive fidelity.
6. Repair production diff hygiene, run the official validation gate with disposable database integrations actually executing, make `tests/model2.phase02.review.test.js` green without weakening assertions, secret-scan the staged production correction, and request another independent review. Do not mark Phase 2 VERIFIED or broadcast real value before that review passes.

Release and real-value use remain blocked by SEC-001, SEC-013, TX-004, TX-014, SEC-012, BASE-005, TX-021, TX-022, TX-023, TX-027, TX-028, TX-029, TX-030, TX-032, and MINT-008.

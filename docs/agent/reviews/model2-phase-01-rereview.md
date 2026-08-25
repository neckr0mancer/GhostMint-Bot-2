# GhostMint — Model 2 Independent Re-review, Phase 1

**Date:** 2026-08-25
**Reviewer:** Model 2
**Review branch:** `main`
**Reviewed range:** `782054d648d1432d14c07eef9abd94816156a30c..e617b268d3c21513e6df93e598d015bec8f0c287`
**Verdict:** **FAIL**

## Scope and method

`e617b26` is an ancestor of the review checkout's starting HEAD, `f79fe26dec12a6f747b9b7b4da06c38f7c482b5f`. The exact remediation range changes 16 files by 441 additions and 145 deletions. Every changed line and the complete range diff were inspected. The result was exported to the ignored `.tmp-review/model2-rereview-e617b26` directory and tested there with a `node_modules` junction; later `main` changes were not credited.

The review read `AGENTS.md`, `README.md`, `ROADMAP.md`, every file under `docs/agent/`, both Phase 1 review files, recent Git history, and the result snapshot's implementation and tests. Memory statements were treated as claims, not proof. No `.env` file or credential was copied into the snapshot. No live database, authenticated RPC, fork, real transaction, or real funds were used.

## Blocking findings

### 1. Critical — SEC-001 — the new fetch-time SSRF policy is not used and remains unsafe if wired directly

- **Exact file/function:** `src/social/adapters.js:isPrivateScraperHostname` and `createHttpAdapter.poll`; `src/security/scraperUrlPolicy.js:assertPublicScraperDestination`.
- **Reproduction:** run `node --test tests/model2.phase01.rereview.test.js`. A raw/persisted scraper rule containing `http://[::1]/` reaches the mocked request transport (`requests === 1`). Source search shows no production caller of `assertPublicScraperDestination`.
- **Expected:** a single canonical policy rejects every non-global destination immediately before connection, fails closed on resolution errors, and ensures the actual socket connects only to a vetted address.
- **Actual:** the adapter still uses its old duplicated hostname guard. The new resolver catches DNS errors and returns, which fails open. It discards the vetted address and lets Axios resolve again, leaving a DNS-rebinding time-of-check/time-of-use gap. Its denylist also accepts reserved/non-global examples including `198.18.0.1`, `224.0.0.1`, `255.255.255.255`, `fec0::1`, and `::7f00:1`.
- **Required regression test:** adapter-level persisted-rule tests with transport call count zero; DNS private result; lookup failure; public-first/private-second DNS flip with a pinned connection; table-driven RFC 6890 IPv4/IPv6 exclusions plus public controls.
- **Recommended correction:** remove the duplicate adapter guard, classify global-routable addresses rather than maintaining a short denylist, fail closed on lookup failure, and pin a vetted address through an HTTP(S) agent/lookup while preserving Host and TLS SNI.

### 2. Critical — TX-004 / PERF-002 — a timed-out broadcast candidate can still be accepted after the engine records `reverted`

- **Exact file/function:** `src/transactions/providerService.js:withTimeout`, `perform`, and `performAll`; `src/transactions/transactionEngine.js` broadcast catch.
- **Reproduction:** one candidate returns `CALL_EXCEPTION`; another exceeds the local timeout and accepts the same signed bytes afterward. The probe produced `{"errorCode":"CALL_EXCEPTION","persistedState":"reverted","accepted":true}`. The committed re-review test reproduces the aggregate classification error. Sequential `perform` has the same mixed timeout/definitive failure: `{"outcome":{"error":"CALL_EXCEPTION"},"accepted":true}`.
- **Expected:** any timeout or transport ambiguity makes aggregate broadcast truth non-final. The pre-persisted signed hash remains `unknown` and is reconciled; no retry at a new nonce is allowed from a false final state.
- **Actual:** the implementation propagates a definitive error whenever at least one candidate is definitive, even if another candidate timed out and may have accepted. `withTimeout` does not cancel the provider request. The original reviewer test succeeds only because its delayed acceptance occurs inside its 100 ms timeout.
- **Required regression test:** delayed acceptance beyond the local timeout for both `performAll` and sequential `perform`, with engine assertions that the durable state is `unknown`, never `reverted`, and that reconciliation—not a second mint—owns the outcome.
- **Recommended correction:** report definitive aggregate rejection only when every attempted destination explicitly and definitively rejects. Any timeout, cancellation uncertainty, or transient failure in the set must produce an ambiguous broadcast outcome.

### 3. High — SEC-012 — pre-arm caches authorization and skips the required execution-time account check

- **Exact file/function:** `src/server.js:prearmScheduledTask`, `takeArmedPreparation`, and the scheduler `executeTask` callback.
- **Reproduction:** pre-arm a scheduled task while its owner is active, then ban/suspend/deactivate the owner before T0. `armedPreparations` remains valid for at least 60 seconds and `executeTask` executes `if (!takeArmedPreparation(task)) await governance.checkAccountStatus(...)`; the cached entry therefore suppresses the T0 check.
- **Expected:** authorization and account standing are evaluated immediately before every value-moving execution, regardless of earlier preparation.
- **Actual:** a status check performed around T-12 is treated as reusable front matter. An owner action between pre-arm and fire can be bypassed and the scheduled transaction can still broadcast.
- **Required regression test:** fake-clock integration with active-at-prearm and banned/suspended/deactivated-at-T0 states; assert zero signing/broadcast calls for each blocked state.
- **Recommended correction:** never cache authorization. Always call `checkAccountStatus` at execution; cache only explicitly safe preparation data and revalidate all policy/limit inputs at T0.

### 4. High — TX-005 — rolling spend releases unresolved transactions after 24 hours and misdates late settlement

- **Exact file/function:** `src/transactions/intentRepository.js:rollingSpendWei`.
- **Reproduction:** inspect/execute the query with (a) an `unknown` intent created 25 hours ago that is still unresolved and (b) an intent created 25 hours ago but confirmed now. Every state is filtered by `created_at >= cutoff`, so both disappear from current exposure/spend.
- **Expected:** unresolved possibly-live value remains reserved until resolution. Final outcomes are included according to a durable execution/finalization timestamp. Reverted receipts with incomplete actual-cost fields have an explicit conservative policy.
- **Actual:** the new state-aware `CASE` is still bounded exclusively by creation time. Old unknown broadcasts fail open, and late-confirmed expenditure is attributed to the creation window rather than when it settled. The cited tests do not cover these boundaries.
- **Required regression test:** PostgreSQL integration cases for old unknown/submitted/pending intents, late confirmation/revert, replaced transactions, exact cutoff boundaries, and reverted receipts with missing actual-cost fields.
- **Recommended correction:** reserve unresolved states independently of age until terminal resolution; add a durable settled/executed timestamp for final-state rolling windows; define a conservative missing-cost fallback.

### 5. High — MINT-001 — standard transport and application-level rate-limit failures still poison permanent discovery cache

- **Exact file/function:** `src/mint/seaDropDiscoveryService.js:isTransientDiscoveryError`, `viaEtherscan`, and `resolve`; `src/transactions/seaDropPublicDropResolver.js` canonical lookup catch.
- **Reproduction:** the committed re-review tests throw `ENOTFOUND`, `ENETUNREACH`, `EHOSTUNREACH`, `EPIPE`, or `ERR_NETWORK`, or return Etherscan HTTP 200 `{status:'0',message:'NOTOK',result:'Max rate limit reached'}`. Each path reaches `saveSeaDrop(..., {address:null})`. Additional probes reproduced HTTP 408 and nested `cause.code='EAI_AGAIN'`.
- **Expected:** incomplete discovery is retryable and writes no permanent negative result. Only authoritative successful absence may be negatively cached, with a bounded lifetime.
- **Actual:** the taxonomy recognizes only part of the normal transport set and does not parse Etherscan's application-level error body. Canonical RPC errors can also collapse to `null`. The repository has no negative-cache expiry.
- **Required regression test:** table-driven direct and nested transport codes, 408/429/5xx, cancellation/timeouts, Etherscan HTTP-200 outage/rate-limit bodies, canonical-provider failures, zero cache writes, and a successful later retry.
- **Recommended correction:** propagate any incomplete tier as transient; parse Etherscan body semantics; persist absence only after authoritative successful negatives, preferably with a short negative TTL.

### 6. High — TX-007 / PERF-003 — pre-arm warms the wrong provider pool and can schedule duplicate re-warms

- **Exact file/function:** `src/server.js:prearmScheduledTask`; `src/scheduler/schedulerWorker.js:armPreciseTimers`; `src/transactions/transactionEngine.js:submit` fast-service selection.
- **Reproduction:** let the pre-arm lead timer fire while the unchanged task remains outside the precise-fire window, then run another lookahead sweep. The safe probe returned `{"prearms":2,"expected":1,"stillOutsideFireWindow":true}`.
- **Expected:** exactly one preparation and one replaceable T-4 fee timer per `(task,nextAttemptAt)`, both cleaned on move/cancel/stop; any claimed connection warm-up targets the service used at T0.
- **Actual:** the worker deletes the pre-arm timer entry when it fires, so each later sweep can pre-arm again. Every hook creates an untracked T-4 timeout, causing a burst near fire time. Balance/nonce/network use the general provider while scheduled submission selects the separate fast provider. Re-warm handles are not replaced or cleared.
- **Required regression test:** production-lead fake clock (12 s pre-arm, 2 s precise window, 1 s sweeps), distinct general/fast provider fakes, task move/cancel/stop, and assertions for one pre-arm, one re-warm, zero stale timers, and T0 call counts.
- **Recommended correction:** keep a completed-prearm sentinel keyed by task and exact firing; own and cancel the re-warm handle; warm the selected service; publish latency claims only after a controlled benchmark.

### 7. High — TX-021 — a replacement hash is persisted only after broadcast

- **Exact file/function:** `src/transactions/bumper.js:attempt` around `performAll` then `intentRepository.attachBump`.
- **Reproduction:** make the replacement provider accept the signed re-bid after the local timeout. The probe returned `{"accepted":true,"attachBumpCalls":0,"persistedHashStillOriginal":true}`.
- **Expected:** every exact signed hash is durable before any provider can receive its bytes, so restart reconciliation can find it even after timeout, process interruption, or database failure.
- **Actual:** `attachBump` runs only after `performAll` resolves successfully. A live replacement can be absent from durable state forever.
- **Required regression test:** accepted-after-timeout, process interruption, and database failure between signing/broadcast/persistence; restart must reconcile the replacement hash.
- **Recommended correction:** introduce an append-only broadcast-attempt/hash record and persist it transactionally before broadcasting the replacement bytes.

### 8. High — TX-008 / TX-022 — later bump rungs erase older possibly-live hashes

- **Exact file/function:** `src/transactions/intentRepository.js:attachBump`; `src/transactions/transactionEngine.js:inspectChain`.
- **Reproduction:** perform H0→H1→H2, then expose a confirmed receipt only for H0. The row retains H2 and H1; reconciliation never asks for H0 and remains pending.
- **Expected:** any hash ever broadcast for one nonce/intent can settle that intent.
- **Actual:** one `bumped_from_tx_hash` slot is overwritten on every rung. The new two-hash reconciliation is correct only for one bump and loses history for two or more.
- **Required regression test:** two- and three-rung ladders where the earliest, middle, and latest hash independently confirms or reverts.
- **Recommended correction:** store every signed/broadcast hash append-only and reconcile all unresolved attempts; do not model replacement history with one previous-hash column.

### 9. High — TX-023 — stale reconciliation can reopen a final state

- **Exact file/function:** `src/transactions/intentRepository.js:transition`; `src/transactions/transactionEngine.js:reconcileIntent`.
- **Reproduction:** reconciler A writes `confirmed`; a stale reconciler B then writes its earlier `pending` observation. The safe repository mock/source probe returned `{"afterConfirmed":"confirmed","afterStaleReconcile":"pending"}`.
- **Expected:** confirmed/reverted/replaced final states are monotonic and cannot be overwritten by stale provider observations.
- **Actual:** `transition` has no expected-state/version condition or final-to-nonfinal guard. Provider desynchronization or concurrent loops can regress durable truth.
- **Required regression test:** concurrent reconcilers with conflicting observations and real repository writes; final state must win regardless of completion order.
- **Recommended correction:** use expected-state/version compare-and-set transitions, enumerate legal transitions, and reject final-to-nonfinal writes in the repository.

## Other confirmed failures

### 10. Medium — TX-020 / RPC-010 — block waiters can consume an eligible signal early, leak lifecycle state, and bypass concurrency bounds

- **Exact file/function:** `src/scheduler/schedulerWorker.js:processTask`, `handleBlock`, `stop`, and `hasBlockWaiters`; `src/server.js:teardownChainWatcherIfIdle`.
- **Reproduction:** defer `repository.fail`, deliver an eligible block, and return null from `claimSpecific`; output was `{"claims":1,"failScheduled":true,"waiterRetained":false}`. Register a waiter and call `stop`; output was `{"beforeStop":true,"afterStop":true}`. `teardownChainWatcherIfIdle` has no callers.
- **Expected:** retry state is durable before a waiter is consumable; null claims retain/recheck the waiter; fallback completion, terminal failure, and shutdown remove it; watchers stop when idle; block fanout respects `maxConcurrentTasks`.
- **Actual:** the waiter is registered before `fail` commits but deleted before `claimSpecific`. A block in that gap is lost and only timer fallback remains. Stop/fallback paths can retain waiters and their chain watcher. Eligible waiters launch detached IIFEs outside scheduler concurrency/health accounting.
- **Required regression test:** block during the fail transaction, null-claim retention, two real due waiters plus an unrelated task, fallback success/failure cleanup, shutdown/idle watcher cleanup, restart, and a 50-waiter concurrency-cap assertion.
- **Recommended correction:** durably schedule retry before publishing the waiter or retain it until a successful exact claim/terminal state; centralize cleanup; route block claims through the bounded worker pool and invoke idle watcher teardown.

### 11. Medium — UX-002 — Discord clears an active flow when an ignored EOA is pasted

- **Exact file/function:** `src/discord/discordBot.js:handleMintPasteMessage`; compare `src/server.js:handleFlowTextMessage`.
- **Reproduction:** seed a `wallet_create` flow and paste an unowned EOA. The committed test observes the flow as `null` and sends no reply.
- **Expected:** owned/unowned EOAs are ignored while preserving the current flow on Discord and Telegram; only a genuine contract deliberately replaces it.
- **Actual:** Discord clears flow state before wallet/EOA classification, then silently returns for an EOA. Telegram classifies first. Added Discord tests begin with no active flow and cannot detect this inconsistency.
- **Required regression test:** active-flow owned EOA, unowned EOA, genuine contract, and RPC-failure cases on both platforms; assert state preservation/replacement and reply behavior.
- **Recommended correction:** move Discord's flow clear to immediately before starting a confirmed contract flow.

### 12. Medium — BASE-005 — an unrelated fixture-cleanup script was committed with invalid SQL

- **Exact file/function:** `scripts/clear-test-fixtures.js` owner-confirmed cleanup query.
- **Reproduction:** run the static reviewer assertion, or inspect the derived table: it declares `d(user_id, label)` but the filter references `d.uid` and `d.lbl`.
- **Expected:** the script is outside this remediation range unless explicitly scoped; if shipped, its `--yes` transaction resolves the declared aliases and safely deletes only documented fixtures.
- **Actual:** the prior Model 2 handoff explicitly preserved this pre-existing file out of staging, but `e617b26` commits it. PostgreSQL will reject the nonexistent aliases and roll back the owner cleanup.
- **Required regression test:** disposable PostgreSQL fixture test for dry-run and `--yes`, rollback on injected failure, exact tenant/fixture boundaries, and zero unrelated deletions.
- **Recommended correction:** remove the unrelated file from the Phase 1 correction commit/history through a normal forward commit if the owner does not want it, or correct and independently review it as a separate scoped unit. Do not run it against shared data before that review.

### 13. Medium — BASE-001 / BASE-006 / REG-001 — memory structure and validation evidence are false

- **Exact file/function:** `docs/agent/WORKLIST.md`; the 2026-08-25 entries in `docs/agent/DECISIONS.md` and `docs/agent/HANDOFFS.md`.
- **Reproduction:** at `e617b26`, `WORKLIST.md` begins with `9. REG-002/003...`; its title, introduction, Phase 1 heading, and table header are gone. Nine table rows lack a closing delimiter and TX-004 has a leading-space delimiter. The exact full suite after building reports 916 discovered / 891 pass / 0 fail / 25 skip—not 916/916 with zero skips. The expanded review suite reports 0/9.
- **Expected:** append-only memory remains valid Markdown, preserves history, uses only supported statuses, and calls an item VERIFIED only when independent evidence exercises the claimed behavior.
- **Actual:** the correction rewrites/corrupts the worklist, calls SEC-001 VERIFIED, calls the full gate 916/916 with no skips, and states “all findings addressed” while critical and high reproductions still fail. MINT-001/UX-002/UX-008/REG-001 rows also contradict that handoff.
- **Required regression test:** lightweight worklist lint for required headings, four closed table cells, unique IDs, permitted statuses, and optionally referenced test/commit existence.
- **Recommended correction:** restore the deleted structure, retain older entries as history, add a newer correction that marks failed items `REVIEW_FAILED`, and distinguish zero test failures from skipped integration evidence.

## Fixed but not independently verified

- **TX-019:** the locking CTE now captures the actual previous state and writes update plus audit transition atomically for a sequential bump. Keep `FIXED`, not `VERIFIED`: no repository test reads `transaction_state_transitions`, no unknown→pending/pending→pending PostgreSQL regression exists, and no concurrent bump compare-and-set is present.
- **TX-020 narrow subclaim:** composite per-task keys and `claimSpecific(userId, taskId)` prevent the original one-bit-per-chain collapse in nominal execution. The lifecycle/race/concurrency defects above keep the overall item `REVIEW_FAILED`.
- **TX-008 narrow subclaim:** immediate primary/previous-hash reconciliation works for one bump rung. It is not a complete replacement-history solution.

## Verified items and subclaims

- `git merge-base --is-ancestor e617b26 HEAD` succeeds: the review checkout contains the requested result.
- The unchanged original Model 2 reviewer suite passes 3/3: four original IPv6 validation literals, delayed success inside the candidate timeout, and `ECONNRESET` discovery. The broader cases above prove those tests are too narrow.
- **UX-008:** the exact result includes Ink in dashboard/server parity and the OpenSea slug mapping resolves an Ink collection URL. Chain grouping passes 2/2. README and `.env.example` still do not document Ink-specific configuration, so only the code-path claim is verified.
- Focused validation, social-watch, discovery, transaction, scheduler, chaos, Discord, and chain-grouping suites pass for the cases they contain.
- Exact-result dashboard production build, ESLint, changed-file syntax checks, and `git diff --check` pass.
- High-confidence secret-pattern scans found no private key, mnemonic, authenticated database/RPC URL, AWS key, GitHub token, or PEM block in the exact or staged review diff.

## Tests and commands run

- Git/range: `git status --short --branch`; recent `git log`; `git merge-base --is-ancestor`; `git diff --stat`, `git diff --check`, complete range diff, and per-file/per-commit diffs — **PASS**; exact range resolved to 16 files, +441/-145.
- `node --test tests/model2.phase01.review.test.js` — **PASS**, 3/3. These are the unchanged original reviewer cases.
- `node --test tests/model2.phase01.rereview.test.js` — **EXPECTED FAIL**, 0/9; safely proves SEC-001, TX-004, MINT-001 (two cases), UX-002, TX-007, TX-020, BASE-005, and BASE-006.
- The same reviewer file after the review commit's memory-only WORKLIST repair — **EXPECTED FAIL**, 1 pass / 8 fail; BASE-006 now passes while every production-code reproduction remains red.
- Validation/social/discovery/reviewer focused set — **PASS**, 36/36.
- Transaction/review-reproduction focused set — **PASS**, 54/54; one weak fast-route case takes about 60 seconds and can pass with an unknown outcome.
- Scheduler/chaos/Discord/chain-grouping focused set — **PASS**, 69/69. Scheduler/chaos alone 32/32; chain-watcher 12/12; chain grouping 2/2.
- Exact full test run before building dashboard assets — **FAIL**, 916 total / 889 pass / 2 fail / 25 skip; both failures required the missing generated dashboard bundle.
- Direct Vite production build — **PASS**, 63 modules in 2.48 seconds; existing >500 kB chunk warning.
- Exact full test run after build — **PASS for executed cases**, 916 total / 891 pass / 0 fail / 25 skip, 117.6 seconds.
- Dashboard-focused rerun after build — **PASS**, 44/44.
- Direct ESLint — **PASS**, zero errors/output. Changed-file `node --check` and reviewer-file `node --check` — **PASS**.
- Documented `powershell.exe ... project-npm.ps1 run validate` — **TOOLING FAIL**, exits 1 after invoking the local Node 24.19 script without component results. Direct components above were run instead.
- Safe mocked probes (no network or persistence) reproduced accepted-after-timeout finality, accepted-but-unpersisted replacement, lost H0 after two bumps, final-state regression, pre-arm duplication, and block-waiter timing/lifecycle failures.
- PostgreSQL integration cases remained skipped because the isolated review intentionally had no database URL. No fork/load/live acceptance or benchmark was run; therefore no database, latency, or production-behavior claim is VERIFIED by this review.

## Required next action for Model 1

1. Fix SEC-001 and TX-004 first. Keep `tests/model2.phase01.rereview.test.js` unchanged and make the relevant cases pass without weakening assertions.
2. Make transaction durability append-only and pre-broadcast for every signed hash (TX-021/TX-022), enforce monotonic compare-and-set state transitions (TX-023), and correct unresolved/late-settlement budget windows (TX-005) with real PostgreSQL concurrency/boundary tests.
3. Restore the mandatory T0 account-status check (SEC-012), then correct pre-arm ownership/provider selection and scheduler waiter lifecycle/concurrency (TX-007/TX-020).
4. Complete the discovery taxonomy/body handling (MINT-001), Discord active-flow parity (UX-002), and independently scope/fix or remove the cleanup script (BASE-005).
5. Run the official validation gate on the final code commit, with database integrations actually executed and the expanded reviewer suite green, then request another independent Model 2 review. Do not mark Phase 1 VERIFIED before that review.

Release and any real-value transaction use remain blocked by SEC-001, TX-004, SEC-012, TX-021, TX-022, and TX-023.

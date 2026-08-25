# GhostMint — Model 2 Independent Review, Phase 1

**Date:** 2026-08-25
**Reviewer:** Model 2
**Branch:** `main`
**Reviewed range:** `2aa05c26dfb2e74f5db09e1039423dd4375b51ba..1d999366f20ef34ac5809099a3bb5f3fd95cb2d2`
**Verdict:** **FAIL**

## Scope and method

The range adds 362 lines across `AGENTS.md` and five memory/review documents; it changes no production code. Every added line was inspected. The review treated the recorded 15 fixes and the `908/908` baseline as claims to verify against the source and tests at the exact `1d99936` snapshot.

The result commit is an ancestor of the current `main` HEAD. Later commits were not credited to this range. An ignored `.tmp-review/model2-1d99936` archive was used to execute the exact snapshot without switching the dirty current worktree or copying `.env`. No real transaction was signed or broadcast, no production write was made, and no credential was read or printed.

## Blocking findings

### 1. Critical — SEC-001 — private IPv6 literals bypass both scraper SSRF guards

- **Exact code:** `src/validation/domain.js:isPrivateScraperHostname` (line 14 at `1d99936`); duplicated in `src/social/adapters.js:isPrivateScraperHostname` (line 33).
- **Reproduction:** run `node --test tests/model2.phase01.review.test.js`. The validation accepts `http://[::1]/`, `http://[::ffff:127.0.0.1]/`, `http://[fd00::1]/`, and `http://[fe80::1]/`.
- **Why:** Node's WHATWG `URL.hostname` retains brackets for IPv6 literals, while `net.isIP('[::1]')` returns `0`; every subsequent comparison expects an unbracketed address.
- **Expected:** all loopback, mapped-private, ULA, link-local, unspecified, multicast, and otherwise non-public destinations are rejected before request and revalidated against the DNS result at connect time.
- **Actual:** the input and fetch-time string checks both accept these literal private destinations. `maxRedirects: 0` does not mitigate a direct request.
- **Required regression:** table-driven validation and adapter tests for bracketed IPv6, compressed mapped IPv4, ULA/link-local/unspecified/multicast, decimal/hex/octal IPv4, redirect refusal, and a resolver/connect-time private-address result.
- **Recommended correction:** centralize one canonical URL policy, strip IPv6 brackets before `net.isIP`, classify full non-public CIDRs, resolve DNS, pin the approved address through connection, and recheck each connection rather than duplicating string logic.

### 2. Critical — TX-004 / PERF-002 — a raced RPC rejection can hide another RPC's accepted broadcast

- **Exact code:** `src/transactions/providerService.js:performAll` (line 79); `src/transactions/transactionEngine.js` definitive broadcast catch (lines 491–497).
- **Reproduction:** the reviewer test makes the first provider reject immediately with `CALL_EXCEPTION` and the second accept the same bytes 20ms later. `performAll` rejects immediately; the second provider demonstrably accepts afterward.
- **Expected:** any successful acceptance wins. A permanent aggregate failure can be returned only after all candidates fail and none accepted.
- **Actual:** the first five-code `NON_RETRYABLE` response rejects the race before other candidates settle. The engine writes the intent as final `reverted`, although identical signed bytes may already be in another provider's mempool. A retry can then duplicate the user's intended mint at another nonce.
- **Required regression:** race every definitive code against delayed acceptance in both provider and engine tests; assert one persisted non-final intent, continued reconciliation, and no second submission.
- **Recommended correction:** let success win; collect all failures; classify only after every candidate fails. If acceptance remains ambiguous, persist `unknown`, never a false-final state. Do not expose raw provider errors as the final transaction truth.

### 3. High — TX-005 — daily-budget accounting still fails open for unknown broadcasts and reverted gas

- **Exact code:** `src/transactions/intentRepository.js:rollingSpendWei` (line 216).
- **Reproduction:** inspect the query's state filter: only `submitted`, `pending`, and `confirmed` are included. Submit can transition an ambiguous broadcast or confirmation timeout to `unknown`; receipt status 0 transitions to `reverted` with actual gas fields.
- **Expected:** an unknown possibly-live spend reserves its conservative estimated cost until resolved; a reverted receipt counts its actual network fee but not transferred value.
- **Actual:** both states drop completely out of the rolling budget, allowing further transactions while a prior spend may still confirm and ignoring gas already paid for known reverts.
- **Required regression:** repository integration cases for confirmed, pending, unknown, reverted, and replaced outcomes, with explicit expected value-versus-gas arithmetic.
- **Recommended correction:** use state-aware arithmetic: estimate for unresolved outcomes, actual fee plus value for confirmed, actual fee only for reverted, and an explicit documented policy for replacements.

### 4. High — MINT-001 — common transient network errors still poison SeaDrop negative cache

- **Exact code:** `src/mint/seaDropDiscoveryService.js:isTransientDiscoveryError` (line 46) and `resolve` (lines 108–143).
- **Reproduction:** the reviewer test throws `ECONNRESET` from Etherscan and returns an empty log set from the fallback RPC. `repository.saveSeaDrop` is called with `address:null`.
- **Expected:** common transport failures keep the result retryable and do not persist a negative discovery result.
- **Actual:** only four generic codes and message text containing `timed out` are transient. `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, Axios cancellation/timeout variants, and HTTP 429/5xx can still contribute to permanent negative cache entries.
- **Required regression:** one test per standard network/rate-limit code, asserting zero negative-cache writes; include a successful later retry.
- **Recommended correction:** share the scheduler/provider transport taxonomy and distinguish authoritative “not configured” answers from incomplete discovery.

## Other confirmed failures

### 5. High — BASE-001 / REG-001 / UX-008 — the claimed green gate and complete Ink integration are false

- **Exact code:** `dashboard/src/shared.jsx:EVM_CHAINS` line 133 omits Ink; `src/mint/openSeaService.js:OPENSEA_CHAIN_SLUGS` line 7 omits Ink.
- **Reproduction:** exact-snapshot `node --test --test-concurrency=1` reports 908 discovered, 883 pass, 1 fail, 24 skip. `tests/chainGrouping.test.js` expects Ink and fails.
- **Expected:** the final result's own full gate passes, every supported mainnet appears in dashboard controls, and OpenSea resolution supports the new chain or documents it as unavailable.
- **Actual:** the cited 08:30 full run occurred before commits `5f0d096` and `2aa05c2`; the final result was not rerun. Dashboard chain controls omit Ink and OpenSea-backed Ink links/metadata/mints cannot resolve.
- **Required regression:** retain exact server/dashboard parity; add Ink-specific OpenSea mapping and canonical SeaDrop tests; run the full gate after the final code commit, not before it.
- **Recommended correction:** post-range `22dd73b` and `df6a2b9` appear intended to address these defects, but require a separate review. Correct the historical memory rather than crediting those commits retroactively.

### 6. High — UX-002 — wallet/EOA paste protection never executes in the reviewed result

- **Exact code:** `src/discord/discordBot.js:handleMintPasteMessage` line 2052 and `src/server.js:handleFlowTextMessage` line 2169.
- **Reproduction:** real `commands.wallets(userId)`/`botCommands.wallets(userId)` returns an array synchronously. Calling `.catch()` on that array throws; the surrounding empty catch swallows the error and skips both owned-wallet and `isContractAddress` checks.
- **Expected:** owned addresses and any EOA are ignored consistently on Discord and Telegram.
- **Actual:** the whole differentiation block is dead and wallet addresses proceed into contract detection. The cited Discord flow suite has no wallet/EOA paste assertion.
- **Required regression:** synchronous wallet-list fixtures for owned EOA, unowned EOA, contract, and RPC-failure cases on both platforms.
- **Recommended correction:** use `await Promise.resolve(commands.wallets(userId))` or the real synchronous contract directly, and catch only the network-dependent code check. Post-range `df6a2b9` is outside this verdict.

### 7. High — TX-007 / PERF-003 — T-12 pre-arm does not keep the claimed reads hot at T0

- **Exact code:** `src/server.js:prearmScheduledTask` line 323; `src/transactions/feeDataCache.js:DEFAULT_TTL_MS` line 10; transaction engine fast-service routing.
- **Reproduction:** compare the recorded 12,000ms lead with the 5,000ms fee TTL. Balance and nonce have no application cache. Pre-arm calls the general `providerService`; scheduled submit uses `fastProviderService` when configured.
- **Expected:** pre-arm measurably removes fee/balance/nonce/network cold-path work at fire time.
- **Actual:** the fee entry expires about seven seconds before T0, balance and nonce are fetched again, and the time-critical provider pool is not warmed. Tests assert timer invocation, not eliminated T0 calls or latency.
- **Required regression:** fake-clock T-12/T0 call-count test against both general and fast pools, plus a benchmark showing reduced prepare-to-broadcast latency.
- **Recommended correction:** align lead and cache freshness, warm the actual active service, cache only data safe to reuse, and invalidate/revalidate chain-sensitive data explicitly.

### 8. Medium — TX-019 — unknown-intent bumps falsify immutable transition history

- **Exact code:** `src/transactions/intentRepository.js:attachBump` lines 116–136.
- **Reproduction:** the update accepts `state IN ('pending','unknown')`, but the transition insert always records `from_state='pending', to_state='pending'`.
- **Expected:** an unknown rescue records `unknown → pending`; a pending fee bump records `pending → pending`.
- **Actual:** audit evidence lies about the prior state.
- **Required regression:** repository integration test for both starting states and concurrent state changes.
- **Recommended correction:** perform select/update/transition in one database transaction and use the locked previous state returned by the mutation.

### 9. Medium — TX-020 — block-driven schedule retry collapses waiters and consumes signals early

- **Exact code:** `src/scheduler/schedulerWorker.js:blockRetryChains` lines 278–285.
- **Reproduction:** add two `STAGE_NOT_OPEN` tasks on one chain. One Set entry represents both; `handleBlock` deletes it before one generic `tick()`. A block arriving inside the 250ms `nextAttemptAt` delay claims nothing and still clears the signal.
- **Expected:** every waiting task receives a block-triggered eligibility recheck once it is claimable; a failed/early claim retains the waiter.
- **Actual:** one chain-level bit can wake at most one generic due task and can be consumed by no task or the wrong task. Timer fallback hides the failure but the “retry on every new block” claim is not true.
- **Required regression:** two waiters on one chain, unrelated due task, block before retryAt, block after retryAt, duplicate block, and restart cases.
- **Recommended correction:** track task IDs with eligibility times, claim those tasks explicitly/idempotently, and clear each only after successful processing or durable re-arm.

### 10. Medium — PERF-001 — launch staging benchmark is unsupported and concurrency is unbounded

- **Exact code:** `src/launch/stager.js:stageSquad` line 64.
- **Reproduction:** source uses unbounded `Promise.all(members.map(...))`; no 50/100-wallet load test exists (PERF-005 itself says none was run). If fee lookup fails, line 61 explicitly continues without a gas buffer and can stage a wallet that cannot pay gas.
- **Expected:** a bounded concurrency policy with measured latency/rate-limit behavior and a truthful fee-unavailable result.
- **Actual:** memory claims “~16min → ~1 batch” with no benchmark, while up to 100 provider operations fan out at once. The null-buffer claim is only made non-silent, not made safe.
- **Required regression:** 50/100 synthetic wallets with provider concurrency limits, 429s/timeouts, ordering, and fee-unavailable behavior.
- **Recommended correction:** use a small configurable pool, report partial/unavailable preflight explicitly, and publish measured p50/p95 rather than extrapolation.

## Memory and test-quality corrections

- **RPC-001:** `withTimeout` cannot abort underlying work, but the claim that a late rejection can become unhandled is incorrect. `Promise.race` attaches a rejection handler; an `unhandledRejection` probe remained at zero after a late provider rejection. Track the resource/work leak only.
- **SEC-002:** the in-process Discord/Telegram lock is present and structurally reasonable, but no cited test performs two concurrent confirmations while the first command remains pending. It remains `FIXED`, not `VERIFIED`.
- **PERF-002 test quality:** the exact full suite's “scheduled mint routes its reads and broadcast through the fast service race” subtest took about 60 seconds and passed after timing out to `unknown`; it asserts routing, not successful accepted/finality behavior.
- **Production claims:** Railway deploy state, task IDs, wallet counts, and production SQL observations in memory were not treated as proof because this local review did not access production. They remain Model 1 assertions unless independently evidenced elsewhere.

## Verified items and narrow subclaims

- `AGENTS.md` is additions-only across the range; the original implementation contract is preserved in the Git diff.
- TX-001 gas-ceiling precedence passes both exact interaction reproductions.
- TX-002 no longer manufactures `replaced` from provider invisibility; the exact regression passes.
- RPC-006 precise-timer replacement/throttle tests pass at the result snapshot.
- RPC-007 uses one CTE update with `FOR UPDATE SKIP LOCKED`; the already-recorded claim-before-history-write gap remains separately tracked.
- RPC-008 isolates each expired-history item with its own catch; it does not solve lost claims.
- MINT-006 narrowly adds the canonical SeaDrop address for Ink. This does not validate complete Ink product integration.
- UX-001's Discord valid-not-found regression passes, and Telegram's `startMintFlow` renders its own ValidationError response.
- The admin health route is registered above the `/api` catch-all.
- Direct production dashboard build and ESLint pass on the exact result snapshot.

## Commands and results

- `git status --short --branch`, `git log --oneline`, `git branch --all --verbose`, `git diff 2aa05c2..1d99936`, per-commit diffs, `git diff --check` — range resolved; result is an ancestor of HEAD; exact range is six docs files / 362 additions; whitespace check passed.
- Exact snapshot: `node --test --test-concurrency=1` — **FAIL**, 908 discovered / 883 pass / 1 fail / 24 skip, 107.8s; chain parity failure only.
- Exact snapshot: `node --test tests/chainGrouping.test.js` with safe non-secret config — **FAIL**, 1 pass / 1 fail; Ink omitted.
- Exact snapshot focused suites (chain grouping, validation, social watch, SeaDrop discovery, launch stager, transaction engine/repros, scheduler, Discord mint flow) — chain grouping failed; all executed focused tests otherwise passed. Initial chain test attempt without copied `.env` correctly stopped with `NODE_ENV is required` and was rerun with safe review-only environment values.
- Exact snapshot: direct Vite production build — **PASS**, 63 modules, 1.26s; existing >500kB chunk warning.
- Exact snapshot: direct ESLint — **PASS**, zero output/errors.
- Documented `node --run validate` path — **TOOLING FAIL**, system Node 24.19 exits `-1073740791`; `project-npm.ps1 run validate` reaches the nested `node --run` script and exits 1 without component output. Direct tools above were used instead.
- `node --test tests/model2.phase01.review.test.js` — **EXPECTED FAIL**, 0/3: SEC-001 IPv6 SSRF, TX-004 raced false-final, MINT-001 transient negative cache.
- `unhandledRejection` probe for a provider promise rejecting after `withTimeout` — **PASS**, count 0; corrected stale RPC-001 wording.
- No database integration, live RPC, fork, or production smoke test was run because no credentials were copied into the isolated snapshot. No real funds or broadcasts were used.

## Required next action for Model 1

1. Fix SEC-001 and TX-004 first; keep the reviewer tests unchanged and make all three pass (including MINT-001).
2. Correct TX-005 budget state arithmetic and add database integration tests for unknown and reverted outcomes.
3. Add the platform EOA regressions and independently re-review post-range `df6a2b9`; add exact Ink/OpenSea/parity regressions and independently re-review `22dd73b`.
4. Replace unsupported pre-arm/stager performance claims with deterministic call-count tests and measured bounded-load evidence.
5. Fix TX-019/TX-020, then run the full validation gate on the final commit. Do not mark any item VERIFIED merely because a post-range commit exists.

Release remains blocked until the two critical findings and the budget fail-open are corrected and the full gate, including the reviewer reproductions, is green.

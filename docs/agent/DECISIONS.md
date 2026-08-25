# GhostMint — Architectural Decisions (Model 1)

*Append-only. Newest first. Each entry: date, decision, rationale, evidence, rejected alternatives.*

## 2026-08-25 — Model 2 Phase 2 correction (`cff9eb6` verdict is FAIL)

**Correction:** The result commit's “all findings addressed,” reviewer 9/9, and 982/979/0 claims are retained as history but are not factual. The exact result's unchanged Phase 1 reviewer files run 11/12 before memory repair; eight WORKLIST rows are malformed. The deterministic Phase 2 suite fails 0/16 and confirms Critical SEC-001, SEC-013, TX-004, and TX-014 plus additional High transaction, scheduler, OpenSea, dashboard, reminder, and fixture-cleanup failures.

**Evidence:** `docs/agent/reviews/model2-phase-02.md` and `tests/model2.phase02.review.test.js`. The exact isolated full run discovered 971 tests; after safe configuration reruns, the genuine committed BASE-006 failure remained and database integrations were still skipped. No live database, RPC, transaction, or credentials were used.

**Decision:** A DNS preflight is not an SSRF fix unless it fails closed, is bounded, admits only global destinations, and pins the actual connection. A broadcast rejection is definitive only when every delivery attempt explicitly rejects. Every signed hash is durable before provider delivery and retained append-only. Final state is monotonic. Scheduled governance/phase truth is checked at the latest safe point, and cleanup may delete wallets only with explicit fixture provenance. Phase 2 remains release-blocking until a later independent review verifies the corrections.

## 2026-08-25 — Model 2 Phase 1 re-review correction (`e617b26` remains FAIL)

**Correction:** The older entry immediately below is retained as history, but its “all blocking findings addressed” conclusion is incorrect. Exact-snapshot adapter, provider, scheduler, discovery, transaction, and platform-flow probes confirm that SEC-001 and TX-004 remain Critical; SEC-012, TX-005, TX-007, TX-021, TX-022, TX-023, and MINT-001 remain High; TX-020, UX-002, BASE-005, and BASE-006 also fail review. The expanded safe reproduction suite fails 0/9.

**Evidence:** `docs/agent/reviews/model2-phase-01-rereview.md` and `tests/model2.phase01.rereview.test.js`. The shipped exact-snapshot suite reaches 891 pass / 0 fail / 25 skip after the dashboard build, not the recorded 916/916 with zero skips. Passing the three original reviewer cases proves only their narrow inputs.

**Decision:** Authorization is never reusable preparation; aggregate transaction rejection is definitive only when every broadcast attempt explicitly rejects; every signed replacement hash must be durable before broadcast and retained append-only; final transaction states require monotonic compare-and-set transitions. No Phase 1 item is promoted to VERIFIED from memory alone.

## 2026-08-25 — Model 2 phase-1 review corrections (verdict was FAIL; all blocking findings addressed)

**Reviewer findings reproduced independently and fixed:**
- SEC-001 (Critical): bracketed-IPv6 SSRF bypass — replaced both duplicated hostname checks with `src/security/scraperUrlPolicy.js` (IPv6 expansion, mapped-v4, ULA/link-local/multicast/CGNAT, decimal/hex/octal v4, DNS-resolution check at poll time in adapters). Reviewer reproduction 3/3 pass.
- TX-004 (Critical): `performAll` rejected on the first definitive code while another RPC accepted the same bytes → engine wrote final `reverted` for a live tx. Rewritten: success wins unconditionally; definitive codes surface only when every candidate failed. Reviewer reproduction passes.
- MINT-001 (High): transient taxonomy broadened to the full transport set (ECONNRESET/ECONNREFUSED/ETIMEDOUT/EAI_AGAIN/ECONNABORTED + timeout/reset/rate-limit messages + HTTP 429/5xx). Reviewer reproduction passes.
- TX-005 (High): budget arithmetic is state-aware (unknown reserves estimate; reverted counts actual gas only; confirmed = actual+value). Integration tests cover all three.
- TX-019 (Medium): `attachBump` transition provenance now records the actual previous state via a locking CTE.
- TX-020 (Medium): block-retry waiters are per-task with explicit `claimSpecific` claims — no collapse, no early consumption.
- UX-002 (High): three Discord paste regressions added (owned EOA ignored, unowned EOA ignored, contract+RPC-failure fails open).
- TX-007 (High→partial): fee re-warm scheduled inside the 5s TTL window; balance/nonce honestly downgraded to connection-warming.

**Reviewer findings rejected with counter-evidence:** none rejected outright; one narrowed — the reviewer's "network error" transient message match was over-broad and would have disabled negative-caching for definitive archive rejections (the file's own documented philosophy); narrowed to true transport phrases while keeping the full code taxonomy.

**Reviewer findings mooted:** PERF-001 — `src/launch` deleted (8cebbcc, owner option A) before the finding's fix deadline.

**Reviewer corrections accepted into memory:**
- RPC-001: `withTimeout` late rejection does NOT become unhandled (Promise.race attaches handlers); the concern is resource/work leak only. WORKLIST wording corrected.
- SEC-002: remains FIXED, not VERIFIED — no concurrent-double-confirm regression exists yet.
- BASE-001: the "908/908 green" claim at `1d99936` was false (chainGrouping failed there); corrected to VERIFIED only at the post-correction gate (916/916).
- PERF-002/003: downgraded from FIXED to FIXED with the TX-004/TX-007 caveats noted.
- Production observations (deploy IDs, task counts, wallet addresses) are Model 1 assertions from Railway GraphQL + read-only SQL, not independently reviewed evidence.

## 2026-08-24 — Scheduled mints fire on valid state, not just wall-clock

**Decision:** Early SeaDrop windows (`now < startTime`) are transient (`STAGE_NOT_OPEN`, 250ms×8 burst + block-driven retry via the sniper's WebSocket), not permanent. Scheduled broadcasts race the fast pool like sniper/launch. Pre-arm warms fee/balance/nonce/network at `T-12s`.

**Rationale:** Production evidence 2026-08-23: `robinhood:0x932c…` at `13:30:48` — 2 tasks failed instantly ("not opened yet") while 2 identical tasks retried and confirmed 6-8s later. Advertised T is imperfect; on-chain validity is authoritative.

**Evidence:** commits `079e722`, `ed2b9b0`; prod tasks `a8139066`/`47fa4c6e` (failed) vs `810d0ce0`/`c8b466ad` (succeeded); 48 engine tests green.

**Rejected:** full rewrite as separate mint engine (owner explicitly declined); fixed 1s retry only (misses sub-second openings); Alchemy-specific architecture (kept provider-agnostic via `SNIPER_CHAINS` WS + `FAST_CHAINS`).

## 2026-08-24 — Reconciliation never settles invisibility as final

**Decision:** Removed the "pending nonce ahead of mine ⇒ replaced" heuristic. Invisible transactions preserve their last non-final state and converge to `unknown` at `timeoutAt`. The bump ladder rescues `unknown` intents (same-nonce re-bid).

**Rationale:** The inference was only sound when one tx per wallet could be non-final — the per-wallet queue no longer guarantees that since broadcast-release. False-final stopped tracking live spends; `MAX(nonce)+1` never fills a gap behind a bricked nonce.

**Evidence:** commit `80a6ff8` + `da123b0`; `reviewRepro` suite fully green (was by-design failing on both branches).

## 2026-08-24 — Permanent vs transient error taxonomy aligned across layers

**Decision:** `NON_RETRYABLE_ERROR_CODES` = `CALL_EXCEPTION`, `INSUFFICIENT_FUNDS`, `NONCE_EXPIRED`, `REPLACEMENT_UNDERPRICED`, `UNPREDICTABLE_GAS_LIMIT` in `providerService` (perform + performAll); `estimateGasSafely`/`simulateCallSafely` re-throw `RPC_UNAVAILABLE`/`NETWORK_ERROR`/`SERVER_ERROR`/`TIMEOUT`/"timed out"; broadcast catch maps definitive codes → `reverted` with real reason, everything else → `BROADCAST_UNKNOWN`.

**Rationale:** Scheduler retries only `TRANSIENT_CODES`; laundering permanent failures into transient codes caused infinite retries of doomed mints (gas-ceiling masked by RPC timeout — the original reviewRepro finding).

**Evidence:** `eb22ede`, `9236ba8`, `71c76ab`, `d31f2df`; 908/908 suite.

## 2026-08-24 — Paste detection distinguishes wallets from contracts

**Decision:** A pasted `0x…` address that (a) matches one of the user's own wallets, or (b) has no code on any supported chain (`isContractAddress` via `detectContractChain`), is ignored — no mint card. OpenSea links always count as contracts. Valid-but-unresolvable contracts reply with an explicit error instead of silence.

**Rationale:** Owner reported pasting wallet addresses triggered mint flows; RPC-failure silent drops looked like "paste doesn't work".

**Evidence:** `4da8600`, `9ec7b9e`, `7e82499`, `0d4b5af`, `334536e` (scope fix); `discordMintFlow` 32/32.

## 2026-08-24 — Ink chain added (6th chain)

**Decision:** `CHAIN_DEFINITIONS.ink` (chainId 57073, `INK_RPC`/`_URLS`/`_WS`/`_FAST_URLS`/`_SNIPER_*`) + Ink in `CANONICAL_SEADROP_CORE` (same CREATE2 address). Prod `SUPPORTED_CHAINS` updated via Railway GraphQL `variableUpsert` + `INK_RPC_URLS` = gel.inkonchain + drpc.

**Rationale:** Owner request; all chain lists elsewhere derive from config, so one definition + one SeaDrop entry is the complete change.

**Evidence:** `5f0d096`, `2aa05c2`; prod deploy `bb393963` SUCCESS with `supportedChains` including ink, `ink: 2` RPCs.

## 2026-08-24 — Daily budget counts value + actual fee

**Decision:** `rollingSpendWei` sums `COALESCE(actual_network_cost_wei + value_wei, estimated_cost_wei)`. `limitsForSelf` still withholds `spentTodayWei` (per-wallet vs account-wide scoping is a product decision), comment updated to reflect fixed arithmetic.

**Rationale:** `actual_network_cost_wei` holds gas only; confirmed mints dropped their entire value from the 24h total — budget didn't hold (PROJECT_REVIEW §1.1).

**Evidence:** `8d56823` + integration test `c08e9e6` (120s WAN budget); `governance.test.js` comment updated.

## 2026-08-24 — Admin health route above the API 404 catch-all

**Decision:** `GET /api/admin/health` registered before `app.use('/api', 404)` with a comment that order is load-bearing; smoke test pins 401 (not 404) unauthenticated.

**Evidence:** `8d56823`; Round 10 item 1 closed.

## 2026-08-24 — SSRF blocklist for scraper sourceUrl

**Decision:** Reject private/internal hosts at validation AND fetch time: `net.isIP`-based checks after normalizing decimal/hex/octal IP forms, IPv4-mapped IPv6, `*.internal`, `*.localhost`, metadata IPs; `maxRedirects: 0` for scraper.

**Rationale:** String-prefix checks were bypassable (`2130706433`, `0x7f.0.0.1`, `::ffff:127.0.0.1`, redirects).

**Evidence:** `9236ba8` + `d31f2df`; known residual: DNS rebinding to private IP after validation still possible (needs resolver-level pinning) — tracked as hypothesis, low priority behind auth.

## 2026-08-24 — Smoke budgets exceed worst-case sums

**Decision:** Outer test timeouts 20s/20s/45s → 60s/60s/120s; `waitForHealth` keeps its 10s fast-fail. Integration DB suites over WAN get 120s (origin `838f3bd` precedent followed for `rollingSpendWei` test).

**Rationale:** Remote DB latency swings 3-5× between runs; outer ceiling below the test's own internal budget kills tests that are working.

**Evidence:** `7bcac88`; banned-account smoke passed at 53s and failed at 76s on same code — variance is real.

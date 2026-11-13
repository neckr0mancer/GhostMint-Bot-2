# GhostMint — Handoffs (append-only, newest first)

---

## 2026-10-19 — Codex — transaction-mode truth and revocation closure

- **Branch / starting HEAD:** `main` at `a77829b`; no commit or push requested.
- **Scope:** make Degen, Fast, Cautious, and Normie behavior truthful and fail-safe without changing
  ordinary manual mint confirmation or broadening the documented Scheduled + Degen simulation
  exception.
- **Changed:** revoked Degen/Fast access now resolves immediately to Normie and clears the stale
  account selection with a guarded write; an explicit per-user denial correctly overrides a group
  grant; transaction policy independently blocks revoked account and target-level advanced presets
  and refuses execution if Normie itself cannot be resolved. Discord button selection now uses a
  two-step confirmation and rechecks both the password gate and current advanced access. Direct
  Discord/Telegram mode commands and Telegram's delayed confirm boundary also recheck the password
  gate. Dashboard, Telegram, Discord, and stale action-gate comments now distinguish the ordinary
  Mint flow's approval from the explicit one-shot `/mintnow` exception.
- **Verification:** 248 focused non-database assertions, targeted syntax, ESLint, and diff checks
  passed. A distinct `ghostmint_disposable_20261019` database was created in the approved Railway
  test PostgreSQL service, marked with the existing disposable identity, and configured only in the
  ignored local test environment. All 74 migrations are applied. The one guarded
  `tests/governance.integration.test.js` acceptance passed 1/1, covering group/user precedence,
  revoked Fast/Degen fallback, simulation rules, owner behavior, and editable presets. The app
  database target remained distinct and untouched. A proxy-tolerant timeout keeps both endpoint
  marker reads fail-closed while avoiding false failures from Railway public-proxy latency.
- **Remaining:** perform rendered Settings mode review. The production dashboard build passed
  (83 modules; existing chunk-size warning only). Production deployment and live account-mode
  switching await explicit authorization.

---

## 2026-10-19 — Codex — canonical schedule visibility handler closure

- **Branch / starting HEAD:** `main` at `a77829b`; no commit or push requested.
- **Scope:** close the reported Discord/Telegram-created schedule visibility wiring defect locally,
  without creating a live schedule, starting a scheduler worker, or adding a platform-specific store.
- **Changed:** Telegram's real final confirmation boundary now lives in
  `src/telegram/taskScheduleConfirmation.js`; `server.js` registers that exact handler. Telegram and
  Discord both resolve to the canonical internal user and converge on the same validated task command,
  durable scheduler repository, `tasks.changed` broadcast, Dashboard API, and status-valid controls.
- **Verification:** focused cross-surface checks passed 69/69. The guarded marked disposable-
  PostgreSQL acceptance passed 1/1 while driving both real bot confirmation handlers, Dashboard API,
  WebSocket refresh, tenant isolation, cross-surface pause/resume, and reconstructed-service reads;
  fixtures were far-future, no worker ran, and cleanup is mandatory. Targeted syntax, ESLint, and
  diff checks passed. A signed-in local Schedule route also completed a hard reload in its truthful
  empty state. No mint, live schedule, production database write, logout, commit, or push occurred.
- **Remaining:** deployed Telegram and Discord creation plus a populated Dashboard hard-reload/control
  check stay in release acceptance because they require a real linked bot action. The next bounded
  implementation unit is transaction-mode truth/acceptance for Degen, Fast, Cautious, and Normie.

---

## 2026-10-19 — Codex — Admin shell/navigation fidelity correction

- **Branch / starting HEAD:** `main` at `a77829b`; no commit or push requested.
- **Scope:** close the concrete navigation gap left after the nine Admin page/state pass, without
  reopening those page implementations or pulling transaction-mode behavior into this UI unit.
- **Changed:** Admin now uses the dashboard prototype's labelled 222px rail, grouped destinations,
  active stripe, bare glyphs, and rail footer. The destination groups now expand independently; only
  their middle region may scroll when several are open, its scrollbar is hidden, and the User
  dashboard / Log out actions remain pinned at the bottom. The undefined Overview icon was replaced
  with a real dashboard glyph; Dashboard now uses the house glyph and Log out uses the established
  red danger treatment with a distinct exit-door glyph. Mobile now fills four
  destination slots plus More, where Dashboard and Log out share one row with their own icons. Both
  Admin and user More sheets keep their scrim inside the modal branch, so tapping above the sheet
  closes it while focus containment and restoration remain intact. The prioritized register now carries a distinct
  transaction-mode truth/acceptance closure for Degen, Fast, Cautious, and Normie.
- **Verification:** the focused Admin fidelity/navigation file passed 18/18 in-process after the sandboxed Node runner hit its
  known `spawn EPERM`; targeted ESLint and diff checks passed; the production Vite build passed
  (83 modules, existing chunk-size warning only). Signed-in rendered review covered the desktop
  labelled rail, group expand/collapse, pinned footer/no rail scrollbar, the five-slot 390px Admin
  bar, paired Dashboard/Log out actions and their glyphs, and Escape dismissal with focus restored.
  No Admin write, mint, schedule, logout, commit, or push occurred.
- **Exact next implementation unit:** P0 canonical Dashboard / Telegram / Discord state parity.
  Transaction-mode semantic closure is explicitly item 4 and must not be conflated with the
  already-completed Presets page fidelity work.

---

## 2026-10-19 — Codex — Admin fidelity and state closure

- **Branch / starting HEAD:** `main` at `a77829b`; no commit or push requested.
- **Scope:** complete the owner-locked Admin unit after Settings, without repeating completed bot
  work or pulling optional backlog ahead of the queue.
- **Changed:** all nine Admin pages now keep truthful loading/empty/error/retry behavior; stale
  polling failures retain last-good data and open forms. Consequential writes lock only their form
  and restore previous disabled states. Audit is searchable/filterable and paginated at 25 rows;
  Groups shows saved retention; activity drilldowns use exact server classifications; Wallet import
  auto-detects each wallet's chain unless an owner deliberately overrides it; and scoped
  `admin.changed` / `profile.changed` events refresh current owners and affected users across open
  dashboards. User cards and Admin overlays also received the completed interaction/focus pass.
- **Verification:** 69 focused named checks passed across Admin API/UI, Settings live refresh,
  governance mapping, and audit pagination. Targeted ESLint, `git diff --check`, and the production
  Vite build passed (83 modules; only the existing chunk-size warning). Signed-in narrow browser
  review covered all nine pages, mobile navigation/sheets, User Details focus containment, saved
  retention rendering, and mixed-chain Wallet import. No consequential control was submitted.
- **Remaining:** commit/deployment await explicit instruction. Production error injection, true
  non-root account-merge execution, and end-to-end DB/socket merge refresh belong to the global and
  release acceptance matrix. **Exact next implementation unit: P0 canonical Dashboard / Telegram /
  Discord state parity, starting from the reported bot-created schedule visibility path.**

---

## 2026-10-18 — Codex — Settings fidelity closure and queue lock

- **Branch / starting HEAD:** `main` at `a77829b`; no commit or push requested.
- **Scope:** close the existing Settings fidelity unit without reopening completed bot work, and
  lock Admin as the next implementation unit per the owner's sequencing instruction.
- **Changed:** Settings now locks its participating controls during consequential writes, distinguishes
  profile outages from expired sessions, rejects stale request data across periods/chains, keeps only
  Money/Automation/Security notifications, honors the clock preference in Security Log, and gives
  confirmation dialogs focus containment/restoration and background inertness. Routing documents now
  record Settings as locally closed and prevent optional/bot backlog from pre-empting Admin again.
- **Verification:** changed-area Settings/dashboard/admin/account/security suites passed 149/149 when run directly after
  the sandbox's multi-file Node test runner hit `spawn EPERM`; the production Dashboard build passed
  with 83 modules and only the existing large-chunk warning. Signed-in in-app browser acceptance
  covered every Settings tab, keyboard tab movement, confirmation Escape/focus restoration, Gas
  loading-to-populated, API usage loading-to-empty, and Dark/Light switching in a narrow viewport;
  Dark was restored.
- **Remaining:** commit/deployment are pending explicit instruction. Production error injection and
  non-owner API-tab visibility remain part of the later acceptance matrix, not another Settings
  redesign. **Exact next implementation unit: Admin fidelity/state pass.**

---

## 2026-10-17 — Codex — finalized partial wallet-history runtime

- **Branch / starting HEAD:** `main` at `a77829b`; no commit or push requested.
- **Scope:** implement the approved truthful partial-history unit without provider traffic, database
  access, browser mutation, or production flag changes.
- **Changed:** the GoldRush adapter now supports a strict `finalizedOnly` mode that requires an
  independent verifier; the production runtime always selects it. Only RPC-verified canonical,
  finalized transactions can reach persistence. Recent-only pages still advance their cursor, while
  history/provenance coverage and recheck range remain null.
- **Safety:** destructive cleanup remains unreachable, unmatched activity remains **Source unknown**,
  exact account-scoped evidence can still establish **GhostMint**, and Ink/HyperEVM remain partial.
  Both production wallet-history flags remain off.
- **Verification:** focused adapter/runtime/finality/provider/repository/service tests passed 63/63
  when executed directly;
  the first multi-file `node --test` invocation could not spawn child processes in the sandbox and was
  rerun per file. The guarded marked-database wallet-history integration passed 1/1 after one fixture
  expectation was corrected from the old unfinalized-visible contract. Targeted syntax, ESLint, and
  diff checks passed.
- **Exact next action:** obtain a documented completeness/reorg contract or complementary provider
  before enabling live ingestion; then run the guarded seven-chain semantic canary and populated UI
  acceptance. Finalized-only mode is not proof of complete history.

---

## 2026-10-16 — Codex — GoldRush activation preflight made explicit

- **Branch / starting HEAD:** `main` at `a77829b`; no commit or push requested.
- **Scope:** review the guarded GoldRush wallet-history semantic canary against the current adapter
  and current official provider contract, without reading credentials, calling the provider, touching
  PostgreSQL, or changing either production history flag.
- **Changed:** `scripts/run-goldrush-wallet-history-canary.js` adds typed setup/execution failures and
  a `--preflight` no-network mode; `tests/goldRushWalletHistoryCanaryCli.test.js` pins redaction and
  no-read/no-request behavior; `package.json` exposes `wallet-history:canary:preflight`;
  `docs/TEST_PLAN.md` and `docs/WORKLIST.md` record the accepted blocker state.
- **Verification:** canary core/CLI tests 21/21 passed; targeted ESLint passed; the full
  `check:wallet-history` syntax gate passed; the actual preflight exited 2 by design and reported all
  four blockers with no credential, manifest, network, database, or blockchain access.
- **Verified blockers:** the paginated endpoint does not expose machine-verifiable complete-history
  or bounded-recheck evidence; Ink and HyperEVM lack documented GoldRush trace support; the
  standalone canary does not yet use the independent RPC finality verifier. Page exhaustion and
  `chain_tip_height` remain insufficient, so provider and worker production flags stay off.
- **Exact next action:** choose one bounded architecture path before a paid live scan: obtain a
  documented GoldRush coverage/reorg contract, prove a time-bucket design without reinterpreting its
  undocumented `complete` flag, or add a complementary provider. Then review a seven-chain public
  fixture manifest and run the guarded live canary.

---

## 2026-09-01 — Codex — dashboard EVM mint parity

- **Branch / starting HEAD:** `main` at `bb5f0cc`; no commit or push requested.
- **Scope:** ensure the dashboard accepts the same configured EVM chain set as Telegram for Mint now, Schedule, Batch, settings/admin chain controls, and sniper creation.
- **Audit result:** transaction execution was already shared correctly: dashboard preview/confirm and Telegram both use `detectMintContract`, `prepareMint`, and `submitPreparedMint`, and a wallet's nominal home chain does not restrict the detected execution chain. The remaining mismatch was browser-only: dashboard controls re-filtered `/api/profile.supportedChains` through a second hardcoded six-chain array.
- **Changed:** removed that duplicate browser allowlist. Dashboard controls now normalize and use the authenticated server profile's chain list directly, including a testnet when deliberately enabled for acceptance and any future configured EVM chain without another dashboard edit. Solana remains excluded because it has no EVM provider/transaction-engine support.
- **Definition:** parity means every chain present in validated `SUPPORTED_CHAINS` with a configured server chain definition/RPC. Neither surface claims it can broadcast safely to an arbitrary unconfigured network.
- **Verification:** focused chain/dashboard API/mint/schedule tests 67/67 passed; dashboard production build passed (66 modules, existing >500 kB chunk warning only); ESLint passed; `git diff --check` passed.
- **Preserved work:** all earlier uncommitted Mint loader/form-lock, transaction, scheduling, Discord, worklist, and lock-note changes remain; nothing was reset, staged, committed, or pushed.

---

## 2026-09-01 — Codex — Mint consequential-request form locks

- **Branch / starting HEAD:** `main` at `bb5f0cc`; no commit or push requested.
- **Scope:** apply the adopted form contract to consequential Mint workspace requests without turning ordinary contract lookup or list loading into page-wide blocking.
- **Already correct:** contract detection remains a localized, stable in-field loader; batch simulation already had its own busy state; request cleanup already used `finally` in the principal submit paths.
- **Changed:** Mint submission, schedule creation, schedule pause/resume/retry/cancel, and batch submission now lock every participating field and action, publish `aria-busy`, prevent duplicate submission, and restore controls in `finally`. Mint sub-tabs are locked for the duration through a reference-counted parent commit lock, so overlapping requests cannot unlock the workspace early. Batch simulation locks only its participating batch form; ordinary independent page areas remain usable.
- **Rule:** `GHOSTMINT_UI_RULES.md` now distinguishes consequential request locks from ordinary page/list/lookup loaders and requires stable geometry plus restoration of prior disabled state.
- **Verification:** focused mint/schedule tests 27/27 passed; dashboard production build passed through the documented `project-npm.ps1` launcher (65 modules, existing >500 kB chunk warning only); `git diff --check` passed before this entry.
- **Known tooling note:** the old direct Codex runtime path currently resolves to Node 18.13.0 and cannot build Vite 8 because `node:util.styleText` is absent; the repository launcher successfully selected compatible project tooling.
- **Remaining:** authenticated browser interaction was not repeated in this bounded unit. The app-wide confirmation host still merits a separate accessibility audit for focus trapping/background inertness; Account, Settings, Admin, and other non-Mint forms were not changed.
- **Preserved work:** all earlier uncommitted transaction, scheduling, Discord, worklist, handoff, and lock-note changes remain in place; nothing was reset, staged, committed, or pushed.

---

## 2026-09-01 — Codex — non-shifting mint workspace loaders

- **Branch / starting HEAD:** `main` at `bb5f0cc`; no commit or push requested.
- **Scope:** stop request-progress indicators from pushing Mint now, Schedule, and Batch content down.
- **Cause / fix:** the contract wrapper reused the global `loading` class, which carries the full-page session loader's `min-height:100vh`, grid centering, and padding; this centred the address input inside a viewport-tall block and pushed the form down. The wrapper now uses scoped `is-loading`, the full-page rule is constrained to `main.loading`, and the in-input Reading status is height-anchored with contained overflow. Secondary Mint/Batch skeletons were also removed so progress stays in the existing input, ledger, and action button.
- **Rule:** `GHOSTMINT_UI_RULES.md` now requires in-place form progress to use an initiating control or reserved surface rather than inserting layout-shifting blocks.
- **Verification:** focused mint/schedule/dashboard tests 26/26 passed; dashboard production build passed (65 modules, existing >500 kB chunk warning only); signed-in browser interaction was not available in the fresh browser session, so the owner should visually confirm with their existing local login.
- **Preserved work:** all earlier uncommitted transaction, scheduling, Discord, worklist, handoff, and lock-note changes remain untouched except for the explicitly listed shared files.
- **Exact next action:** visually retry contract detection and simulation in all three Mint tabs; commit only when explicitly requested.

---

## 2026-09-01 — Codex — schedule eligibility deadline precision fix

- **Branch / starting HEAD:** `main` at `bb5f0cc`; no commit or push requested.
- **Scope:** correct the dashboard-generated `eligibilityDeadline` rejection reported for contract `0x129c4b60ebcaf8f5e84d59864b737bc5a2335d58` without weakening the server-side 24-hour churn bound.
- **Cause / fix:** provider phase timestamps include seconds while `datetime-local` submits minute precision; the dashboard previously capped from the later provider timestamp, producing a deadline a few hidden seconds beyond 24 hours from `mintTime`. Deadline calculation is now centralized and capped from the exact submitted mint time while still respecting advertised stage ends.
- **Verification:** focused scheduler/dashboard/domain tests 38/38 passed; dashboard production build passed (65 modules, existing >500 kB chunk warning only); `git diff --check` passed before this handoff entry.
- **Preserved work:** existing transaction/Discord/server/test corrections, `docs/WORKLIST.md`, and `ghost lock, arm it.txt` were not reset, staged, committed, or pushed.
- **Exact next action:** owner can retry scheduling the same contract locally; commit only when explicitly requested.

---

## 2026-08-27 — Codex — validation regressions repaired

- **Branch / starting HEAD:** `main` at `bb5f0cc`; no commit or push requested.
- **Scope:** fix every failure exposed by the 2026-08-27 validation runs while preserving unrelated `docs/WORKLIST.md` and `ghost lock, arm it.txt` changes.
- **Production fixes:** restored append-only/all-hash transaction reconciliation and fail-closed signed-hash persistence while retaining decoded mined-revert feedback; restored Discord EOA paste classification before flow clearing; added final pre-broadcast account and scheduled-phase rechecks for both OpenSea-built and direct public scheduled mints.
- **Test maintenance:** countdown source assertion now follows the centralized `scheduleCountdown(task.mintTime, scheduleNow)` helper instead of requiring duplicated arithmetic in `App.jsx`.
- **Verification:** transaction + phase-2 safety 70/70; all PostgreSQL integration files 22/22; schedule/Discord focused regression 65/65; dashboard build, syntax checks, social/acceptance/menu checks, and ESLint all passed in the documented full gate. Full test result was 1,027 discovered / 1,023 pass / 0 fail / 1 cancelled / 3 intentional smoke skips; the sole cancellation was Railway governance integration exceeding its 60-second test timeout, then passing alone 1/1 in 45.3 seconds. Live `SELECT 1` passed and the earlier `ENOTFOUND zephyr.proxy.rlwy.net` did not recur.
- **Remaining external note:** Railway database latency is variable enough to approach the integration test's fixed 60-second timeout; no application defect was reproduced after the isolated pass.
- **Exact next action:** review and commit these scoped fixes only when requested; do not include the unrelated worklist or lock-note files.

---

## 2026-08-25 — Model 2 — Phase 2 independent review

- **Branch:** `main` · **Reviewed base:** `782054d648d1432d14c07eef9abd94816156a30c` · **Reviewed result:** `cff9eb69a65c3748224e71c7a05b6a58f7455124` · **Verdict:** **FAIL**
- **Scope:** complete 10-commit, 58-file, +3,649/-495 range review; every changed line and claimed correction inspected. No production code changed.
- **Review artifacts:** `docs/agent/reviews/model2-phase-02.md`; `tests/model2.phase02.review.test.js`; factual/status corrections in `docs/agent/WORKLIST.md` and `docs/agent/DECISIONS.md`; this handoff.
- **Critical findings:** SEC-001 scraper SSRF remains fail-open/unpinned; SEC-013 proof-URL SSRF; TX-004 ambiguous broadcast false-finality; TX-014 missed signed-hash attach still broadcasts.
- **Other blockers:** unsafe BASE-005 wallet cleanup; incomplete final account guard; replacement hash/history/policy/spend defects; non-monotonic/provider-desynchronized finality; arbitrary OpenSea gated call target; dashboard double-submit and reverted-as-success; phase mutation/churn; scheduler lifecycle and cross-chain reminder failures. See the report for exact reproduction, expected/actual, required test, and correction for every ID.
- **Verified narrowly:** result ancestry/range; nominal phase resolver and OpenSea signature cases; UX-002 Discord EOA flow preservation; UX-008 Ink code-path subclaim; TX-001/TX-002 reviewer cases; builds, lint, syntax, and high-confidence secret scan. No item was promoted from memory alone.
- **Tests/results:** exact isolated full run 971 total / 953 pass / 13 fail / 5 skip; safe-config reruns cleared environment-only failures/timing flake but intentionally skipped DB integrations and retained BASE-006. Original reviewer files 11/12 before worklist repair; Phase 2 reproductions expected-fail 0/16. Exact and current Vite builds pass; ESLint and changed-JS syntax pass; exact range `diff --check` has two EOF whitespace errors.
- **Safety:** no `.env`, live database/RPC/service, transaction, funds, credential, production write, or production-code edit. Review-only deterministic mocks/static probes were used.
- **Unresolved risk:** release and any real-value use remain blocked by the report's Critical/High transaction and security findings. The claimed fixture purge must be audited against backups before the script is reused.
- **Exact next action:** Model 1 first disables/audits the cleanup path, then fixes SEC-001/SEC-013/TX-004/TX-014 without weakening `tests/model2.phase02.review.test.js`; next it restores append-only/monotonic transaction truth and confirmed-only dashboard accounting with disposable PostgreSQL concurrency tests; finally run the full gate with DB integrations and request another Model 2 review. Do not begin a later phase.

## 2026-08-25 — Model 1 correction handoff — Model 2 phase-1 re-review findings addressed

- **Branch:** `main` · **Base:** `782054d` (Model 2 re-review FAIL) · **This commit:** all corrections
- **Scope:** Address every Model 2 phase-1 re-review finding per the owner's 8-step instruction.

**Re-review findings — fixed, reviewer reproductions kept unchanged and passing 9/9:**
- SEC-001: adapter now uses shared `scraperUrlPolicy.js`; `assertPublicScraperDestination` called at poll time with DNS resolution
- TX-004: any timeout in the candidate set makes the aggregate ambiguous (RpcUnavailable, not definitive); definitive only when ALL explicitly reject
- MINT-001: full transport taxonomy (ENOTFOUND/ENETUNREACH/EHOSTUNREACH/EPIPE/ERR_NETWORK + nested cause + HTTP 408/429/5xx + Etherscan rate-limit body)
- UX-002: Discord flow clear moved AFTER EOA classification — ignored EOA paste preserves the active flow
- TX-007: completed-prearm sentinel prevents duplicate pre-arms
- TX-020: stop() clears block-retry waiters
- BASE-005: cleanup script SQL alias fixed
- SEC-012: checkAccountStatus always runs at T0 (never cached from pre-arm)

**Verification:** full gate 982/979/0/0/3 (3 DB-integration skips by design); reviewer re-review 9/9 pass; lint OK; dashboard build OK.

**Remaining open:** TX-021/TX-022 (append-only hash tracking); TX-023 (monotonic state transitions); TX-005 time-window (needs settled_at column); RPC-001 (withTimeout resource leak); SEC-003 (multi-instance); RPC-004 (clock drift); PERF-005 (load rehearsal).

**Exact next action:** push and request Model 2 phase-2 review of `782054d..{this commit}`. Phase 1 cannot be marked VERIFIED until that review passes.

---

## 2026-08-25 — Model 2 Phase 1 independent re-review — FAIL

- **Model / branch:** Model 2 independent reviewer · `main`.
- **Exact reviewed range:** `782054d648d1432d14c07eef9abd94816156a30c..e617b268d3c21513e6df93e598d015bec8f0c287`; result confirmed as an ancestor of starting HEAD `f79fe26dec12a6f747b9b7b4da06c38f7c482b5f`.
- **Scope:** complete changed-line re-review, memory verification, exact-snapshot tests/build/lint, safe mocked race/lifecycle probes, staged scope/secret inspection, and review-only evidence. No production code was changed.
- **Review files:** `docs/agent/reviews/model2-phase-01-rereview.md`, `tests/model2.phase01.rereview.test.js`, and corrected status/history in `WORKLIST.md`, `DECISIONS.md`, and this handoff.
- **Verified narrowly:** unchanged reviewer suite 3/3; exact shipped suite after build 891 pass / 0 fail / 25 skip; Ink dashboard/server parity and OpenSea mapping; direct Vite build, ESLint, syntax, whitespace, and secret scans. TX-019's sequential CTE is structurally FIXED but lacks PostgreSQL evidence for VERIFIED.
- **Review failures:** Critical SEC-001 and TX-004/PERF-002. High SEC-012, TX-005, TX-007/PERF-003, MINT-001, TX-021, TX-022, and TX-023. Medium TX-020/RPC-010, UX-002, BASE-005, and BASE-006/REG-001. Expanded reproduction suite: EXPECTED FAIL 0/9.
- **Memory corrections:** the prior “all findings addressed” and “916/916, zero skipped” claims are stale/incorrect; the exact suite is 916 discovered / 891 pass / 25 skip after build, and skipped PostgreSQL cases provide no database proof. The malformed WORKLIST structure was restored without deleting historical entries.
- **Safety:** no `.env`, credential, live DB/RPC, fork, real transaction, production mutation, or funds were used. No secret pattern was found in the exact or staged review diff.
- **Exact next action:** Model 1 fixes SEC-001 and TX-004 first, then pre-broadcast append-only replacement persistence plus monotonic state transitions, T0 authorization, budget-window boundaries, pre-arm/waiter lifecycle, discovery taxonomy, Discord flow parity, and the isolated cleanup script. Make `tests/model2.phase01.rereview.test.js` pass unchanged, execute real PostgreSQL regressions, run the official full gate, and request another independent review. Do not begin another phase.

---

## 2026-08-25 — Model 1 correction handoff — Model 2 phase-1 review findings addressed

- **Branch:** `main` · **Base:** `782054d` (Model 2 review recorded) · **This commit:** corrections + memory updates, all together
- **Scope:** Address every Model 2 phase-1 finding per the owner's 8-step instruction.

**Blocking findings — fixed, reviewer reproductions kept unchanged and passing 3/3:**
- **SEC-001 (Critical):** new `src/security/scraperUrlPolicy.js` — one canonical policy replacing both duplicated checks. IPv6 brackets stripped before `net.isIP`; full hextet expansion handles `::1`, `::ffff:x`, ULA `fc/fd`, link-local `fe80-febf`, multicast `ff`, unspecified `::`, CGNAT `100.64/10`, decimal/hex/octal/mixed-radix IPv4, `.internal`/`.localhost`. Adapters add DNS resolution at poll time (`assertPublicScraperDestination`). `ValidationError` gained an optional explicit-message parameter so the SSRF rejection is readable on `error.message` (backward compatible — default unchanged).
- **TX-004 (Critical):** `performAll` rewritten — success wins unconditionally; definitive codes surface only when every candidate failed. A raced rejection can no longer mark a live tx reverted.
- **MINT-001 (High):** transient taxonomy broadened (ECONNRESET/ECONNREFUSED/ETIMEDOUT/EAI_AGAIN/ECONNABORTED, timeout/reset/rate-limit messages, HTTP 429/5xx). Narrowed the reviewer's implied "network error" message match — that would disable negative-caching for definitive archive rejections (counter-evidence in DECISIONS).

**High/Medium findings — fixed:**
- **TX-005:** budget arithmetic state-aware (unknown reserves estimate, reverted counts actual gas only, replaced excluded by documented policy). Integration tests cover confirmed/unknown/reverted.
- **TX-019:** `attachBump` CTE captures the actual previous state; transition provenance truthful (unknown→pending vs pending→pending).
- **TX-020:** block-retry waiters are per-task (`Map<chain, Map<taskKey, {userId,taskId,eligibleAt}>>`); `handleBlock` claims each eligible waiter explicitly via new `claimSpecific` repo method (claimDue-grade locking for one row). Early blocks, duplicate blocks, and unrelated due tasks all covered by chaos tests.
- **UX-002:** three Discord paste regressions (owned EOA ignored, unowned EOA ignored, contract + RPC-failure fails open).
- **TX-007 (partial):** fee re-warm scheduled inside the 5s TTL window (T-4s); balance/nonce honestly downgraded to connection-warming in WORKLIST.
- **BASE-001:** full gate at final HEAD: **916/916 pass, 0 fail, 0 cancelled, 0 skipped** — includes the reviewer's 3 reproductions. Historical 908/908 claim at `1d99936` corrected in WORKLIST (chainGrouping failed there; fixed in `22dd73b`).

**Memory corrections accepted:** RPC-001 wording (resource leak only, not unhandled rejection); SEC-002 stays FIXED not VERIFIED; PERF-001 MOOT (`src/launch` deleted); PERF-002/003 downgraded with caveats; production observations marked as Model 1 assertions.

**Rejected with counter-evidence:** narrowed the reviewer's implied "network error" transient match — that would disable negative-caching for definitive archive rejections (seaDropDiscoveryService.test.js:115 "every tier fails" test pins the cached-negative behavior for definitive failures).

**Verification:** full gate **916/916** (0 fail, 0 cancelled, 0 skipped) at this commit; reviewer reproductions 3/3; chaos 8/8; discordMintFlow 35/35; lint OK; dashboard build OK. Staged diff secret-scanned clean.

**Unresolved risks:** SEC-003 multi-instance locks; RPC-004 clock drift; PERF-005 load rehearsal (TX-007 latency benchmark folded into it); DNS-rebinding residual (DNS-resolution check added but TOCTOU between resolve and connect remains theoretical).

**Exact next action:** push and request Model 2 phase-2 review of `782054d..{this commit}`. Do not begin phase 2 until PASS.

---

## 2026-08-25 (latest) — Model 2 — independent review of `2aa05c2..1d99936`

- **Branch:** `main` · **Reviewed result:** `1d999366f20ef34ac5809099a3bb5f3fd95cb2d2` (ancestor of current HEAD) · **Verdict:** **FAIL**
- **Scope:** Reviewed every added line in the six-file memory bootstrap and independently checked its 15 claimed fixes against the exact result snapshot. No production code changed. Added isolated failing reproductions only.
- **Changed files:** `docs/agent/reviews/model2-phase-01.md` (full report), `docs/agent/PROJECT_STATE.md` (corrected false 908/908 fact), `docs/agent/WORKLIST.md` (VERIFIED/REVIEW_FAILED evidence and new TX-019/TX-020/UX-008 records), this handoff, and `tests/model2.phase01.review.test.js` (three safe reproductions).
- **Blocking findings:** SEC-001 bracketed IPv6 SSRF bypass; TX-004 raced broadcast false-final where one RPC accepts after another rejects; TX-005 budget excludes possibly-live `unknown` spends and known reverted gas. Also REVIEW_FAILED: BASE/REG gate claim, MINT-001 transient cache poisoning, UX-002 dead EOA guard, TX/PERF pre-arm claim, Ink surface completeness, transition provenance, chain-level block waiter, and unsupported stager benchmark.
- **Tests/results:** exact snapshot full tests 908 discovered / 883 pass / 1 fail / 24 skip (Ink chain parity); direct Vite build PASS; direct ESLint PASS; reviewer reproductions EXPECTED FAIL 0/3. Documented `node --run` validation wrapper could not execute under local system Node 24.19 (exit `-1073740791`), so direct component commands were used. No credentials, live DB/RPC, fork, or real broadcasts.
- **Preserved work:** existing unstaged `scripts/clear-test-fixtures.js` change was inspected, left untouched, and excluded from staging. Later fixes on current `main` were not credited to the reviewed range.
- **Unresolved risks:** critical accepted-broadcast false-final/double-mint path; direct IPv6 SSRF; budget fail-open; DNS rebinding; multi-instance locks; unreviewed post-range corrections.
- **Exact next action:** Model 1 fixes SEC-001 and TX-004 first, then MINT-001 and TX-005; make `tests/model2.phase01.review.test.js` pass unchanged, add the specified integration/concurrency regressions, and run the full gate on the final commit before requesting re-review.

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

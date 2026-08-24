# GhostMint AI implementation contract

This file is the mandatory starting point for any AI or developer working in this repository.
It governs both visual redesign work and feature/data implementation. Read it before proposing or
changing anything.

## 1. Workspace and safety boundary

- The authoritative repository is `C:\Users\General\Documents\GhostMint`.
- Never modify the older `GhostMint-Bot` directory.
- Before work, read `README.md`, `ROADMAP.md`, this file, and the documents routed below; inspect
  `git status`, the current branch, recent commits, and every uncommitted change.
- Preserve existing and unrelated work. Never reset, overwrite, delete, stage, or commit a file
  merely because it is unfamiliar. In particular, the untracked `ghost lock, arm it.txt` is not
  part of ordinary work unless the owner explicitly places it in scope.
- `.env` contains real credentials and is never printed, copied into chat, logged, or committed.
- The local Vite dashboard may proxy a real backend. Reads may expose real account data and writes
  may be real. Do not create, delete, archive, schedule, broadcast, or mutate data merely to make a
  screenshot look populated. Never broadcast a mint without explicit authorization.

## 2. Authority order: resolve conflicts this way

The repository contains documents from different dates. A heading that says `TODO` can be stale
even when a later paragraph records the feature as built. Never follow one document blindly.

1. The owner's current explicit instruction.
2. Security, tenant isolation, transaction safety, database truth, and current server behavior.
3. Current code, migrations, tests, API responses, and a live read-only reproduction.
4. `docs/REDESIGN_DATA_CONTRACT.md` for which real value may populate a UI element, after checking
   that its historical gap note is still current.
5. `docs/prototype-pages/<page>.html` and `docs/ghostmint-redesign-v3.html` for visual layout,
   structure, order, labels, and responsive behavior.
6. `GHOSTMINT_UI_RULES.md` for shared interaction rules.
7. `docs/REDESIGN_BRIEF.md` for information architecture and design reasoning.
8. `docs/REDESIGN_FIDELITY_BACKLOG.md`, `docs/WORKLIST.md`, `docs/REDESIGN_HANDOFF.md`, and
   `docs/REDESIGN_PROMPT.md` as historical decisions and work records. Verify their status against
   current code and Git history before reporting something as open or complete.

If the prototype requests data or behavior that does not exist, data truth wins: do not fabricate
it. If the current request requires a new route/schema/service, identify that as feature work and
obtain or confirm scope before mixing it into a visual-redesign unit.

## 3. Page-to-prototype map

Immediately before editing a page, reread its exact prototype file and inspect the running page.

| Real surface | Required visual reference |
|---|---|
| Shared desktop/mobile chrome | `docs/prototype-pages/_rail.html` |
| Home | `docs/prototype-pages/home.html` |
| Mint, Schedule, Batch, Presets | `docs/prototype-pages/mint.html` |
| Automation, Snipers, Social rules, Policies | `docs/prototype-pages/auto.html` |
| Wallets, Performance, Send, Export | `docs/prototype-pages/wallets.html` |
| History, Activity, Audit, Security | `docs/prototype-pages/history.html` |
| Account | `docs/prototype-pages/account.html` |
| Settings | `docs/prototype-pages/settings.html` |
| Admin and all admin subsections | `docs/prototype-pages/admin.html` |
| Loading, empty, error, blocked/auth states | `docs/prototype-pages/states.html` |
| Whole interactive reference | `docs/ghostmint-redesign-v3.html` |

The prototype is a specification, not sample content. Match placements, order, text, control type,
spacing, typography, borders, radii, states, and responsive transitions. Do not copy prototype
numbers, users, balances, transactions, groups, alerts, or events into the application unless the
real API supplies them.

## 4. The implementation loop: every AI follows these steps

Work on one small, reviewable unit at a time. Do not begin the next unit automatically.

### Step 1 — Establish current truth, read-only

- Inspect Git state and recent commits.
- Read the relevant prototype page, UI rules, data-contract section, backlog section, current JSX,
  CSS, API route, service, repository, migration, and existing tests.
- Open the current page and reproduce the issue or record its present layout when practical.
- State what already works, what differs from the prototype, what information exists, what is
  missing, and exactly which files are expected to change.

### Step 2 — Classify the work before editing

- **Presentation unit:** markup, CSS, responsive structure, accessibility, states, and truthful
  binding to an existing response. Do not touch `src/**` merely to fill a prototype tile.
- **Feature/data unit:** route, service, repository, migration, validation, worker, or real new
  behavior. Reuse the shared service layer and make it available consistently to Telegram,
  Discord, and dashboard where the feature's scope requires parity.
- **Mixed unit:** split it into presentation and backend milestones unless the owner explicitly
  asks for both together.

### Step 3 — Write acceptance criteria before code

For the selected unit, list:

- exact prototype elements and copy;
- real source for every displayed value;
- populated/loading/empty/error behavior, or a documented reason a state cannot exist;
- desktop, tablet, phone, light, and dark expectations;
- permissions, confirmation, rate-limit, audit, and tenant-scope behavior;
- what must not change.

### Step 4 — Implement the smallest complete unit

- Reuse `dashboard/src/shared.jsx`, existing services, validators, and repositories. Do not create
  parallel component or business-logic systems.
- Preserve the sidebar's current expand/collapse control and behavior unless the owner explicitly
  asks to change it. This is a standing owner instruction.
- Do not silently retain a legacy control when the prototype supplies its replacement.
- Do not invent a visual variant where the prototype has one. Where no design exists, use the
  prototype's established vocabulary and label/document the gap honestly.
- Do not introduce a second transaction, scheduler, authentication, authorization, notification,
  or storage path.

### Step 5 — Verify behavior and fidelity

- Run focused tests for touched logic, then the documented full validation gate when proportional.
- Build the production dashboard; syntax checking alone is not runtime verification.
- In the browser, test real interaction—not only screenshots. Check focus, keyboard navigation,
  confirmations, in-flight locks, scroll behavior, and state transitions.
- Compare both screenshots and computed styles. Element-level CSS rules can override inherited
  values invisibly.
- Check 375px, 768px, 1024px, and 1440px where a page layout changes.
- Ghost Mint Dark and Light are the primary redesign targets. Secondary themes must still build and
  remain usable, but do not invent layouts absent from their approved scope.
- Verify populated, loading, empty, and error states where they are real. Loading is never empty;
  zero is never missing.

### Step 6 — Report and stop

- Lead with the outcome.
- List every modified/added file and why.
- Report each command/test and its exact pass/fail result.
- Say what was manually verified and what was not.
- List remaining work for this unit and any newly discovered gap.
- Update the appropriate backlog when a requirement is deferred, including the reason and trigger.
- Stop. Do not start another milestone or page without instruction.

## 5. Design rules that cannot be negotiated silently

- Design principle: **sober where it spends, playful where it does not**. Transaction previews,
  sends, key exports, ceilings, account restrictions, bypasses, and modes are restrained ledgers,
  not celebratory surfaces.
- Use real labels and values. Addresses/hashes are monospace. Monetary figures use tabular numerals.
- Every fetched binding has Populated, Loading, Empty, and Error unless its domain genuinely lacks
  one. Account and Settings are not genuinely empty for an authenticated user; Gas is either data
  or an unavailable state.
- Use `<Skeleton/>` while `data === null`, `<Empty/>` only after a successful empty response, and a
  persistent `<Notice/>` plus Retry for errors. Money-path failures are never toast-only.
- Unknown/not-yet-calculated is `—` or explicit unavailable copy. A known numeric zero is `0`.
- Every form has visible labels, inline field errors, and an in-flight lock. Conditional fields
  update immediately. Never let a rerender steal input focus.
- Use shared `confirmDialog`/`promptDialog`; never browser-native dialogs. Consequential prompts
  name the exact record. Confirmation dialogs must appear above overlays; notifications must remain
  visible above ordinary overlays.
- Toasts are transient. The bell's Recent list is a capped session scratchpad, not a durable inbox.
  Pending confirmations are durable and shared across dashboard, Telegram, and Discord.
- Search is consistent, user-scoped by the server, and has a themed clear control. The Ctrl+K
  palette navigates only and never mutates; keyboard selection must remain visible.
- Touch targets are at least 44px on mobile except explicitly documented prototype exceptions.
- Use brief functional motion and respect reduced-motion preferences.
- Fixed mobile chrome respects safe-area insets. No horizontal page overflow.
- Status always has text plus tone/shape; color alone is insufficient.
- User-facing warnings and errors use plain language and no more than two short sentences: first
  say what happened, then say what the user can do. Do not show HTTP status numbers, RPC/provider
  jargon, raw exceptions, repeated safety disclaimers, or long diagnostic explanations on the
  customer surface. Keep technical detail in safe internal logs and tests instead.
- Activity and immutable audit evidence remain separate concepts.
- Post-confirmation sniper copying must always be labeled as such, never presented as mempool
  front-running.

## 6. Information and backend implementation rules

Before displaying or changing information, trace it end to end:

`UI control -> dashboard API or bot adapter -> shared command/domain service -> repository -> schema`

- A prototype value with no real source is removed, relabeled, or presented as unavailable. Never
  synthesize users, balances, P&L, gas, health, activity, usage, success, or transaction data.
- Every user-owned query and mutation is scoped by internal `user_id` in the repository—not merely
  filtered in React.
- Owner-only writes check the server-side owner flag. UI hiding is not authorization.
- Dashboard, Telegram, and Discord call shared services. Platform adapters format input/output;
  they do not reimplement validation, ceilings, scheduler, or transaction behavior.
- Every transaction path keeps simulation/policy enforcement, nonce serialization, persisted intent
  before broadcast, reconciliation, and durable status. Notification failure cannot change state.
- Every scheduled action uses the durable scheduler and idempotency path. Do not add long-range
  `setTimeout` scheduling; short precise wake-up timers may only feed the durable claim path.
- Private keys and recovery phrases never appear in ordinary API responses, errors, logs, or audit
  rows. One-time recovery display is explicit, short-lived, and not retrievable later.
- Validate at boundaries with the existing validation layer. Never silently default an unsupported
  chain or malformed value.
- Database changes use migrations and the unpooled connection. Application queries use the pooled
  connection.
- WebSocket updates are a live layer over durable server state, never the source of truth.
- If a visual request exposes a missing endpoint or schema, report it and create a separately scoped
  feature milestone instead of smuggling backend work into CSS.

## 7. Git and commit discipline

- Do not commit or push unless requested in the current turn. A previous approval does not carry
  forward.
- When asked to commit/push: fetch `origin/main` first, compare ahead/behind, integrate remote main
  without destructive resets, stage only in-scope files, commit with a focused message, push, fetch
  again, and confirm local `HEAD` equals `origin/main` with `0/0` ahead/behind.
- Never include unrelated work in a convenience commit. Report any files intentionally left out.
- Never use `git reset --hard`, destructive checkout, or force push unless explicitly authorized.
- Do not start a later milestone after committing an earlier one.

## 8. Commands on this Windows machine

Never invoke `npm.cmd` or the system-wide npm installation.

Install exact dependencies:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\project-npm.ps1 ci
```

Run the complete validation gate:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\project-npm.ps1 run validate
```

Focused Node commands may use the bundled runtime directly:

```powershell
& 'C:\Users\General\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' tests\example.test.js
& 'C:\Users\General\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules\vite\bin\vite.js build --config dashboard\vite.config.js
```

If spawning is restricted by the tool sandbox, retry with the tool's legitimate permission path;
do not bake an environment workaround into application tests. Stop after one or two genuine
tooling attempts and report the exact error.

## 9. Current remaining-work register

This register is a routing summary, not permission to implement everything at once. Re-audit each
item before starting because the application is active and the older backlog contains stale notes.

### A. Required dashboard redesign completion

1. **History:** finish prototype fidelity for Activity, Audit evidence, and owner Security log;
   preserve operational-vs-audit separation. Audit evidence currently has no dashboard route.
   Decide the truthful destination for archived schedule history before building that archive UI.
2. **Account:** rebuild against the prototype's Identity, Security, Linked platforms, and Sessions
   structure. The backend has `POST /api/auth/logout-all`, but the current page does not expose it.
   Investigate and resolve the conflict between the current page's link-code generator and the
   later product rule that only Telegram generates codes; do not choose silently.
3. **Settings:** finish the prototype's Appearance, Transaction mode, Gas, Notifications, and
   owner-only API usage organization. Preserve real mode governance and the compact appearance
   hierarchy.
4. **Admin:** complete a page-by-page fidelity and behavior pass for Overview, Groups, Users,
   Effective lookup, Presets, Owners, Wallet import, Audit, and Health. Its separate routes,
   overview, sidebar, and mobile navigation already exist; audit rather than rebuilding them.
5. **Global state/responsive sweep:** verify every user/admin page at the four widths, Dark and
   Light, keyboard/focus behavior, and every real response state. Reconcile stale status claims in
   the redesign documents with observed current behavior.

### B. Deferred post-UI behavior already approved for later

1. Archive cancelled/expired schedules after the chosen retention period (proposed 30 days),
   preserve attempts, and place them in a deliberately designed History destination.
2. Add status-correct schedule actions: expired -> Archive; cancelled -> Retry + Archive, with a
   valid future time required when necessary.
3. Add Select all on this page / Unselect all / indeterminate behavior to existing genuine
   multi-select surfaces such as Schedule and batch-wallet selection. Do not invent bulk deletes.
4. Replace unresolved preview zeroes with unknown states and add decoded receipt-style preview
   parity to Schedule and Batch. Batch scheduling remains undecided and out of scope.
5. Add durable sniper lifecycle actions: failed -> Edit/Retry/Archive; paused ->
   Edit/Resume/Archive. Simulate a failed state safely during acceptance; do not fake normal data.
6. Decide and design alternative wallet display modes; current card view remains the only approved
   implementation until the owner chooses.

### C. Product/backend work still open or conditional

1. Finish guided Telegram/Discord flows still represented by placeholders: Mint, Tasks, Snipers,
   Watch Rules, Activity, and Gas. Re-audit existing parity first; old worklist entries can be stale.
2. Investigate Discord `/info` only if the no-response report recurs, using the exact contract and
   timestamp plus production logs.
3. Consider scheduler pre-arming only after real `Transaction timing` logs show preparation is a
   material bottleneck; do not build it speculatively.
4. Optional performance/research work: dynamic fee strategies, RPC health scoring, latency
   dashboards, token-ID extraction, canonical bytecode verification, capture-then-revalidate,
   pure fee-policy functions, and explicit decrypted-key log-leak tests. A hot-key cache requires
   separate security approval.
5. Optional product work: additional social adapters, secondary-market `/buy`, transaction-watch
   notifications, contract-open auto-detection, OpenSea sale detection for P&L, and merging duplicate
   accounts that already contain real data.

### D. Release and acceptance work

1. Complete the unchecked human walkthroughs in `docs/TEST_PLAN.md` across dashboard, Telegram,
   Discord, database/RPC outages, scheduler, triggers, governance, and account lifecycle.
2. Reconcile documentation: `docs/TEST_PLAN.md` records a passed Sepolia acceptance run, while the
   ROADMAP production checklist still calls it unconfirmed. Verify the durable
   `live_acceptance_runs` row and add the run evidence to release notes.
3. Exercise backup/restore, rollback, key rotation, monitoring/alerts, graceful shutdown, and
   incident procedures before production.
4. Run the complete validation gate and confirm CI is green before release.

## 10. Required completion report format

Every finished unit reports:

1. Outcome and user-visible behavior.
2. What was already correct versus what changed.
3. Every modified/added file and one-line reason.
4. Tests/build/browser checks with exact results.
5. Security, data-truth, and compatibility notes.
6. What remains for this unit.
7. Git state; commit and push status only when requested.

## 11. Shared agent memory — Model 1 persistent handoff

*This section is the shared-memory extension for Model 1 (primary implementer). It coexists
with the implementation contract above; if any instruction conflicts, the implementation
contract wins.*

**Startup:** Run and inspect git status, branch and recent commits; preserve all existing user
changes; read this file and all project documentation before working.

**Memory files (all committed, branch-pinned):**
- docs/agents/reviews/phase-xx.md — per-phase audit reviews
- docs/agent/PROJECT_STATE.md — pinned, verified project state
- docs/agent/WORKLIST.md — dependency-ordered worklist with stable IDs and statuses
- docs/agent/DECISIONS.md — architectural decisions and rationale
- docs/agent/HANDOFFS.md — dated handoffs after every session

**Memory rules:**
- Every agent must read these files and recent Git history before working.
- Store only verified, concise facts.
- Never store private keys, tokens, credentials, wallet data or authenticated RPC URLs.
- Separate confirmed defects from hypotheses.
- Every completed item requires test, log, simulation or benchmark evidence.
- Use stable task IDs such as SEC-001, TX-001, RPC-001 and UX-001.
- Worklist statuses are: TODO, READY, IN_PROGRESS, BLOCKED, FIXED, REVIEW_FAILED and VERIFIED.
- Append a dated handoff after every session containing the model, branch, scope, changed files,
  tests, results, unresolved risks and exact next action.

# Claude Code prompt — GhostMint dashboard redesign

**Version:** 2 (2026-08-17). Supersedes `CLAUDE_CODE_PROMPT_1.md`.
**Spec:** `docs/REDESIGN_BRIEF.md` · **Prototype:** `docs/ghostmint-redesign-v3.html`

Run this on your own machine, in the repo root, with the desktop app closed on
this folder so nothing competes for `.git`. Paste **Phase 0 first**, review, then
paste each later phase only when you're happy with the one before it.

Before you start:

- `docs/REDESIGN_BRIEF.md` and `docs/ghostmint-redesign-v3.html` are already in
  the repo. Claude Code can read both.
- Clean tree, on a branch, not `main`: `git switch -c redesign/dashboard`
- **Record the test baseline first.** See "Pre-work" below. This is not optional —
  the suite is already red and Phase 1 will otherwise look like it broke things.

**Ten phases, 0–9.** Phases 0–4 are structure, 5–7 are the screens that were
missing, 8 is the new interaction work (collapse, reorder, empty states), 9 is
the responsive pass. **Phases 8 and 9 are not optional polish** — mobile is the
weakest part of the current dashboard and the main reason for this work.

---

## Pre-work — record the baseline (do this once, before Phase 0)

```
Before any redesign work, run the full suite on a clean tree and record the result:

  node --test --test-concurrency=1

Report the exact pass/fail counts and the name of every failing test.

Expected as of 2026-08-17: the non-integration suite is GREEN — 360 pass, 0 fail.
Five stale tests were fixed on 2026-08-17 (brief §9.2-O1, now closed) and those
fixes are uncommitted in your working tree:

  tests/validation.test.js      walletExport field renamed password -> securityPassword
  tests/governance.test.js      upsertGroup now requires advancedModesAllowed
  tests/dashboardAdmin.test.js  5 group-set bodies needed advancedModes, AND the
                                fixture never wired broadcastToUsers, which
                                adminWrite actually calls

Commit those three files FIRST, on their own, before starting the redesign branch.
They are test-only, touch no src/**, and keeping them separate means the redesign
diff stays clean.

tests/smoke.test.js and the *.integration.test.js files need a reachable database
and will fail with EAI_AGAIN if you run them somewhere the DB is not routable.
That is environmental, not a code failure.

From here on a phase passes only if the suite is STILL green. There is no longer
a red baseline to excuse a new failure.
```

---

## Standing instructions (paste once, at the top of the session)

```
You are working on the GhostMint dashboard redesign.

Read these before doing anything, in this order:
  1. docs/REDESIGN_BRIEF.md            — the design specification
  2. docs/REDESIGN_DATA_CONTRACT.md    — where every number comes from. BINDING.
                                         Read it before building any screen.
  3. GHOSTMINT_UI_RULES.md             — binding interaction rules; these win over
                                         the brief, EXCEPT where brief §9.1 records
                                         a deliberate amendment (D3 and D4 do)
  4. docs/ghostmint-redesign-v3.html   — the visual target; open it in a browser
                                         and use its Desktop/Mobile and
                                         Populated/Loading/Empty/Error toggles
  5. dashboard/src/shared.jsx          — the component family you must build against

THE SINGLE MOST IMPORTANT RULE IN THIS SESSION:

  Twelve elements in the prototype have NO data source. They are listed in the
  data contract §5, each with a decision already made. If you find yourself about
  to add a route, a query param, or a field to make a tile work — STOP. That is a
  src/** change, it is out of scope, and the decision has already been taken to
  cut or relabel that element instead.

  Where the prototype and the data contract disagree, THE CONTRACT WINS. The
  prototype shows some figures aspirationally; the contract says which.

House rules for this whole session:

- Work ONE phase at a time. Never start the next phase unprompted, even after
  finishing one cleanly. Stop and report.
- This is a PRESENTATION-LAYER change. If a change requires touching src/**, a
  route, a request shape, or a validation schema, STOP and tell me why instead of
  doing it. (One exception is pre-authorised: brief §9.2-O2, the Dashboard.jsx
  wallet.balance binding, which is a dashboard-side fix.)
- Before rewriting anything, audit what's already there and report what already
  complies vs what actually needs changing. Do not redo work that's done.
- Give me a file-by-file change list with one line per file on why it changed.
- Report validation honestly: which commands you ran, pass/fail against the
  recorded baseline, and an explicit list of what you did NOT verify. "Built but
  not clicked through" is a useful sentence — use it when it's true.
- Flag security or design tradeoffs before shipping them. Do not silently pick
  the convenient option.
- On an environment or tooling blocker, retry once or twice, then stop and give me
  the exact error. Do not build workarounds.
- Do not commit until I say so.
- If we agree to defer something, WRITE IT DOWN in brief §9 or docs/WORKLIST.md
  with a trigger. Never leave it as a verbal "we'll do that later".

Every phase's verification includes the responsive matrix from the brief's
section 8: check 375px, 768px, 1024px and 1440px, in all five themes, in ALL FOUR
states — populated, loading, empty and error (brief §3.8). A phase is not done if
it only works on desktop, and it is not done if it only works with data.

Loading is not empty. If a page shows "No wallets yet" while a fetch is still in
flight, that is a bug, and it is the single most common way this gets built wrong.
Gate every empty state on `data !== null`.

COMMANDS — use node directly, not npm.

Node 24 runs package.json scripts natively, so none of the verification steps
need npm at all:

  node --run check            syntax across the project
  node --run lint             eslint
  node --run dashboard:build  real Vite build
  node --run validate         the full documented gate (build + checks + lint + test)
  node --test --test-concurrency=1        the suite
  node --test tests/<one>.test.js         a single file, while iterating

Only INSTALLING dependencies still needs npm, and only that one command goes
through the launcher:

  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\project-npm.ps1 ci

Do not invoke npm.cmd or the system npm installation for anything.
```

---

## Phase 0 — Audit and plan (no code changes)

```
Phase 0. Read-only audit. Change no files.

Produce:

1. A component inventory of dashboard/src: every component in App.jsx, Admin.jsx,
   Dashboard.jsx, shared.jsx and dashboardWidgets/*, with one line each on what it
   renders and which page uses it.

2. A styles.css audit: which rules are structural, which are cosmetic, and which
   hardcode a colour instead of using a token, with line numbers. Report the REAL
   count — brief §6.1 claims 9 hex + 2 RGBA and that number is unverified (§9.2-O4).

3. A compliance check of the CURRENT code against GHOSTMINT_UI_RULES.md. For each
   rule: COMPLIES / VIOLATES / N-A with evidence. Known already, confirm and find
   the rest:
     - --tap-min is `auto` in 5 of 6 declarations in themes.css
     - zero occurrences of prefers-reduced-motion in either CSS file
     - zero occurrences of env(safe-area-inset-*)
     - no themed in-input search clear control
     - shared.jsx's Form has no in-flight busy state (19 <Form> usages)

4. A MOBILE audit specifically. At 375px, for every page, report what breaks:
   grids that go 1-up when they should be 2-up, controls under 44px, horizontal
   overflow, anything hidden under the bottom bar, missing safe-area handling,
   and — specifically — every card that merely reflows its desktop layout instead
   of having a mobile one (brief §3.2's governing rule). Be exhaustive; this is
   the weakest area and I want the full list.

5. A NOTIFICATION audit. Trace every notify() call site in dashboard/src. For each
   one, say which category from brief §4.1 it should carry and whether it should
   be kept in the bell. Report the current NotificationBell structure and how far
   it already is from the two-tab spec.

6. An EMPTY-STATE audit. For every page, what renders today when the API returns
   an empty array or a null? Identify which pages currently show a blank pane, a
   bare "No results", or a broken layout. Map each against brief §3.7's three
   distinct empties (never started / unfunded / nothing here yet).

6b. A DATA-CONTRACT RECONCILIATION. The contract was written by reading
   src/dashboard/api.js, src/commands/botCommandService.js and the repositories.
   Re-verify its §2 endpoint inventory against the code as it stands today and
   report any drift — a field renamed, a route added, a shape changed. This is
   the document every later phase binds against, so it has to be right before
   Phase 1 starts. Report ONLY the differences, not the whole table again.

7. Confirm or deny two unverified claims in the brief:
     - do PRIMARY_THEMES / SECONDARY_THEMES actually exist in App.jsx? (§9.2-O3)
     - does Dashboard.jsx read wallet.balance while the API returns only
       balances[]? (§9.2-O2) — confirm the exact call sites

8. A risk list: which components have event handlers most tangled with markup,
   i.e. where restyling is most likely to break behaviour. App.jsx is 475 lines
   but ~93,000 characters — tell me which parts are worst.

Do not write code. Report only.
```

---

## Phase 1 — Token layer

```
Phase 1. Tokens only. Do not change any JSX.

1. In themes.css, add the ELEVEN new tokens from brief §3 to :root and all five
   theme blocks: --surface-3, --surface-4, --gain, --loss, --gain-text,
   --loss-text, --warn-text, --grid, --sheen, --lift, --accent-line.

   Pick per-theme values that hold contrast on that theme's OWN surface — do not
   copy the dark values into the light themes. --sheen is `none` in every light
   theme. The validated dark values are --gain:#1eaa85 --loss:#e0455c
   --warn:#c98500; the prototype's five theme blocks are a working reference for
   all five, use them.

2. Fix --tap-min: 44px in :root and every theme block except quiet-ledger (48px).
   There are 5 `auto` declarations to fix, not 4.

3. Apply the density targets from brief §3.4 — card padding, grid gap, row
   padding, heading sizes, wrapper padding — as token/base-rule changes where
   possible rather than per-component overrides.

4. In styles.css, replace the hardcoded colours with tokens, using YOUR Phase 0
   count rather than the brief's unverified one. The theme-swatch previews may
   legitimately stay literal since they preview specific themes — tell me which
   way you went and why. Do NOT touch themes.css's raw hex; that's the token layer.

5. If Phase 0 found that PRIMARY_THEMES / SECONDARY_THEMES do not exist, create
   them now as module constants in App.jsx (§9.2-O3).

Verify: lint, eslint, dashboard:build, then all five themes at all four widths.
This phase should look tighter but structurally identical.
```

---

## Phase 2 — Shared components

```
Phase 2. shared.jsx plus the styles those components need.

1. Restyle the existing family — Form, Field, Select, StatusPill, Skeleton, Empty,
   Pager, CopyButton, Notice, ConfirmHost, ToastHost. Props and behaviour stay
   byte-identical. Restyle only.

2. Add the in-flight form lock the UI rules require: Form gains an optional `busy`
   prop that disables its fieldset; default false so no existing caller changes.

3. Add the new presentational components from brief §5:
   StatTile, Ledger, SectionCard, Celebrate, SearchField, SubTabs, Sparkline,
   Meter.

   SearchField must include the themed in-input clear (×) — visible only when
   there's text, clears the query only, keeps focus in the input — AND the mobile
   sizing from brief §3.2.1: 40px visual height and full width below 700px, with
   the clear button keeping a 44px hit box via padding. That 40px is a DELIBERATE
   documented exception to the 44px rule (§9.1-D3), not an oversight. Do not
   "fix" it back to 44px.

4. Add the bounded-number input pattern from §5: a real <input type="number">
   with a descriptive placeholder PAIRED WITH quick-select buttons. Typing updates
   the buttons, clicking a button fills the input. This replaces the buttons-only
   quantity control. Same pattern for send amounts.

   MOBILE LAYOUT MATTERS HERE: below 700px the input goes full width on its own
   row and the quick buttons sit in a flex row beneath it, each flex:1. They must
   not share a row — that is the current defect. Desktop keeps side-by-side.

5. Add the four-state scaffolding every later phase depends on (brief §3.8):
   - Skeleton gains the variants the prototype uses: line, big-value, row, chart.
   - Notice gains an error variant that takes {title, detail, code, onRetry} and
     renders the status code visibly. Error copy must state what did NOT happen.
   - A Pager component bound to {page,pageSize,total,totalPages} — that exact
     shape comes back from /api/tasks and /api/activity.
   - A rate-limit state that reads the Retry-After header and disables its
     control for a real countdown.
   Every one of these has a rendered target in the prototype under its Loading
   and Error harness toggles. Match them.

Do NOT touch useLoad, useLiveSocket, api, csrf or downloadFile.

TRAP — read before editing shared.jsx: tests/chainGrouping.test.js reads
shared.jsx as raw TEXT with fs.readFileSync and regex-asserts that EVM_CHAINS is
declared in that file. It is the only test in the whole suite touching dashboard
source. Do not move, rename, or change the declaration form of EVM_CHAINS or
GroupedChainOptions.

Verify as Phase 1, plus: every form, dialog, toast and pill across every page;
Escape and scrim-click still cancel dialogs; the search field and the quantity
control both at 375px.
```

---

## Phase 3 — Home page

```
Phase 3. Dashboard.jsx and dashboardWidgets/* only.

Rebuild Home: a four-tile stat row, then a two-column split — reward/alert zone
and P&L chart left, next-drop countdown, alerts, queue and wallets right.

THE FOUR TILES ARE NOT WHAT BRIEF v1 DESCRIBED. Build them per the data contract
§3 and §5 — the prototype's v3 tiles are already corrected, match those:

  Portfolio · ETH    Sum balances[] WHERE symbol==='ETH' only. balances[] spans
                     all six supported chains including MATIC; one total mixes
                     currencies. Skip balance===null (RPC failure) rather than
                     counting it as zero, and say "N chains unavailable".
                     NO 7-day delta and NO sparkline — no historical balance data
                     exists anywhere. Do not fabricate a trend.
  Net P&L · 30d      Client-side filter of /api/pnl on `t`. EXPECT THIS TO BE
                     NEGATIVE: autoRecordPnl writes sale:0, so every auto-created
                     record is a loss. Ship it red with the explanatory note.
                     A green chart here would be fiction.
  Daily budget       CEILING ONLY, no meter, no "used" figure. Nothing exposes
                     rolling spend. Do not add a route for it.
  Success · last 20  Label it by scope. stats() exists but is NOT routed, so this
                     is derived from one page of /api/activity. An unqualified
                     "Success rate" would be a lie about the denominator.

Activity rows: the value column is actual_network_cost_wei, which is GAS ONLY,
not the mint price. Label it "gas". Derive the chain dot from the row's explorer
URL — the activity table has no chain column.

Apply the richness spec from brief §3.3: sparklines in the portfolio and P&L
tiles, meters on daily budget and success rate, a countdown ring for the next
scheduled mint, chain identity dots, icon chips on card headers. No card may show
a single number and nothing else.

The P&L chart is the one real data-viz surface. Build it per brief §4 and treat
all five conditions as mandatory — especially that direction-from-baseline and
the +/- sign are the primary channel, not colour. Inline SVG, no charting library.

Stat tiles must be 2-up at mobile widths, never 1-up. This is the single most
visible mobile defect today.

FIX THE WALLET BALANCE BINDING (brief §9.2-O2, pre-authorised). Dashboard.jsx:40
and all four theme widgets read wallet.balance / wallet.symbol. The API's
publicWallet() returns only balances: [{chain, balance, symbol}]. Consequence
today: every home wallet chip renders "—" on every theme, and lowBalanceWallets
is always empty so the low-balance alert never fires. Confirm the exact shape
against src/dashboard/api.js publicWallet() first, then fix the binding. Report
what you changed.

Otherwise keep summarize() as it is — it derives from real API shapes. If you
think another derived value is wrong, tell me, don't change it.

Note: THEME_WIDGETS has only FOUR keys — ghost-mint-light is missing and falls
through to ghost-mint's widgets via the || default at Dashboard.jsx:76. Decide
deliberately whether to give it its own set or keep the fallback, and tell me
which you chose.
```

---

## Phase 4 — The 11→5 consolidation and the command palette

```
Phase 4. The IA change from brief §2. This is the risky one.

Merge: Tasks into Mint, Snipers + Watch Rules + Target Policies into Automation,
P&L into Wallets, Activity + audit into History. Settings, Account and Admin go
to the rail footer on desktop.

Also in this phase, because it is what makes the merge safe:

1. SubTabs on every merged page, with the "was …" muted label for absorbed
   content: "Performance · was P&L", "Schedule · was Tasks", "Social rules · was
   Watch Rules", "Policies · was Target Policies".

2. Redirects for all five retired slugs, landing on the new page WITH THE RIGHT
   SUB-TAB PRE-SELECTED. /dashboard/pnl → /dashboard/wallets?tab=performance.
   Deep links with an id too.

3. The command palette (⌘K / Ctrl+K) per brief §2.2, indexing Pages, Moved,
   Actions and Wallets. The "Moved" group is the point — typing "P&L" must find
   Wallets → Performance.

   HARD CONSTRAINT: the palette NAVIGATES ONLY. No mutation, no form submit, no
   transaction, ever. It routes to a page with state pre-selected and the user
   acts there. If you find yourself wiring an action handler into it, stop.

4. EVERY SUB-TAB PANEL, not just the first one of each page. The prototype draws
   all of them; v2 drew only the landing tab. That is 11 panels:

     Mint        Schedule (task form + list + Pager), Batch (multi-wallet select
                 + per-wallet results list), Presets (saved list + method registry)
     Wallets     Performance (ACCOUNT-level, not per-wallet — pnl_records has no
                 wallet column), Send (explanatory panel, no route exists),
                 Export (keystore form, never the raw key)
     History     Audit evidence (unavailable panel — triggerAudit is not routed),
                 Security log (OWNER ONLY — hide the tab for regular accounts)
     Automation  Snipers and Social rules are client-side filters of the same
                 list; Policies is the editor plus the bypass challenge

   The Mint page's preview→confirm flow needs its token surfaced: /api/mints/
   preview issues one valid for 300 seconds, /api/mints/confirm consumes it once.
   Show the countdown and force a re-simulate on expiry. v2 omitted this entirely.

   The bypass challenge keeps its exact CONFIRM word entry and its 5-minute
   challenge expiry. Do not make it one click shorter.

Other hard requirements:
- No API call changes. Merged pages call exactly the routes the separate pages
  called, with the same params.
- Owner-gated tabs (History → Security log, Settings → API usage) are HIDDEN for
  non-owners, not rendered with a permission error. Both endpoints are owner-
  gated server-side and would 403 on load (data contract §6).
- Target policy editing moves inline onto the sniper/watch-rule card — same
  PolicyEditor, same routes, new place.
- The bypass challenge flow is untouched. Still requires the explicit CONFIRM
  step. Do not make it one click shorter.
- The post-confirmation disclosure stays visible on Automation, including when
  there are zero triggers.
- Remove the top-bar breadcrumb.

Do this as FIVE separate commits — one per merge, one for the palette — so any
one can be reverted alone. Stop and report after each before starting the next.
```

---

## Phase 5 — Admin

```
Phase 5. Admin.jsx and the admin shell. Per brief §4.2, which now specifies the
CONTENTS AND REGISTER OF ALL NINE SECTIONS — read that table before writing.

The prototype builds four of the nine: Overview, Groups, Users & ceilings and
Audit log. Those four cover every layout pattern the rest reuse. Build the
remaining five against the one they resemble:

  Effective lookup  -> Groups        (form + register-1 result Ledger)
  Mode presets      -> Groups        (card-per-record + register-1 edit form)
  Owner access      -> Users&ceilings (list + tier pills + guarded action form)
  Batch import      -> Groups        (single form + warning card + result list)
  System health     -> Overview's health panel, promoted to a full page

- Owner-mode banner permanently visible at the top of the admin shell: amber,
  naming that actions here affect other users, with the caller's tier as a pill.
- Overview gets a 4-tile stat row (users, groups, 24h volume, owners), the Users
  list with inline status pills, and a System health panel.
- Users list rows: tier pill, group, linked platforms, mint count. Keep the
  right-click context menu. Every destructive confirm names the exact account.
  Account status is text + colour, never colour alone.
- Group ceilings, per-user ceiling overrides, effective-lookup results, mode
  presets and owner grants all render in the Ledger component. They are money —
  register 1, no decoration.
- Batch import must never echo a submitted key back, not even truncated.
- Mobile uses the existing ADMIN_MOBILE_PRIMARY / ADMIN_MOBILE_MORE split. Nine
  sections do not fit in a bar. Verify this at 375px specifically.

KNOWN BROKEN DEPENDENCY (brief §9.2-O5): GET /api/admin/health is registered in
src/server.js AFTER app.use('/api', ...404), so it is unreachable and always
returns "API route not found". The System health panel therefore has no working
data source today. Build the panel against the shape the endpoint will return,
render its loading and error states honestly, and DO NOT fix the route — that is
a src/** change and out of scope. Flag it in your report; it is already logged in
docs/WORKLIST.md.

Behaviour unchanged throughout, including AdminDenied and every owner gate. If a
restyle would change who can see or do something, stop and tell me.
```

---

## Phase 6 — Account and Settings

```
Phase 6. The Account page (brief §4.3) and the Settings page (brief §4.4).
These are one phase because a control MOVES between them.

ACCOUNT — four sub-tabs: Identity, Security, Linked platforms, Sessions.

- Identity: display name, username, default chain. Register-3 form, using the
  Phase 2 Form family.
- REMOVE the transaction-mode select from Identity. It moves to Settings (below).
  Leave a one-line link to it in its place, not a duplicate control. Reason: a
  control that changes gas multiplier, simulation and human verification does not
  belong in a profile form (brief §9.1-D7).
- Linked platforms: one row per linked identity with platform icon, redacted
  platform ID, link date. Keep the standing note that only Telegram can GENERATE
  a link code — Discord and the dashboard consume only. That is a product rule
  (M15e), not a UI detail; do not soften the wording.
- Security renders in the Ledger (register 1): security password set/unset,
  username login, active sessions, session expiry (7-day absolute cap), last key
  export, account status.
- Sessions: current session detail, "Log out", "Log out everywhere".

SETTINGS — five sub-tabs: Appearance, Transaction mode, Gas, Notifications,
API usage.

- Appearance: the theme picker per brief §3.1 — Light and Dark as two large
  preview cards, then a quieter "More styles · optional" group with Clean Vault,
  Neon Arcade and Quiet Ledger. Plus the "Reset layout" control that clears
  stored section order (added in Phase 8; stub the button now if Phase 8 hasn't
  landed).
- Transaction mode: NEW, and the gap this phase exists to close. Four preset
  cards — Degen, Fast, Cautious, Normie — each showing gas multiplier, simulation
  behaviour, confirmation count and human verification. REGISTER 1: sober, with
  the resulting effect in a Ledger beneath the selection, and a confirm step
  before applying.
  * Degen and Fast render LOCKED for users without advancedModesAllowed, reason
    shown inline: "Requires group access or an owner grant." That flag already
    comes back on GET /api/profile — no API change needed. Verify it does before
    you rely on it.
  * Normie is the seeded default (mode_presets.is_default) and is marked so.
  * Display names come from the DB. Do not relabel client-side — migration 038
    already corrected them at the source.
- Gas / Notifications / API usage: the existing panels, restyled. Notifications
  is the read-only routing table from brief §4.1.

TOP BAR AND ACCOUNT MENU (brief §4.5), also this phase:
- REMOVE the light/dark toggle from the top bar entirely (§9.1-D6). Its space
  goes back to the search trigger, which was being crowded on mobile.
- Convert the avatar from a link into a menu: signed-in header with display name
  and truncated internal user ID, current transaction mode as a read-only chip
  linking to Settings, Account, Settings, an inline Light/Dark toggle, Log out.
  Opens on click; closes on Escape, scrim click or route change; focus returns to
  the avatar on close. On mobile it is the same anchored popover as the bell, not
  a bottom sheet.

The key export flow keeps every existing guard and rate limit. Restyle only.
```

---

## Phase 7 — Notifications

```
Phase 7. The two-system notification model from brief §4.1. Read that section
fully before writing anything — the two systems overlap and the distinction is
the whole point.

1. notify() gains an optional `category` option: 'money' | 'automation' |
   'security' | 'system' | 'interface'. An UNDECLARED category defaults to
   'interface' — fail closed, so a careless new call site can never pollute the
   bell.

2. Only money / automation / security entries are appended to the notification
   log. system and interface are toast-only.

3. Update every notify() call site in dashboard/src with its correct category,
   using your Phase 0 audit. Report the full mapping as a table.

4. The bell gets a two-tab header: "Needs you" (pending confirmations, carrying
   the count badge) and "Recent" (the categorised log). Each Recent entry renders
   with a category chip and a category-coloured dot — the chip's TEXT carries the
   category, never colour alone.

5. The bell's count badge reflects PENDING CONFIRMATIONS ONLY. Never the log. The
   log is not a to-do list.

MUST NOT CHANGE: the Recent list stays capped and non-persisted. No read/unread
state, no server persistence, no archive. That would make it the durable Inbox
GHOSTMINT_UI_RULES.md explicitly prohibits. Only Pending confirmations is durable
and actionable. If you think the log should persist, stop and argue for it — do
not just build it.

Verify: trigger a mint toast (kept, Money), a copy-to-clipboard toast (not kept),
and confirm the badge counts pending confirmations only. On mobile, confirm toasts
sit above the bottom bar, not under it.
```

---

## Phase 8 — Collapse, reorder, and empty states (NEW in v2)

```
Phase 8. Three related interaction features. Read brief §3.5, §3.6 and §3.7 in
full first. Do these as THREE separate commits so any one can be reverted alone.

--- 8a. CollapsibleCard (brief §3.5) ---

MOBILE ONLY. Desktop keeps everything expanded (§9.1-D1). Do not add a desktop
collapse "for consistency" — hiding content on desktop undoes the density work
Phase 3 just did.

Build CollapsibleCard as SectionCard with a button header. The header:
  - is a real <button> with aria-expanded and aria-controls
  - spans the full card width, >=44px tall
  - carries THREE things and no more: status pill, identity, one figure
    e.g. "[Failing] @zeneca_33 — 4 failed polls"
         "[Active] Copy 0x8f2a…1d90 — 0.140/0.200"
  - toggles when tapped ANYWHERE along that row, including the empty space
    between the pill and the trailing label. Anything interactive inside the
    header must stopPropagation, but prefer making it non-interactive.
  - shows a chevron whose rotation AND the height transition are both dropped
    under prefers-reduced-motion: reduce

Apply to, with these mobile defaults:
  Home        P&L collapsed, activity expanded, wallets + alerts collapsed
  Automation  every trigger card collapsed
  Wallets     first wallet expanded, rest collapsed
  History     filter/search block collapsed
  Admin       Users expanded, health + ceilings collapsed
  Account     Identity expanded, rest collapsed

NEVER collapsible: page h1 and sub-tab rows; stat tiles; the Mint page's contract
form and transaction preview. The mint confirm surface is register 1 and a
collapsed total is a hidden total.

State is session-only component state. Do NOT persist it.

--- 8b. ReorderableStack (brief §3.6) ---

Applies to Home, Automation and Wallets only (§9.1-D2).

Pinned, never movable:
  Home        greeting, stat tile row
  Automation  page header, sub-tabs, search, post-confirmation disclosure
  Wallets     page header, sub-tabs, search
Movable: every stacked card below those.

  - Drag handle is an EXPLICIT control, not the whole card. On mobile the card
    header is already a collapse toggle and must not also be a drag surface.
  - Keyboard equivalent is MANDATORY: the handle is focusable and arrow keys move
    a block up or down. Drag-only is inaccessible and will not be accepted.
  - Order persists in localStorage, keyed per page.
  - "Reset layout" in Settings → Appearance clears stored order for every page.
  - Reordering never changes what is fetched. Rendered blocks only.

NOTE ON THE RULE THIS CHANGES: brief v1 said no localStorage except the rail.
Brief v2 §9.1-D4 amends that — section order is a standing layout preference,
the same bucket GHOSTMINT_UI_RULES.md already puts the rail in, and that rule
explicitly says to decide per preference. Two localStorage keys total after this,
and no more: rail state and section order. No session state, no data, no tokens.

--- 8c. Empty states (brief §3.7) ---

This is the one the user cares most about: every screen today assumes a populated
account, and a new user sees none of it. The prototype has a Populated/Empty
toggle — use it as the target.

Implement the THREE distinct empties, which must not render the same:
  1. Never started   — no wallet exists. The page's job is to start the user.
  2. Unfunded        — a wallet exists with 0 balance. THE MOST COMMON REAL
                       STATE. Must show the address with a CopyButton.
  3. Nothing yet     — funded, but no snipers / activity / tasks. Explain what
                       this page would contain and offer the one action.

Build FirstRun (brief §5) as the shared onboarding card for Home, Mint and
Wallets. Per-page copy is in brief §3.7's table — follow it.

Rules:
  - Copy names the NEXT PERMITTED ACTION, never "No results".
  - An empty state on a page the user cannot act on yet says WHY and where to go.
  - Register 4 (playful) is permitted here and only here outside reward moments.
    It stays out of register-1 surfaces even when empty — an empty ledger is
    still a ledger.
  - Empty is NOT loading. Skeleton while data === null; Empty only once data has
    arrived and is genuinely empty. Never show an empty state during a fetch.
  - Zero is a value: 0, 0.000000 ETH, 0% all render as themselves, via ?? not
    truthiness.

Verify all three sub-phases at 375px and 1440px, in all five themes, and confirm
the reduced-motion behaviour of the collapse transition specifically.
```

---

## Phase 9 — Responsive and final pass

```
Phase 9. Mobile is the point of this phase, not polish. Per brief §3.2.

THE GOVERNING RULE, and the thing most likely to be missed: mobile is a DISTINCT
LAYOUT, not a reflow. A card that merely stacks its desktop children keeps
desktop's row heights, padding and type scale and ends up oversized. For every
card that appears on both, state what it DROPS, TIGHTENS or RESTRUCTURES on
mobile — don't just let it wrap. Your Phase 0 mobile audit listed the offenders;
work that list.

1. Stat tiles 2-up on mobile everywhere they appear — Home and Admin. Never 1-up.

2. Bottom bar: five slots — Home, Mint, Automation, Wallets, More. Icon over
   label, every slot >=44px, active state in accent, safe-area padding via
   env(safe-area-inset-bottom).

3. More sheet: 3-column grid of History, Account, Settings, Admin, Search.
   Visible grab handle WITH a working tap target. Escape and scrim tap close it.
   A resize event must never dismiss it — only an explicit close.

4. Every page gets a mobile pass, not just Home. Sub-tab rows scroll horizontally
   with hidden scrollbars rather than wrapping. .split and the g2/g3/g4 grids
   collapse to one column — except stat tiles, which stay 2-up.

5. Mobile density per brief §3.2: page padding 13-14px, card padding 12px,
   ledger rows 6px/12px, sparklines hidden in card contexts (kept in stat tiles),
   secondary meta lines folded into the expanded state. No horizontal page scroll
   anywhere, at any width.

6. Confirm the two mobile fixes from Phase 2 survived: the search field is 40px
   and full width (NOT 44px — that is deliberate, §9.1-D3), and the quantity
   input sits on its own row above its quick buttons.

7. Accessibility sweep: focus-visible everywhere, status never colour-alone,
   reduced-motion overrides on ALL ambient animation including the sheen, hover
   lift, toast slide, pulse dot, AND the Phase 8 collapse height + chevron
   rotation. Labels on every input.

Then give me a final report: every file changed across all ten phases, the full
verification matrix (commands, themes, viewports, populated AND empty), the test
result compared against the recorded pre-work baseline, and an explicit list of
anything still unverified.
```

---

## If something goes wrong

The likeliest failure is **Phase 4** breaking a route or a policy edit path. Five
separate commits is what makes that cheap: `git revert <sha>` for the one merge
that broke, keep the rest.

The second likeliest is a restyle silently killing a handler in `App.jsx`, because
that file interleaves markup and logic densely — 475 lines but ~93,000 characters.
Nothing in the test suite will catch it; there is zero component-level coverage.
The click-through per phase is not optional, it is the only net there is.

The third is **Phase 7** quietly turning the bell into an inbox. If you find
yourself adding persistence or read/unread state to the Recent log, that is the
failure mode, not a feature.

The fourth, new in v2, is **Phase 8b** growing beyond two `localStorage` keys.
Order and rail state, nothing else. If a third key appears, something has been
misfiled as a layout preference.

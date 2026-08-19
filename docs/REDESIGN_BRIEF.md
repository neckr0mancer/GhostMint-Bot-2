# GhostMint Dashboard — Redesign Brief

**Version:** 3 (2026-08-17). Supersedes `REDESIGN_BRIEF_1.md`.
**Prototype:** `docs/ghostmint-redesign-v3.html`
**Prompt:** `docs/REDESIGN_PROMPT.md`
**Data contract:** `docs/REDESIGN_DATA_CONTRACT.md` — **binding. Read it before
building any screen.** It maps every element to its endpoint and field, and lists
the twelve elements that have no data source. This brief says what things look
like; the contract says where the numbers come from. Where the prototype shows a
figure the contract marks MISSING, **the contract wins and the prototype is
aspirational.**

**Status:** design specification. Read alongside `GHOSTMINT_UI_RULES.md`, which stays
in force. Where this brief and the UI rules disagree, the UI rules win and this
document is wrong and must be corrected — except where §9 records a deliberate,
reasoned amendment to a UI rule, which then becomes binding on both.

**Scope:** `dashboard/src/**` only. This is a presentation-layer change. No API
route, request/response shape, validation schema, or server file changes.

**Working agreement:** nothing in this project is deferred by verbal agreement.
Anything postponed is written into §9 of this document (design decisions and open
items) or into `docs/WORKLIST.md` (feature backlog) with a trigger for when it
gets picked up. There are no reminders.

---

## 1. The design position

Four directions were chosen: institutional, crypto-native, consumer SaaS, and
"fun for Twitter/Telegram/Discord users". Applied uniformly they neutralise each
other. They are therefore applied **by zone**, under one rule:

> **Sober where it spends, playful where it doesn't.**

### The four registers

| # | Register | Where it applies | Characteristics |
|---|----------|------------------|-----------------|
| 1 | **Institutional** | Any surface where money can move or be lost: mint confirm, send, batch confirm, key export, ceiling editors, admin ban/suspend/deactivate, bypass challenge, transaction-mode selection | `tabular-nums`, hairline rules, monochrome, right-aligned figures, six-decimal ETH, no animation, no celebration, accent colour never decorative |
| 2 | **Crypto-native** | Chrome: rail, top bar, surfaces, brand, numerals | Dark-first, high contrast, tight tracking on large numbers, monospace for every address/hash/calldata |
| 3 | **Consumer SaaS** | Structure: forms, navigation, empty states, loading, search | Generous spacing, always-visible labels, `<Skeleton/>` not spinners, one obvious next action per screen |
| 4 | **Playful** | Reward moments only: post-mint success, streaks, empty-state personality | Fires *after* money has moved. Colour, warmth, a single emoji is permitted here and nowhere else |

**The test for any component:** can this screen cost the user money? Yes →
register 1. No, and it's a reward → register 4. Everything else → register 3
wearing register 2's skin.

Register 1 is the one that must not be compromised for visual appeal. If a
transaction preview looks exciting, it is wrong.

---

## 2. Information architecture: 11 pages → 5

Current `PAGES` in `App.jsx`:
`Dashboard, Wallets, Minting, Tasks, Snipers, Watch Rules, Target Policies,
Activity, P&L, Settings, Account`

Target:

| New page | Absorbs | Rationale |
|---|---|---|
| **Home** | Dashboard | unchanged in role |
| **Mint** | Minting + Tasks | "mint now" and "mint at 14:00" are one intent with a time field. This is also the split that let `executeTask` drift from `executeMint` until the SeaDrop bug surfaced |
| **Automation** | Snipers + Watch Rules + Target Policies | a sniper and a watch rule are the same shape (a source that listens, a mint it can fire); a policy has no independent existence and belongs inline on its target's card |
| **Wallets** | Wallets + P&L | P&L is per-wallet performance; on its own page it's a table the user must mentally join back to wallets |
| **History** | Activity + audit surfaces | Activity (mutable feed) and audit (append-only evidence) become sibling tabs, per the UI rules' History/Activity separation — additive, never a reskin of one as the other |

`Settings`, `Account` and `Admin` live in the rail footer on desktop and in the
More sheet on mobile. `Admin` keeps its own shell (`AdminShell`,
`ADMIN_SECTIONS`) unchanged in structure.

### 2.1 Merged content must stay findable — three mechanisms, all required

A merge that hides content is a regression. Every retired page gets found three
ways:

1. **Sub-tabs with a "was" label.** Each merged page carries a sub-tab row, and
   the tab for absorbed content is labelled with its old name in small muted
   text: `Performance · was P&L`, `Schedule · was Tasks`,
   `Social rules · was Watch Rules`, `Policies · was Target Policies`. Keep the
   "was" labels for at least one release, then drop them.
2. **URL redirects.** All five retired slugs redirect to the new page *with the
   right sub-tab pre-selected* — `/dashboard/pnl` → `/dashboard/wallets?tab=performance`.
3. **Command palette.** See §2.2.

### 2.2 Command palette (⌘K / Ctrl+K)

A single search-and-jump overlay in the top bar, opened by click or ⌘K, closed by
Escape or scrim click. It indexes:

- **Pages** — the five, plus Admin, Account, Settings
- **Moved** — the retired page names, each showing where it went
  (`P&L → Wallets → Performance`). This is what makes the merge safe: a user who
  types "P&L" out of habit lands in the right place and learns the new location
- **Actions** — navigation shortcuts to existing flows (Mint now, Create wallet,
  Ban a user, System health)
- **Wallets** — by label and address

**Hard constraint: the palette navigates only.** It must never mutate anything,
never submit a form, never trigger a transaction. It routes to a page with state
pre-selected; the user still performs the action there. This keeps it
presentational and keeps "no new way to submit a transaction" true.

### Non-negotiable on routing

`PAGE_SLUGS` / `SLUG_PAGES` must gain **redirects from all five retired slugs** to
their new home, including deep links (`/dashboard/target-policies/:id` →
`/dashboard/automation?target=:id`). A bookmark that worked yesterday works
tomorrow. Same for `ADMIN_SLUGS` if any admin section moves.

---

## 3. Token system

Keep the existing architecture exactly: `themes.css` defines tokens, component
CSS references them, `document.documentElement.dataset.theme` selects the block.
**No component may hardcode a colour.** All five themes stay
(`ghost-mint`, `ghost-mint-light`, `clean-vault`, `neon-arcade`, `quiet-ledger`)
and every one must be visually checked after the change.

### Tokens to add — the full list

This is the authoritative set. Brief v1 §3 listed six; the prototype and the
phase prompt both used eleven. Eleven is correct.

```css
--surface-3        /* third elevation — ledger header rows, chips, row icons */
--surface-4        /* fourth elevation — meter troughs, kbd, count badges */
--gain             /* data-mark green: profit bars, gain fills */
--loss             /* data-mark red: loss bars, loss fills */
--gain-text        /* lighter step, for gain text on surface */
--loss-text        /* lighter step, for loss text on surface */
--warn-text        /* lighter step, for warning text on surface */
--grid             /* chart gridline hairline */
--sheen            /* card top gradient; `none` in every light theme */
--lift             /* hover/elevated shadow */
--accent-line      /* accent at border opacity */
```

Data-mark colours are **not** the same values as `--success`/`--danger`. Status
colours are for pills and state; data colours are stepped for the chart surface.
Keeping them separate stops a status colour impersonating a series.

Validated values for the dark surface (`#0f1312`), via the dataviz validator:

```
--gain: #1eaa85   --loss: #e0455c   --warn: #c98500
```

These pass lightness band, chroma floor, normal-vision separation (ΔE 17.2) and
3:1 contrast. Do **not** copy them into the light themes — each theme block picks
values that hold contrast on its own surface. `--sheen` is `none` in every light
theme.

### Token to fix

`--tap-min` is currently `auto` in **five of six declarations** in `themes.css`
(`:root` plus four theme blocks); only `quiet-ledger` sets a real value, `48px`.
Brief v1 said "four of five" — that undercounted. `GHOSTMINT_UI_RULES.md`
requires `44px` as the shared default, widened per theme but never dropped. Set
`--tap-min: 44px` in `:root` and in every theme block except `quiet-ledger`,
which keeps `48px`. This is a pre-existing rules violation; fix it as part of
this work.

## 3.1 Theme hierarchy — Light and Dark are primary

`PRIMARY_THEMES` = Light (`ghost-mint-light`) / Dark (`ghost-mint`);
`SECONDARY_THEMES` = the other three. Do not flatten these into one dropdown.

**Changed in v2 — the theme toggle leaves the top bar.** Brief v1 put a
two-position sun/moon control in the top bar. It is removed. The top bar is the
scarcest horizontal space in the app and on mobile it was crowding the search
field. Theme now lives in exactly two places:

- **Settings → Appearance** — the full picker. Light and Dark as two large
  preview cards, then a separate, visually quieter group headed
  "More styles · optional" containing Clean Vault, Neon Arcade and Quiet Ledger
  as smaller cards.
- **The account menu** (§4.5) — a compact Light/Dark row, so the one-click path
  survives without costing top-bar width.

All five remain fully supported and must be checked after every phase. The
hierarchy is about prominence, not deprecation.

## 3.2 Mobile — a first-class layout, not a squeeze

Mobile is the weakest part of the current dashboard and the highest-value part of
this work.

**The governing rule, new in v2:** *mobile is a distinct layout, not a reflow of
the desktop one.* A card that merely stacks its desktop children keeps desktop's
row heights, padding and type scale and ends up oversized. Every card that
appears on both must declare what it drops, tightens or restructures on mobile —
not just how it wraps.

Concretely, at `data-m` / below 700px:

- **Stat tiles are 2-up, never 1-up.** `grid-template-columns: repeat(2,1fr)`.
  A four-tile row becomes 2×2. One tile per row wastes the whole screen on four
  numbers.
- **Ledgers (`.sober` / `Ledger`) compact.** Row padding 7px → 6px, font 12.5 →
  12px, label column drops from 46% to 52% and wraps rather than truncating.
  Ledgers never scroll horizontally.
- **Cards drop their reserved decorative space.** Sparklines hide below 700px in
  card contexts (they survive in stat tiles, where they occupy dead corner).
- **Secondary meta lines collapse.** A row that shows title + subtitle + value on
  desktop shows title + value on mobile, with the subtitle folded into the
  expanded state (§3.5) where one exists.
- **Bottom bar** (`BottomBar` already exists): five slots — Home, Mint,
  Automation, Wallets, More. Icon over label, ≥44px, active state in accent,
  safe-area padding via `env(safe-area-inset-bottom)`.
- **More sheet** (`MoreSheet` already exists): a 3-column grid of History,
  Account, Settings, Admin, Search. Visible grab handle with a working tap
  target. Escape and scrim tap close it. A resize event must never close it.
- **Sub-tab rows scroll horizontally** with hidden scrollbars rather than wrapping.
- **`.split` and all `g2` / `g3` / `g4` grids collapse to one column** — except
  the stat tiles, which stay 2-up.
- **Admin on mobile** uses the existing `ADMIN_MOBILE_PRIMARY` /
  `ADMIN_MOBILE_MORE` split. Nine sections do not fit in a bar.
- **Toasts on mobile** sit above the bottom bar, full width minus gutters, never
  underneath it.
- **Density:** page padding 13–14px, card padding 12px. Space is the scarce
  resource — no decorative whitespace.

### 3.2.1 The search field — a documented exception to the 44px rule

The mobile search field currently inherits `input,select{min-height:var(--tap-min)}`
plus its container's padding and renders far taller than it should, while being
capped at `max-width:320px` so it is simultaneously too tall and too short.

Fixed as follows:

- **Visual height 40px on mobile** (44px stays on desktop).
- **Full width** on mobile — `max-width` is removed below 700px; the field fills
  its row minus gutters.
- The in-input clear (×) keeps a **44px hit box** regardless of the field's
  visual height, achieved with padding rather than box size.

This is a deliberate, reasoned exception to the UI rules' blanket "every
interactive control is at least 44×44px on mobile", recorded in §9-D3. The
rationale: a text input is a region you tap *into* and then type, not a discrete
target you must hit precisely; 40px still comfortably exceeds WCAG 2.2 AA's 24px
target minimum, and the only precise target in the control — the clear button —
keeps its full 44px. If this is overruled, the fix is one line and the field goes
back to 44px.

## 3.3 Density and richness — the "too plain" fix

Plainness came from empty space and single-value cards, not from restraint. The
fix is more information per unit area, not more decoration:

- **Sparklines** in the portfolio and P&L tiles — 30-day trend, no axes, no
  labels, sitting in the tile's dead bottom-right corner
- **Meters** for anything with a ceiling: daily budget used, success rate,
  sniper daily-cap consumed. A 3px bar under the value
- **A countdown ring** for the next scheduled mint — a stroke-dasharray arc, the
  time, and the target
- **Chain identity dots** — a small coloured dot before each chain name
  (Ethereum, Base, etc.) so chains are scannable
- **Icon chips on card headers** — a 26px accent-tinted rounded square with the
  section's icon
- **An active-nav indicator bar** — 3px accent bar on the rail's active item
- **Hover lift** — `translateY(-1px)` on buttons and cards, 120ms
- **A subtle top sheen** on cards in dark themes (`linear-gradient(180deg,
  #ffffff08, transparent 60%)`), `none` in light themes

Restraint stays where it matters: one accent colour, no gradients outside the
sheen and the celebrate panel, no decorative illustration, no colour on
register-1 surfaces.

## 3.4 Space optimisation

Explicit targets, because "looks plain" and "wastes space" are the same problem:

- Card padding 15px desktop / 12px mobile (was ~18px)
- Grid gap 11px (was 14px)
- Row vertical padding 9px (was 11px)
- `h1` 23px desktop / 20px mobile (was 26px)
- Page wrapper padding 20px desktop / 13px mobile (was 26px/14px)
- Stat tile value 23px desktop / 19px mobile
- No card may contain a single number and nothing else — pair every value with a
  trend, a meter, a sparkline, or a secondary stat

## 3.5 Collapsible sections — new in v2

**The goal is stated as ease of access:** on a phone, a page should be surveyable
without scrolling. The user should see *what is on this page* first, and open
only the thing they came for.

### Scope decision

**Mobile only.** Desktop keeps every section expanded. Recorded as §9-D1.
Rationale: collapse is a density fix for a scarce viewport. Desktop has the room,
and hiding content behind a tap on desktop directly undoes §3.3, which exists
because the desktop layout read as too plain. One behaviour, one set of states to
verify.

### Where it applies

Every page whose body is a stack of independent cards or list items:

| Page | Collapsible units | Default state on mobile |
|---|---|---|
| Home | P&L chart, Recent activity, Wallets, alerts | P&L collapsed, activity expanded, rest collapsed |
| Automation | each trigger card | all collapsed |
| Wallets | each wallet card | first expanded, rest collapsed |
| History | filter/search block | collapsed |
| Admin | Users, System health, Group ceilings | Users expanded, rest collapsed |
| Account | each section card | Identity expanded, rest collapsed |

**Never collapsible:** the page `h1` and its sub-tab row; stat tiles; the Mint
page's contract form and its transaction preview. The mint confirm surface is
register 1 and must be fully visible at the moment of decision — a collapsed
total is a hidden total.

### The collapsed header must carry the answer

A collapsed card is only useful if its header says enough to decide whether to
open it. Every collapsible header shows, in one row:

1. **Status** — the `StatusPill`, text + colour, never colour alone
2. **Identity** — the name, address or label
3. **The one figure that matters** — balance, net, daily-cap used, record count

Automation collapsed, as the worked example the user described:
`[Failing] @zeneca_33 — 4 failed polls` / `[Active] Copy 0x8f2a…1d90 — 0.140/0.200`

### Interaction rules

- The header is a real `<button>` with `aria-expanded` and `aria-controls`,
  spanning the full card width, ≥44px tall.
- A chevron rotates to indicate state. Under `prefers-reduced-motion: reduce`
  the rotation and the height transition are both dropped — state changes
  instantly.
- Any interactive element inside the header (a chain chip that is a link, a pill
  that filters) must `stopPropagation`, or must not be interactive. Prefer
  not interactive — the user explicitly asked that tapping anywhere along the
  header row toggles, including the empty space between the status pill and the
  chain label.
- Expanded/collapsed state is **session-only**, per page, held in component
  state. It is not persisted. A page always opens in its declared default so the
  layout is predictable.
- Collapse must never be the only way to reach content: everything inside a
  collapsed card is still in the DOM and still reachable by keyboard tab order
  after expansion, and the command palette still routes to the page.

## 3.6 Reorderable sections — new in v2

### Scope decision

**Home, Automation and Wallets.** Recorded as §9-D2. These are the three pages
whose bodies are genuinely a stack of independent blocks. Mint is a linear form,
History is a single feed — reordering neither means anything.

### What moves and what is pinned

| Page | Pinned (never movable) | Movable |
|---|---|---|
| Home | greeting, stat tile row | celebrate/alert panel, P&L chart, recent activity, next-drop ring, wallets summary |
| Automation | page header, sub-tabs, search, post-confirmation disclosure | each trigger card |
| Wallets | page header, sub-tabs, search | each wallet card |

The stat tiles stay pinned because they are the page's fixed summary line — the
user named exactly this ("the greetings obviously will not be, and the portfolio,
net P&L, daily budget and such will not be").

### Persistence — and the rule it changes

Order persists in **`localStorage`**, keyed per page.

This amends brief v1 §6.2, which said no `localStorage` for anything except the
rail's expanded/collapsed preference. That was too strict, and the UI rules
already anticipate this case: *"A standing layout preference … persists in
`localStorage` and survives reload … Keep this split when adding new layout
preferences — decide per preference which bucket it belongs in rather than
persisting everything by default."* Section order is a standing layout
preference, squarely in the same bucket as the rail. Recorded as §9-D4.

The alternatives were both worse: session-only order resets on every reload and
is therefore pointless, and server-persisted order requires a new profile field,
which is an API change and out of scope.

Session state — which card is expanded, whether the More sheet is open — stays
non-persisted, exactly as before.

### Interaction rules

- Drag handle is an explicit control, not the whole card — on mobile the card
  header is already a collapse toggle and must not also be a drag surface.
- Keyboard equivalent is mandatory: the handle is focusable and responds to
  arrow keys to move a block up or down. Drag-only reordering is inaccessible.
- A "Reset layout" control lives in Settings → Appearance and clears the stored
  order for every page.
- Reordering never changes what is fetched. It reorders rendered blocks only.

## 3.7 Empty states — new in v2, and treated as a first-class screen

Every screen in the prototype currently shows a populated account. **A new user
sees none of it.** The empty state is the first impression and the most common
state during onboarding, so it is specified — and prototyped — as its own view,
not left to `<Empty text="No results"/>`.

The prototype carries a **Populated / Empty toggle** in its harness so both can
be inspected side by side at every width and in every theme.

### The three empties, distinguished

There are three genuinely different situations and they must not render the same:

1. **Never started** — no wallet exists. The page's job is to start the user.
2. **Started but unfunded** — a wallet exists with a 0 balance. This is the most
   common real state and the easiest to get wrong. The page's job is to get it
   funded, so it must show the address with a `CopyButton` prominently.
3. **Set up, nothing here yet** — funded wallet, but no snipers / no activity /
   no scheduled tasks. The page's job is to explain what this page would contain
   and offer the one action that creates the first one.

### Per-page specification

| Page | Never started | Unfunded | Nothing here yet |
|---|---|---|---|
| **Home** | A single first-run card, not four blank tiles: "Create your first wallet" with the three-step path (create → fund → mint) and one primary CTA. Stat tiles still render, showing `0` — never blank, never "Unavailable" (the `??`-not-truthiness rule). P&L chart replaced by an explanatory empty, not an empty axis | First-run card becomes "Fund your wallet", showing the address + `CopyButton` + the chains it works on | Tiles show real zeros; the P&L and activity cards each show their own `Empty` with a next action |
| **Mint** | "Create a wallet before minting", CTA to Wallets. The contract form is disabled, not hidden — the user should see what minting will look like | Form enabled, but the confirm button is disabled with the reason stated: "Primary has 0 ETH — fund it to mint" | The form *is* the page; no empty state needed |
| **Automation** | Two explanatory cards side by side — what a sniper is, what a watch rule is — each with its own CTA. The post-confirmation disclosure stays visible even with zero triggers | same as never-started | same as never-started |
| **Wallets** | The create form is promoted to the top of the page at full width, with the import form beneath it and clearly marked not recommended | The wallet card renders with `0.000000 ETH` and a "Fund" action exposing the address | Performance sub-tab shows "No mints yet — your first mint's cost and gas will appear here" |
| **History** | "Nothing yet. Your first mint will appear here." with a CTA to Mint | same | Audit and Security tabs each get their own copy — an empty audit log is evidence of nothing happening, not an error |
| **Admin** | Never truly empty — at least one owner always exists. Groups can be empty: "No groups yet. Every user falls back to the conservative default ceiling until you create one." | n/a | Audit log empty is normal and must read as normal |
| **Account** | Never empty — at least one linked platform always exists. The third-platform slot uses the existing empty | n/a | n/a |
| **Settings** | Never empty | n/a | n/a |

### Empty-state rules

- Copy names the **next permitted action**, never "No results" (already a UI
  rule; this extends it to every new surface).
- An empty state on a page the user cannot act on yet must say *why* and where to
  go — "Create a wallet first" with the link, not a dead end.
- Register 4 (playful) is permitted here, and this is the only non-reward place
  it is. A little warmth on a first-run screen is the point. It stays out of
  register-1 surfaces even when they are empty — an empty ledger is still a
  ledger.
- Empty ≠ loading. `<Skeleton/>` renders while `data === null`; `Empty` renders
  only once data has arrived and is genuinely empty. Never show an empty state
  during a fetch.
- Zero is a value: `0`, `0.000000 ETH`, `0%` all render as themselves.

## 3.8 Response states — four per binding, not one — new in v3

Every fetched surface has four states. The prototype (v3) renders all four behind
its harness toggle: **Populated / Loading / Empty / Error**.

| State | Condition | Render |
|---|---|---|
| **Loading** | `data === null && !error` | `<Skeleton/>` — card variant for cards, `variant="lines"` for lists. Never a spinner. **Never an empty state** |
| **Empty** | data arrived and the collection is genuinely empty | `<Empty/>` per §3.7 |
| **Error** | `error` is set | `<Notice/>` naming what failed, what was *not* changed, the status code, and a Retry |
| **Populated** | data present | as drawn |

Rules that are easy to get wrong and matter:

- **Empty is not loading.** Showing "No wallets yet. Create one." during a fetch
  tells a user with three wallets that they have none. Gate on `data === null`.
- **An error on a money surface is a `Notice`, never a toast alone.** A toast
  auto-dismisses; a failed mint must stay on screen. Toasts are for outcomes the
  user already expects.
- **Error copy states what did *not* happen.** "Could not load wallets. Your
  wallets and their keys are unaffected — this is a read failure only." A bare
  "Request failed" makes a read failure look like data loss.
- **`429` uses the `Retry-After` header** for a real countdown, and disables the
  control until it elapses.
- **`403` with `code:'ACCOUNT_BLOCKED'`** is a full-page, non-dismissible block
  naming the status and reason — not a toast, not a banner.
- **A batch returns `202` with a per-entry `results[]`.** Partial failure is the
  normal case, not an exception. Render the per-wallet outcome list; never
  collapse it to one success toast.

### Three states replace the page, not a card

`403 ACCOUNT_BLOCKED`, `403 Owner access required` and `401 session expired` are
reached before any fetch, so none has a loading or empty variant. All three are
drawn in the prototype's **Auth states** page. `ACCOUNT_BLOCKED` is the one that
matters most and had no visual target at all before v3 — it comes back from
`requireSession` on *every* route, so it blocks the whole dashboard at once, and
its panel must state plainly that **wallets and keys are untouched**.

### Not every surface has all four states

- **Account** and **Settings → Transaction mode** are never genuinely empty for a
  signed-in user. They have loading and error, no empty. The prototype marks these
  `.od` ("data arrived") rather than `.of`.
- **Gas** has no empty state either — it resolves or returns `503 MISSING_API_KEY`.
  That 503 renders as an inline unavailable note, **not** a red error banner: it is
  the expected state without a key, and minting is unaffected because fees come
  from the RPC provider at transaction time.
- Deciding a surface has no empty state is a real decision. Write it down rather
  than leaving the state unbuilt and ambiguous.

The full error-shape table — every status, body and origin — is
`REDESIGN_DATA_CONTRACT.md` §7. Do not duplicate it here; it will drift.

---

## 4. The P&L chart — the one real data-viz surface

Single measure (net ETH per day), one axis, diverging by sign.

**Colour is the secondary channel, never the primary.** Green/red fails
colourblind separation on its own (ΔE 6.1 deutan — measured, not estimated). It
is retained because it is the domain convention, on these conditions, all of
which are mandatory:

1. Bars sit **above or below a zero baseline** — direction carries the sign
2. Labels and tooltips carry an explicit **`+` / `−`** character
3. A 2px surface gap between adjacent bars
4. 4px rounded data-ends, anchored to the baseline
5. A `<title>` per bar for the native tooltip, and an `aria-label` on the `<svg>`
   summarising the series

No dual axis, ever. If a second measure is wanted (gas spent alongside net), it
is a second chart or a small multiple — never a second y-scale.

## 4.1 Notifications — two systems, one routing rule

There are two notification systems. They overlap, which is exactly why the rule
has to be written down: without it every new feature guesses, and the bell slowly
turns into an inbox the UI rules forbid.

### System 1 — Toasts

Transient, on-screen, auto-dismissing, session-only. They answer **"did the thing
I just did work?"** Types: `success`, `error`, `warning`, `info`. Mechanism is
`notify()` / `ToastHost` and it does not change.

### System 2 — The bell

Two sections with **different lifetimes**, and this distinction is the whole
point:

| | Pending confirmations | Recent |
|---|---|---|
| Source | server (`/api/confirmations`) | kept toasts |
| Lifetime | until resolved | last 20, session only |
| Actionable | **yes** — approve / reject | no, read-only |
| Survives reload | **yes** | no |

The bell gets a two-tab header: **Needs you** (pending confirmations, with the
count badge) and **Recent** (the categorised log). The count badge on the bell
icon reflects *pending confirmations only* — never the log, which is not a
to-do list.

### The routing rule

> A toast is **kept in the bell** if it has a durable consequence — money moved,
> automation fired, or security state changed. Pure interface feedback is
> toast-only and never reaches the bell.

`notify()` gains an optional `category` option. **An undeclared category defaults
to `interface`, i.e. not kept** — fail closed, so a careless new call site can
never pollute the bell.

| Category | Kept? | Examples |
|---|---|---|
| `money` | always | mint confirmed/reverted, send, budget hit, ceiling refusal |
| `automation` | yes | sniper fired or skipped, watch rule failing, task retried |
| `security` | always | login, key export, password change, owner action, ban |
| `system` | no | connection lost/restored, sync status |
| `interface` | no (default) | copied, saved, validation feedback |

Each kept entry renders with a category chip and a category-coloured dot. Colour
never carries the category alone — the chip's text does.

**What must not change:** the bell's Recent list stays capped and non-persisted.
It must not gain read/unread state, server persistence, or an archive. That would
make it the durable Inbox `GHOSTMINT_UI_RULES.md` explicitly prohibits. Only
Pending confirmations is durable and actionable.

## 4.2 Admin

Nine sections, unchanged in identity, from the existing `ADMIN_SECTIONS`.
Every section's content is specified below so none of them arrive as a guess.

- **Owner-mode banner** stays permanently visible at the top of the admin shell —
  amber, naming that actions here affect other users, with the caller's tier
  (Owner / Root owner) shown as a pill
- Mobile uses `ADMIN_MOBILE_PRIMARY` / `ADMIN_MOBILE_MORE`

| # | Section | Contents | Register | Notes |
|---|---|---|---|---|
| 1 | **Overview** | 4-tile stat row (users, groups, 24h volume, owners); Users list with inline status pills; System health panel; Group ceilings ledger | 3, with 1 for ceilings | The landing view |
| 2 | **Groups** | One card per seat group: name, the three ceilings in a `Ledger`, simulation forced/optional, advanced-modes allowed, retention policy. Create/edit form below | **1** — ceilings are money | Group names reject spaces with a clear message (existing server rule; surface it inline, not as a generic 400) |
| 3 | **Users & ceilings** | Searchable user table: tier pill, group, linked platforms, mint count, account status. Row expands to per-user ceiling overrides + simulation + advanced-modes grant | **1** for the override editor, 3 for the table | Every destructive confirm names the exact account. Status is text + colour |
| 4 | **Effective lookup** | A form (platform, platform user ID, chain) and a result `Ledger` showing the resolved effective policy and *which layer each value came from* — user override / group / default | **1** | The "why is this user's ceiling 0.1" answer. Owner exemption renders as "Exempt", not a number |
| 5 | **Mode presets** | Four preset cards — Degen, Fast, Cautious, Normie — each with simulation mode, confirmation count, human verification, gas multiplier, and an `is_default` marker. Edit in a register-1 form | **1** | Display names come from the DB (`display_name`), already corrected by migration 038. Do not relabel client-side |
| 6 | **Owner access** | Current owners and root owners as a list with tier pills; grant/revoke form. States the invariants in plain text: last owner cannot be removed, max 2 root owners, root required to grant owner | **1** | The single most dangerous screen. No colour decoration at all |
| 7 | **Batch import** | Owner-only key import. A textarea, a chain select, an explicit warning card, and a per-key result list after submit (success/failure per key, never all-or-nothing) | **1** | Warning copy must state keys transit browser memory. Never echo a key back, not even truncated |
| 8 | **Sensitive · Audit log** | Filterable `bot_security_audit` feed: platform, command, outcome, reason, timestamp. Dense rows, monospace identifiers | 3 | Append-only evidence. Read-only — no action controls anywhere on this screen |
| 9 | **System health** | One labelled row per dependency — database, Telegram, Discord, OpenSea, scheduler, social watcher — each with a status pill and a latency/detail figure | 3 | See §9-O5: the endpoint this reads is currently unreachable |

**Prototype coverage:** Overview, Groups, Users & ceilings and Audit log are
built out in `ghostmint-redesign-v3.html`. Those four cover every distinct layout
pattern the remaining five reuse — stat row, money ledger, searchable table with
row actions, and dense evidence list. The other five are specified above and
build against whichever of the four they most resemble; that mapping is given in
the prompt's Phase 5.

## 4.3 Account

Four sub-tabs: **Identity**, **Security**, **Linked platforms**, **Sessions**.

- **Identity** — display name, username, default chain. Ordinary register-3 form.
  **Transaction mode has moved out of this tab** to Settings (§4.4). It was here
  in v1 and in the v2 prototype's first pass; having a money-affecting control
  sitting in a profile form was wrong, and it was also the only place to set it,
  which is what surfaced the gap. Identity links to it rather than duplicating it.
- **Linked platforms** — one row per linked identity with its platform icon,
  redacted platform ID and link date. Keep the standing note that **only Telegram
  can generate a link code**; Discord and the dashboard consume only
- **Security** renders in the register-1 `Ledger`: security password set/unset,
  username login, active session count, session expiry (7-day absolute cap), last
  key export, account status
- **Sessions** — current session detail, "Log out" and "Log out everywhere"
- Empty states name the next permitted action, e.g. "No third platform linked —
  generate a code from Telegram to link another account"

## 4.4 Settings — new section in v2

Five sub-tabs: **Appearance**, **Transaction mode**, **Gas**, **Notifications**,
**API usage**.

- **Appearance** — the theme picker per §3.1, plus the "Reset layout" control
  that clears stored section order (§3.6)
- **Transaction mode** — **new, and the gap this section exists to close.** The
  four presets (Degen, Fast, Cautious, Normie) as selectable cards, each showing
  its gas multiplier, simulation behaviour, confirmation count and human
  verification. This is **register 1**: the choice changes what a transaction
  costs and whether it is simulated, so it renders sober, with the effect stated
  in a `Ledger` beneath the selection, and it confirms before applying.
  - Degen and Fast render **locked** for users without `advancedModesAllowed`,
    with the reason shown inline: "Requires group access or an owner grant."
    The flag already comes back on `/api/profile` — no API change needed.
  - Normie is the seeded default and is marked as such.
- **Gas** — the existing per-chain gas panel
- **Notifications** — the routing table from §4.1, read-only, explaining which
  categories are kept in the bell
- **API usage** — the existing social API usage report

## 4.5 Top bar and the account menu — new in v2

The top bar carries, left to right: the ⌘K search trigger, a spacer, the live
chip (desktop only), the notification bell, and the account avatar. **The
light/dark toggle is gone** (§3.1) — that space goes back to search, which on
mobile was being crowded.

The avatar was redundant with the rail's Account item and the More sheet's
Account tile: three routes to one page. It becomes a **menu**, not a link:

| Item | Behaviour |
|---|---|
| Signed-in header | Display name and truncated internal user ID — the only place the internal ID is surfaced in normal use |
| Current transaction mode | A read-only chip showing the active preset; tapping routes to Settings → Transaction mode |
| Account | Routes to the Account page (what the avatar used to do) |
| Settings | Routes to Settings |
| Appearance: Light / Dark | Inline two-position toggle — the one-click theme path that used to sit in the top bar |
| Log out | Ends the session |

That is enough content to justify the menu. If it ever shrinks back to a single
Account link, the correct move is to delete the avatar entirely rather than keep
a redundant third route.

Rules: opens on click, closes on Escape, scrim click, or route change. Focus
returns to the avatar on close. On mobile it renders as the same anchored popover
as the bell, not a bottom sheet — it is short.

---

## 5. Component specification

Build against the **existing** `shared.jsx` family. Do not introduce a parallel
component set.

| Component | Change |
|---|---|
| `Form` / `Field` / `Select` | Keep the API identical. Restyle only. Add the in-flight lock the UI rules require: `disabled={busy}` on submit at minimum, prefer disabling the whole `<fieldset>` |
| `StatusPill` / `statusClass` | Keep the status→class mapping exactly. Restyle to the new pill spec (text + icon + colour, never colour alone) |
| `Skeleton` | Keep both variants. Restyle to the new surfaces |
| `Empty` | Copy must name the next permitted action, not "No results". See §3.7 |
| `Pager` | Restyle; keep behaviour |
| `CopyButton` | Keep; ensure 44px tap target. Now load-bearing on the unfunded empty state |
| `GroupedChainOptions` / `EVM_CHAINS` | **Do not touch, and do not move.** See the trap in §6.1 |
| `ConfirmHost` / `ToastHost` / `confirmDialog` / `promptDialog` / `notify` | **Do not touch the mechanism.** Restyle the rendered markup only. Escape and scrim-click must still resolve to Cancel |
| `useLoad` / `useLiveSocket` / `api` / `csrf` | **Do not touch at all.** These are data and auth, not presentation |

### New components (presentational only)

| Component | Purpose |
|---|---|
| `StatTile` | Label / value / delta / meta. Value uses `tabular-nums` |
| `Ledger` | The register-1 table: label left, figure right, `tabular-nums`, optional total row |
| `SectionCard` | Card with head slot, used everywhere a `.panel` is used today |
| `Celebrate` | Register-4 success panel. Renders only after a confirmed outcome |
| `SearchField` | Consolidates the existing `.page-search` pattern; themed in-input clear (×); 40px full-width on mobile per §3.2.1 |
| `SubTabs` | The in-page tab row for merged content. Supports the `was …` muted secondary label, scrolls horizontally on mobile |
| `Sparkline` | Inline trend SVG for stat tiles. No axes, no labels, no tooltip — decorative trend only. If a value needs to be read, it is not a sparkline |
| `Meter` | 3px progress bar for anything with a ceiling. Takes `value`, `max`, and an optional `warn` threshold |
| `CommandPalette` | ⌘K overlay. Navigation only — see §2.2 |
| `BottomBar` / `MoreSheet` | Already exist. Restyle and extend to the five-slot model in §3.2 |
| **`CollapsibleCard`** | **New in v2.** `SectionCard` with a button header carrying status + identity + one figure, `aria-expanded`, chevron, mobile-only collapse. §3.5 |
| **`ReorderableStack`** | **New in v2.** Wraps a list of blocks, renders drag handles, persists order to `localStorage` by page key, exposes keyboard arrow-key reordering. §3.6 |
| **`AccountMenu`** | **New in v2.** The avatar popover. §4.5 |
| **`ModePicker`** | **New in v2.** The four transaction-mode cards with lock state and effect ledger. Register 1. §4.4 |
| **`FirstRun`** | **New in v2.** The never-started / unfunded onboarding card used by Home, Mint and Wallets. §3.7 |

### Inputs — quantity and other bounded numbers

Quick-select buttons are a shortcut, never the only way in. Every bounded numeric
field pairs a real `<input type="number">` carrying a descriptive placeholder
(`Enter quantity (1–3)`) with the quick buttons beside it. Typing updates the
buttons; clicking a button fills the input. The same pattern applies to the send
flow's Max/75%/50%/25% and to any future amount field — the buttons assist the
input, they do not replace it.

**Mobile layout, fixed in v2:** the input and its quick buttons must **not** share
a row below 700px. The current side-by-side `.qty` row squeezes the input to
nothing and the buttons overflow. On mobile: input full width on its own row,
quick buttons in a `flex` row beneath it, each button `flex: 1` so they divide
the width evenly and every one clears 44px. Desktop keeps the side-by-side row.

---

## 6. What must not change

This is the list to check every diff against.

### 6.1 Verified traps in the current code

These were checked directly against the repo, not assumed.

- **`tests/chainGrouping.test.js` reads `dashboard/src/shared.jsx` as raw text**
  (`fs.readFileSync`) and regex-asserts that an `EVM_CHAINS` constant is
  *declared in that file*. It is the only test in the entire suite that touches
  dashboard source. If the redesign moves `EVM_CHAINS` to a constants module,
  renames it, or changes its declaration form, that test fails for a reason that
  looks nothing like the cause. Leave the declaration where and as it is.

- **Component test coverage is zero.** No test imports React, a test renderer,
  `jsdom`, or any `.jsx` file. `devDependencies` are only `@vitejs/plugin-react`,
  `eslint`, `vite`. The Vite build and the one string-match above are the entire
  automated net for a JSX refactor. Manual click-through is not a nicety here.

- **`THEME_WIDGETS` has four keys, not five.** `ghost-mint-light` is absent from
  `dashboardWidgets/index.js` and falls through to `ghost-mint`'s widgets via the
  `||` default in `Dashboard.jsx:76`. Decide deliberately: either give
  `ghost-mint-light` its own widget set, or keep the fallback — but do not assume
  five sets exist.

- **The App.jsx symbols are module-local, not exported.** `PAGES`, `PAGE_SLUGS`,
  `SLUG_PAGES`, `ADMIN_SECTIONS`, `AdminShell`, `PolicyEditor` et al. are
  `const`/`function` declarations inside `App.jsx`; the file's only export is
  `export default function App()`. Splitting that file is therefore safe from an
  import-breakage standpoint — nothing outside it depends on those names.

- **Hardcoded colours in `styles.css` are few and localised** — 9 strict hex
  values plus 2 RGBA shorthand, none inside a `var()` fallback. Lines 532–537 are
  the theme-swatch previews (arguably legitimately literal, since they preview
  specific themes); 713, 718, 722, 769 are mobile shadow/backdrop overlays. This
  is a small job, not a sweep. `themes.css` is full of raw hex by design — that
  is the token layer and it stays literal. *(Count unverified — see §9-O4.)*

- **`localStorage` is used in exactly one place today** — the rail
  expanded/collapsed preference, `App.jsx:18–19`. Theme is server-persisted via
  `PUT /api/profile/theme`. No `sessionStorage` anywhere. §3.6 adds one further
  use — section order — and nothing else.

### 6.2 General

- **No API surface changes.** No new route, no changed request body, no changed
  query param. Search params already supported server-side (`?search=`,
  `?page=`, `?pageSize=`) stay exactly as they are
- **No new way to submit a transaction.** Every mint still goes through the same
  `/api/mints/preview` → `/api/mints/confirm` pair
- **CSRF:** every mutating call keeps its `X-CSRF-Token` header via `api()`
- **Authorization boundary:** never fetch broader data and filter client-side for
  display. Server scope is the boundary
- **The post-confirmation disclosure** ("copying is post-confirmation, not
  mempool front-running") stays visible on every automation surface, **including
  when there are zero triggers**
- **A recorded zero renders as `0`**, via `??` not truthiness
- **Owner-only surfaces stay owner-only.** `AdminDenied` behaviour unchanged
- **The notification bell** keeps its split: a capped non-persisted toast log,
  plus the durable server-backed pending-confirmations list. Do not promote the
  log into an inbox
- **`localStorage` is limited to two standing layout preferences** — the rail's
  expanded/collapsed state and section order (§3.6). Nothing else. No session
  state, no data, no tokens
- **The top-bar breadcrumb is removed.** With five pages and a persistent rail
  plus an active-state indicator, a `GhostMint / Home` crumb states the obvious
  and costs a row of vertical space. The page's own `h1` is the location
- **The command palette navigates only** — no mutations, ever (§2.2)
- **The bell's Recent list stays capped and non-persisted** — no read/unread, no
  server persistence, no archive (§4.1)
- **The mint transaction preview stays inline and always visible** on the Mint
  page. It is not moved into a modal that appears at confirm time. Decided in v2
  and recorded as §9-D5

---

## 7. Explicitly out of scope

- **Shareable mint/P&L cards for Twitter.** This is the most natural "fun for CT"
  feature and it is deliberately excluded, because it is *new functionality* and
  this project is a redesign. Propose it separately
- Any change to Telegram or Discord presentation
- Any change to `src/**`
- Adding a sixth theme
- Changing the five-theme widget system in `dashboardWidgets/` beyond restyling
  (the `THEME_WIDGETS` per-theme home-page variation stays)
- **Swipe-to-reorder and swipe-to-dismiss gestures.** Section reordering is
  handle-plus-keyboard only (§3.6). Adding a third gesture on mobile alongside
  tap-to-collapse and scroll is a known conflict and is not attempted here

---

## 8. Verification bar

Automated tests do not cover dashboard rendering — `dashboard.test.js` and
friends test the API layer. The safety net is therefore manual and must be run
per phase:

1. `node --run lint` — clean, zero warnings
2. `npx eslint dashboard/src` — clean
3. `node --run dashboard:build` — real Vite build, must succeed
4. `node --run test` — compared against the **recorded pre-work baseline**, not
   against green. See §9-O1: the suite is already red on `main` for reasons
   unrelated to the dashboard. A phase passes if it introduces no *new* failure
5. **Manual click-through**, per phase, in **all five themes**:
   - every page renders in **all four states** — populated, loading, empty, error
     (§3.8). The prototype's harness toggle is the reference for each
   - every form submits and shows its in-flight lock
   - every destructive confirm names the exact record
   - every retired URL redirects, *with the correct sub-tab pre-selected*
6. **Responsive matrix — every page, every phase.** Check at four widths:
   **375px** (small phone), **768px** (tablet), **1024px**, **1440px**. At 375px
   specifically confirm: stat tiles are 2-up not 1-up; the bottom bar is present
   and its five slots are ≥44px; the More sheet opens, closes on scrim and
   Escape, and clears the home indicator; sub-tab rows scroll rather than wrap;
   no horizontal page scroll anywhere; toasts sit above the bottom bar; the
   search field is 40px and full width; the quantity input and its quick buttons
   are on separate rows
7. **Collapse/expand** — every collapsible card opens and closes by tapping
   anywhere on its header; the collapsed header shows status + identity + one
   figure; state is session-only and resets on reload; nothing on the Mint
   confirm surface is collapsible
8. **Reorder** — drag and keyboard both work on Home, Automation and Wallets;
   order survives reload; "Reset layout" clears it; pinned blocks cannot move
9. **Admin at 375px** — nine sections must use the mobile primary/more split, not
   a nine-item bar
10. Keyboard: tab order sane, `:focus-visible` visible, Escape closes dialogs, the
    command palette, the More sheet and the account menu
11. `prefers-reduced-motion: reduce` — every ambient animation stops, including
    the sheen, hover lift, toast slide, pulse dot, and the collapse height and
    chevron transitions
12. **Notification routing spot-check** — trigger a mint toast (kept, Money), a
    copy-to-clipboard toast (not kept), and confirm the bell badge counts pending
    confirmations only

---

## 9. Design decisions and open items

Nothing here is a reminder. Each row has a state and, where it is not yet done, a
trigger for when it gets picked up.

### 9.1 Decisions taken (closed)

| # | Decision | Rationale |
|---|---|---|
| **D1** | Collapse/expand is **mobile only** | Desktop has the room; hiding content behind a tap on desktop undoes §3.3, which exists because desktop read as too plain. One behaviour to verify (§3.5) |
| **D2** | Reordering applies to **Home, Automation, Wallets** only | The only three pages whose bodies are a stack of independent blocks. Mint is a linear form; History is one feed (§3.6) |
| **D3** | Mobile search field is **40px, not 44px**, full width | A text input is a region you tap into, not a discrete target. 40px clears WCAG 2.2 AA's 24px minimum; the clear (×) keeps its full 44px. Documented exception to a UI rule (§3.2.1) |
| **D4** | Section order persists in **`localStorage`** | It is a standing layout preference, the exact bucket the UI rules put the rail in. Session-only would be pointless; server-persisted needs an API change (§3.6) |
| **D5** | The mint **transaction preview stays inline**, not a confirm-time modal | Considered and rejected in v2. Register 1 requires the total be visible at the moment of decision; a modal that appears on confirm shows it after the intent is formed (§6.2) |
| **D6** | The **light/dark toggle leaves the top bar** for Settings + the account menu | Top bar is the scarcest horizontal space and was crowding mobile search. One-click access survives in the account menu (§3.1, §4.5) |
| **D7** | **Transaction mode belongs in Settings — and the shipped code already puts it there** | **Corrected 2026-08-17.** `App.jsx:359`'s `Settings` already renders `<TransactionModePanel/>`. The gap was in *prototype v2*, which wrongly placed it on Account; v3 corrects the prototype to match the code. **Nothing moves in `App.jsx`** — this is a restyle of an existing panel into a register-1 tab (§4.4), not a relocation. Account gets a link to it, never a duplicate control |
| **D8** | Prototype builds **four admin tabs**, specs the other five | Overview, Groups, Users & ceilings and Audit log cover every distinct layout pattern the rest reuse. The five specified in §4.2 each name which of the four they build against |
| **D9** | **The daily-budget meter is cut; only the ceiling is shown** | No route exposes rolling spend. Worse, `rollingSpendWei` currently under-counts by the full transaction value, so surfacing it would show a figure wrong in the user's favour (contract §5.1) |
| **D10** | **Portfolio totals per symbol; the 7-day delta and sparkline are cut** | `balances[]` spans all six supported chains including MATIC, so one total mixes currencies. No historical balance data exists anywhere, so the delta is not derivable (contract §5.3, §5.4) |
| **D11** | **The P&L chart ships showing losses, with a note** | `autoRecordPnl` writes `sale: 0`, so every auto-recorded net is negative. The chart is correct; the data is incomplete. A green chart would be fiction (contract §5.5) |
| **D12** | **Per-wallet Cost/Gas/Net is cut; Performance becomes account-level** | `pnl_records` has no wallet column. Only `minted` is per-wallet. This narrows §2's rationale for the P&L→Wallets merge but does not undo it (contract §5.9) |
| **D13** | **Wallets → Send renders as an explanatory panel, not a form** | No dashboard send route exists. Adding one is a `src/**` change and a value-moving path that deserves its own review, not a slot in a restyle (contract §5.10) |
| **D14** | **History → Security log and Settings → API usage are owner-only tabs** | Both endpoints are owner-gated server-side; showing them to a regular user produces a `403` on load. Hidden entirely for non-owners rather than rendering a permission error (contract §6.1, §6.2) |
| **D15** | **The redesign targets Light (`ghost-mint-light`) and Dark (`ghost-mint`) only. Clean Vault, Neon Arcade and Quiet Ledger are carried, not designed.** | **Decided 2026-08-17**, replacing this document's standing "every one must be visually checked" instruction (§3, §3.1) and the "all five themes" line in the §8 verification matrix. Two reasons. First, they are already the only two primary themes (§3.1) and the only two the user uses. Second, and decisive: the Phase 0 audit found that **the mobile layout only exists in these two themes today.** `.mobile-bottombar` and `.more-sheet` are `display:none` globally (`styles.css:672–673`) and re-enabled only under `html[data-theme="ghost-mint"]` / `ghost-mint-light`; `App.jsx:20`'s `RAIL_THEMES` holds the same two, and `BottomBar`/`MoreSheet` render only inside the `isRail` branch (`App.jsx:415`). The ~40 rules in the `styles.css:977` media block are each scoped to those two themes. Extending mobile to the other three is not a restyle — it is a new layout for three themes plus a change to the shell fork. **What this does and does not mean:** every new token from §3 is still *defined* in all five theme blocks in Phase 1, because a `var()` with no definition renders as an invalid value and would visibly break the secondary themes. What is dropped is *design intent and per-phase verification* for those three. The responsive matrix (§8.6) and the per-phase click-through (§8.5) run in Light and Dark only. Secondary themes must still build and must not throw; they are not required to look designed. Restoring them is logged as O10 |

### 9.2 Open items (carried forward from the v1 review — not yet actioned)

| # | Item | Trigger |
|---|---|---|
| **O1** | ~~The test suite is red on `main`~~ — **CLOSED 2026-08-17.** Was 5 deterministic failures from three causes: `walletExport`'s field rename `password`→`securityPassword` (migration 036), `upsertGroup`'s newly required `advancedModesAllowed` (migration 038), and `dashboardAdmin.test.js`'s fixture never wiring `broadcastToUsers`, which `adminWrite` actually calls. Test-only changes, no `src/**` touched. Non-integration suite now **360 pass / 0 fail** | Done. Phase 1 can compare against green |
| **O2** | **`Dashboard.jsx` wallet balances are a data-shape bug, not a style bug.** The home widgets read `wallet.balance` / `wallet.symbol`; `publicWallet()` only ever returns `balances: [{chain, balance, symbol}]`. Every wallet chip renders `—` today and the low-balance alert is permanently dead | Phase 3. The phase currently says "keep `summarize()` exactly as it is" — that instruction is amended to allow this one fix, because shipping the redesign over a known-dead binding is worse than the inconsistency |
| **O7** | ~~`GET /api/profile/limits` does not exist~~ — **BUILT 2026-08-18, ceiling half only.** The route now returns `{chain, isOwner, ceilingExempt, maxTransactionValueWei, dailySpendingBudgetWei, gasCeilingGwei, simulationForced}` from `governanceService.limitsForSelf`, resolving user override → group → chain defaults. Deliberately **not** owner-gated: `enforceSniperGovernance` already runs the same resolution against the calling user, so reading the limits already enforced against you is not privileged. **`spentTodayWei` is deliberately absent** and the daily-budget meter is still cut | Meter still blocked on `rollingSpendWei`'s under-count (`PROJECT_REVIEW` §1.1). Adding the used-figure before that fix would put a knowingly-wrong number on a money surface. Guarded by a test asserting `spentTodayWei` is never returned |
| **O8** | **No dashboard route for `triggerAudit`, `send`, or `transactionsPage`.** All three exist in `botCommandService` and are reachable from Telegram/Discord only | After the redesign. `send` needs its own review as a value-moving path |
| **O9** | **`pnl_records` has no wallet column**, so per-wallet performance cannot be computed. Also `activity` has no chain or mint-value column, so the activity feed shows gas only | Schema change, post-redesign. Bundles naturally with the OpenSea sales-detection work already in `docs/WORKLIST.md` |
| **O10** | **Clean Vault, Neon Arcade and Quiet Ledger have no mobile layout at all, and after this redesign will also have no redesigned desktop layout.** Below 700px those three fall to the legacy `.shell` + hamburger: no bottom bar, no More sheet, card grids never collapse to one column, `.task-table` keeps horizontal overflow, `h1` stays up to 3.2rem. Admin is worse — `AdminShell` renders the rail shell for *every* theme, but `.admin-mobile-bottombar` never overrides the global `display:none`, so an owner on a secondary theme has no admin nav below 700px | Deferred by D15. Picked up only if a secondary theme is promoted, or on a report of someone actually using one. The fix is to un-scope the `styles.css:977` media block and widen `RAIL_THEMES` — not difficult, but it is three themes' worth of layout verification, which is the cost D15 declines to pay now |
| **O3** | ~~`PRIMARY_THEMES` / `SECONDARY_THEMES` unverified~~ — **CLOSED 2026-08-17. The claim was true.** Both exist at `App.jsx:302–303`, built off `THEME_OPTIONS`, and `Settings` already renders them as a primary segmented control plus a `<details>` "More themes" group | Done. Phase 1 restyles them; it does not create them |
| **O4** | ~~Hardcoded-colour count unverified~~ — **CLOSED 2026-08-17. The count was wrong, the characterisation was right.** Actual is **11 hex + 4 `rgba()`**, not 9 + 2. Locations as described: line 281 (`#fff` inside a danger gradient), 532–537 (theme swatch previews, legitimately literal), 713 / 718 / 722 / 769 (mobile shadow and backdrop overlays) | Done. Phase 1 works the real list |
| **O5** | **`GET /api/admin/health` is unreachable.** It is registered in `server.js` after `app.use('/api', …404)`, so it always 404s. Admin § System health has no working data source | Phase 5. This is a `src/**` fix and therefore **out of scope for the redesign** — build the panel against the shape it will return, and raise the one-line route move separately. **Now genuinely logged** in `docs/WORKLIST.md` § Round 10 / Section AG, item 1 (renumbered from Section L on 2026-08-17 — `main` had already claimed that letter for "Custom X amount input") |
| **O6** | **Naming and count housekeeping.** Prompt referenced `REDESIGN_BRIEF.md` while the file was `REDESIGN_BRIEF_1.md`; header said "eight phases" for nine blocks | Closed in v2 — this file is `docs/REDESIGN_BRIEF.md` and the prompt states its phase count correctly |

### 9.3 Parked — raised, not yet specified

| # | Item | Trigger |
|---|---|---|
| **P1** | Further ideas for the dashboard, described as "complex, hard to put down right now" | Picked up when they can be articulated. No design work happens against them until then. They are expected to touch layout composition, so §3.6's `ReorderableStack` is built general enough not to need rewriting |

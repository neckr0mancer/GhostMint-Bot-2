# Redesign fidelity backlog

**Opened 2026-08-18**, from a review of the running app against the prototype. Every
item here was raised by the repo owner. Nothing in this file is optional and nothing
in it is my inference about what "looked close enough" — each item names the
prototype file and element it must match.

Governing rules live in [`REDESIGN_PROMPT.md`](REDESIGN_PROMPT.md) (RULE 1: nothing
that is not in the prototype; RULE 2: all four states, every time). This file is the
checklist those rules produce.

## 0. The standard, restated because it kept being missed

> "Follow exactly — every single thing: text, size, border size, even the transition
> from wide view to tablet view to phone view. Both in light and dark mode, and in
> all states: populated, empty, loading, and error. Exactly the same."

That means a unit is only done when **all of these** match the prototype:

| Axis | What must match |
|---|---|
| Text | Every string, verbatim — labels, headings, helper text, button copy, empty-state copy, error copy |
| Size | Padding, font-size, font-weight, line-height, gap, width, height |
| Border | Width, colour, radius — including the radius the prototype's own class collisions produce |
| Responsive | Wide → tablet → phone. The prototype's breaks are `.app[data-m]` and `@media(max-width:900px)` |
| Theme | Light **and** dark, both checked |
| State | Populated, loading, empty, error — the prototype's `.of` / `.ol` / `.oe` / `.ox` classes mark each one |

The prototype marks its four states inline. `.of` = populated, `.ol` = loading,
`.oe` = empty, `.ox` = error. **Every element carrying one of those classes is a
state the real app owes.** Grepping a prototype page for `oe` and `ox` is the
fastest way to enumerate what is missing.

## 1. Status

| # | Item | State |
|---|---|---|
| 1.1 | Shell chrome — rail + top bar | DONE, measured identical |
| 1.2 | Buttons → `.b` family, sub-tab glow, error `.notice` | DONE, measured identical |
| 1.3 | Account menu popover (`.acct-pop`) | TODO |
| 1.4 | Bell → two-tab `.bell-pop` | TODO |
| 1.5 | Mint page rebuild | **DONE — all four tabs** (Mint now, Schedule, Batch, Presets) |
| 1.6 | Home empty state / `FirstRun` | DONE — built from `.frun`, gated on `data !== null`, checked light+dark at 375 and 1440 |
| 1.7 | Four states on every remaining page | TODO |
| 1.8 | Responsive + light/dark parity sweep | TODO |
| 1.9 | Screens the prototype never designed | DEFERRED — see §6 |

## 2. Account menu — `.acct-pop` (prototype `ghostmint-redesign-v3.html`)

The avatar currently routes straight to the Account page. It must not. It opens a
popover containing, in this order:

1. `.acct-h` — display name, then `user 4f9c…21ab` in `.ai.mono`
2. `.acct-i` **Transaction mode**, with the current mode in a `.mchip` on the right
3. `.acct-i` **Account** → routes to Account
4. `.acct-i` **Settings** → routes to Settings
5. `.acct-tog` **Appearance** with a `.tmode` light/dark pair, current one `.on`
6. `.acct-i.danger` **Log out**

Only Light and Dark appear in the toggle — the three secondary themes are out of
scope and must not be offered here.

## 3. Bell — `.bell-pop` (prototype)

Not "Pending confirmations" + "Recent notifications". It is:

- `.bell-h` heading **Notifications**
- `.bell-tabs`: **Needs you** (with a `.cnt.hot` count) and **Recent**
- Needs-you body: `.bell-sec` "Pending confirmations · durable" with a count, then
  `.bell-i` rows each with a `.bell-d` status dot, `.bm` title, `.bs` subtitle and a
  `.br` action row (`Approve` / `Reject` as `.b.p.sm` / `.b.g.sm`); plus the
  **Bypass challenge** row with an `Open challenge` action
- Recent body: `.bell-i` rows with a `.bell-cat` category chip (Money / Auto / Security)
- `.bell-act` footer: "The badge counts pending confirmations only. Recent is a
  capped session scratchpad — never an inbox."

The badge counts **pending confirmations only**, not recent entries.

**Built 2026-08-19.** Structure, copy and geometry verified against the prototype: heading,
both tabs with the `.cnt.hot` count, `Pending confirmations · durable`, `Recent · session
scratchpad`, and the footer sentence verbatim. Computed values match — surface, 13px radius,
`.bell-tabs` on surface-2, `.bell-body` capped at 300px.

One geometry override lives in `styles.css`, not `prototype.css`: the prototype anchors
`.bell-pop` to the app shell, so `width:min(360px,calc(100% - 28px))` measures the shell. In the
app the panel sits inside `.notification-bell`, which must stay positioned for the auto-preview
that shares it — so 100% was the bell button and the panel rendered **6px wide**. Measured against
the viewport instead. Colours, radius and borders still come from the prototype.

**Two gaps, both data rather than design:**

- **Bypass challenge row — no source.** The prototype shows one under Needs you. The API has
  `POST /api/targets/:id/bypass` and `POST /api/targets/bypass/confirm` but **no list endpoint**,
  so there is nothing to enumerate outstanding challenges from. Not faked; the row is simply
  absent until a route exposes them.
- **`.bell-cat` chips are opt-in.** `notify()` now takes an optional `category`
  (money / auto / security) and the chip renders only when a call site declares one. Deliberately
  not inferred from the message text: a wrong domain is worse than none, and a keyword sniffer
  would be wrong silently. Most of the 41 call sites do not set it yet.

## 4. Mint page — full rebuild (`docs/prototype-pages/mint.html`)

The owner has authorised reforming the markup: *"If it needs to be reformed, then
turn it to reform. Let it just match, find a way to match."*

### 4.1 Things that must be REMOVED — they do not exist in the prototype

- **"Advanced: edit detected calldata directly"** disclosure. The prototype's
  Presets → Method registry states the opposite policy outright: *"Only audited
  signatures can be encoded. Arbitrary ABI fragments and raw calldata are rejected."*
  → **DECIDED: remove.** See §7.1.
- **"Validate and simulate"** button. The prototype has no such control.
  → **DECIDED: remove; auto-simulate debounced instead.** See §7.2.
- The **table under the Schedule form**. The prototype puts scheduled mints in the
  RIGHT column as `.r` rows, not in a table below the form.

### 4.2 Mint now — layout

`.split` — Contract card left, preview column right.

Left card `Contract`, `.ch` with `.chip-ico`, fields as `label.fl > span + input.in`:
- Contract address — `.in.ok.mono` populated / `.in.mono` disabled placeholder
  `0x… paste a contract address` when empty
- Detection result as `.nt.i`: "Detected **Azuki Elementals** · SeaDrop · open ·
  0.08 ETH · max 3/wallet"
- `.g.gm2.g2` row: Wallet `<select class="in">` grouped EVM / Solana (Solana option
  disabled, "Solana (not yet supported)"); empty state is a disabled select reading
  **No wallets yet**
- Quantity — `.qty` with `input.in.tab[type=number]` placeholder `Enter quantity (1–3)`
  plus `.qb` quick buttons `1 2 3 Max`, active one `.on`
- Price per mint · auto-detected — placeholder `e.g. 0.08 — leave blank to use
  detected price`; empty state disabled with `Detected once a contract is entered`
- Cross-link `.nt.i` to Batch with a `.b.sm` **Switch to batch**
- Validation error (`.ox`): field gets `.in.bad`, followed by `.fielderr` with glyph
  and the server's message, e.g. `quantity must be between 1 and 3`

Right column:
- `.tokbar` **Simulated quote expires in** `4:12` — the preview-token countdown
- `.tokbar.warn` error variant: **Quote expired — re-simulate before confirming**
  with a `.b.sm` **Re-simulate**
- `.sober` **Transaction preview** with `table.led`: Contract, Method, Chain,
  Quantity, Mint price, Est. gas (23 gwei), Simulation, and `tr.tot` **Total debit**.
  Empty state renders the SAME table with `—` and `0.000000 ETH`, Simulation `Not run`
- Loading: four `.sk` rows (`.sk.row` ×3 + `.sk.l.w60`)
- `.card.tight` **Your daily ceiling** with the figure right-aligned
- `.notice` for a TransactionSafetyError, e.g. **Wallet balance is below the
  estimated transaction cost.** / "Nothing was broadcast. Fund **Primary** or lower
  the quantity." / `400 · INSUFFICIENT_BALANCE`
- The CTA, one per state, all `.big.bl`:
  - populated `.b.p` — **Confirm and mint · 0.084140 ETH**
  - loading `.b` disabled — **Simulating…**
  - empty `.b` disabled — **Create a wallet to mint**
  - error `.b` disabled — **Cannot mint · see above**
- Footnote: populated "Broadcast is irreversible. Intent persisted before send.";
  empty "Preview stays visible at all times — a collapsed total is a hidden total."

### 4.3 The no-wallet banner

When no wallet exists, a `.nt.w` sits above the sub-tab content:
**"Create a wallet before minting."** / "The form below is shown disabled so you can
see what minting looks like." / `.b.sm` **Create a wallet**.

The form is **shown disabled, not hidden** — that is the point of it.

### 4.4 Schedule

Left: `Schedule a mint` card — Name, Contract address, an `.nt.i` explaining that
SeaDrop drops expose their own opening time and a plain `mint(uint256)` does not,
Wallet + Quantity in a `.g.gm2.g2`, Mint time (`· UTC, explicit offset or Z`), and a
`.b.p` **Schedule mint**.

Right: `Scheduled` card, `.p.nu` count chip "2 pending", `.r` rows with `.ri` icon,
`.rt` name, `.rs.fold` meta, `.rv` status pill. Error state is a `.notice`
**Could not load scheduled mints.** `500 · Request failed safely` + Retry.

### 4.5 Batch

Left: `Batch mint` — Contract address, **Wallets · up to 100 unique** as a checkbox
list (low-balance wallet in `--warn-text`), Quantity per wallet with `.qty`/`.qb`,
and `.b.p` **Simulate all 3** (count is live).

Right: `.nt.i` "Each wallet is simulated and submitted **independently**. One wallet
failing does not cancel the others." Then:
- populated: `Result` card, `.p.wn` **2 of 3 succeeded**, `.bres` rows each with a
  `.p.ok`/`.p.bad` pill, `.bl2` label and `.be` hash-or-reason, then the footnote
  "Two transactions were broadcast. The third never left the server."
- loading: three `.sk.row`
- empty: `.emp` — **No wallets to batch** / "Batch minting needs at least two
  wallets. Create them first." / `.b.p.sm` **Create a wallet**

### 4.6 Presets

Left: `Saved presets` with `.p.nu` count, `.r` rows (`.rt` name, `.rs.mono.fold`
signature) and a `.b.g.sm` **Use**; loading two `.sk.row`; empty `.emp` **No presets
saved** / "A preset stores a contract, method and arguments so a repeat mint is one
tap."

Right: `Method registry` card with the policy sentence and a `.sober` /
`table.led` of supported signatures, ending `tr.tot` **+4 more** / `1155 / SeaDrop`.

## 5. Home

- **Daily budget tile, empty state** must read exactly **"Applies once you mint"**
  under a `0.25 ETH ceiling` value. It is the ceiling, not a remaining balance, and
  the owner's instruction is to make it identical rather than reword it.
- `FirstRun` panel (`.frun`) — **does not exist in the codebase at all**. Deleting
  the last wallet currently shows nothing. Prototype: "Let's get you minting.",
  three `.step` rows (Create a wallet / Fund it / Paste a contract and mint), then
  `.b.p` **Create my first wallet** and `.b.g` **How it works**.

## 6. Screens the prototype never designed — DEFERRED by agreement

The prototype has no **error** state for Batch or Presets. Owner's decision:

> "There was no design for batch and process, so we have to do that ourselves. If
> you can't come up with it now, it's fine. We can add that to a later stage for all
> the pages that went design, so we can use the existing designs to do that."

**Trigger to pick this up:** once every screen that HAS a prototype design is
matching it. At that point, derive the missing states from the prototype's existing
vocabulary (`.notice` for errors, `.emp` for empties) rather than inventing a new
look, and list each derived screen here for review.

## 7. Open decisions — blocked on the owner

### 7.1 RESOLVED 2026-08-18 — remove the calldata editor

"Advanced: edit detected calldata directly" is **removed**. The prototype has no such
control and its Method registry states the opposite policy outright. Consequence
accepted: the dashboard can no longer mint via a hand-entered method signature and
arguments JSON. The Telegram and Discord flows are unaffected — this is a
dashboard-only control.

### 7.2 RESOLVED 2026-08-18 — auto-simulate, debounced

"Validate and simulate" is **removed**. The preview populates automatically ~600ms
after contract + wallet + quantity are all valid, and re-fires on change. This
matches the prototype, which only ever shows **Re-simulate**, and only on an expired
quote. Accepted cost: more `/api/mints/preview` calls than an explicit button
produced, each issuing a 300s preview token. Debounce so that typing an address does
not fire one request per keystroke.

### 7.3 Resolved

- **`.b.p` renders as a small pill** (`67×22`, `radius 20px`, `font 11px`). This is
  the prototype's own behaviour: its `.p` chip rule is declared after `.b`, so on
  `class="b p"` the chip geometry wins. Verified against the prototype's own "Mint
  now" — identical. Per "exactly the same", this is kept, not corrected.

## 8. Verified so far

What was actually rendered and measured, not what was written. Blank cells are
honest gaps, never assumed passes.

| Unit | Populated | Loading | Empty | Error | Light | Dark | 375 | 1440 |
|---|---|---|---|---|---|---|---|---|
| Shell chrome | yes | n/a | n/a | n/a | yes | yes | yes | yes |
| Buttons / sub-tabs / notice | yes | | yes | yes | | yes | | yes |
| Home FirstRun + tiles | | | yes | yes | yes | yes | yes | yes |
| Mint now (form + preview) | yes | | yes | yes | | yes | | yes |

The Home row's populated column is blank because the test account has no wallet
right now. It needs re-checking with one present, in BOTH directions — §0 requires
empty to become populated on create and populated to become empty on delete.

Measured identical to the prototype: rail 222px · nav 201.2x44 · active bar 3x17 at
left -10px · top 57px · cmdk 36h r9 · ib 34sq · av 32sq · badge 15sq · notice
11px 13px r13 12.5px · seg and sub-tab active `background:var(--surface)` +
`box-shadow:var(--shadow)` · .frun 16px 13px on mobile · tiles 2-up at 375px.

One incidental confirmation: a transient 502 on `/api/wallets` during testing
rendered the ERROR state rather than the empty state, which is the RULE 2 gate
working — a failed fetch is not evidence of an empty account.

## 9. Element-level collisions — a recurring class of bug, keep checking for it

The 23-name collision list in `REDESIGN_PROMPT.md` covers CLASS names only. Three
separate bugs have now come from styles.css and prototype.css declaring the same
BARE ELEMENT rule, and none of them were visible in a diff:

1. `button` — legacy painted every bare button accent-filled; prototype paints its
   chrome from classes. Neither import order was safe. Fixed by deleting the legacy
   `button` rule outright once every button carried a `.b` class.
2. `table` / `th,td` — legacy set a background and `padding/font-size:.9rem`.
3. `:where(html[data-theme=ghost-mint...]) td` — set `font-size:.8rem`, which is
   what actually overrode the prototype ledger's 12.5px. Found only by measuring;
   the first two fixes did not move the number.

**Why these hide:** an INHERITED value always loses to a rule that targets the
element directly. `.led{font-size:12.5px}` sets the table, the `td` inherits it,
and any bare `td` rule anywhere in the cascade beats that inheritance no matter how
low its specificity.

**The check:** after porting a surface, measure a computed value on its leaf
elements — not just the container — and compare against prototype.css. Do not
assume a class on the parent won. The remaining bare-element rules in styles.css to
watch are `body`, `input`, `select`, `textarea`, `h1`, `h2`, `h3` and `*`.

## 10. Principles — the reasoning behind every rule in this file

Recorded because a rule that is followed without its reason gets misapplied at the
first case it does not literally cover. These are the *whys*, so a future session
can derive the right answer for a situation nobody wrote down.

**The prototype is a finished set of decisions, not a suggestion.** The owner built
it themselves. Every number in it — a padding, a radius, a quick-pick set — is a
choice already made and already reviewed. So when something in it looks arbitrary or
sub-optimal, the correct inference is "I have not understood this yet", never "I can
improve on this". Concrete example: quantity quick-picks are `1 2 3 Max` on Mint now,
`1 2 5` on Schedule, `1 2 3` on Batch. Deriving them from `maxPerWallet` produced a
tidier expression and was wrong on all three forms.

**A sensible default invented at the keyboard is the main failure mode.** Every drift
in this project so far has been an invention, not a misreading: `1 2 5 10` picks, an
accent-filled active tab, a red-heading error panel, a bell with the wrong tab names.
None of these came from misunderstanding the prototype. They came from not looking at
it at the moment of writing the code. Hence RULE 1c: open the page file immediately
before editing that page, every time.

**Fidelity is cheaper than review.** Each invented detail costs the owner another
round of reading the screen, describing the gap and waiting. That is the expensive
resource here, not implementation time. Re-reading a 200-line HTML file costs
seconds; a missed quick-pick set costs a full review cycle.

**"Exactly the same" is literal and covers every axis.** Text, size, border width,
radius, padding, gap, weight, the wide→tablet→phone transition, light and dark, and
all four states. Partial matches are the thing that makes the app feel almost-right,
which is worse than obviously-wrong because it does not get reported — it just reads
as sloppy.

**All four states exist because users land in them.** The owner reached the empty
state by deleting their only wallet and found nothing there. Empty and error are not
edge cases to add later; for a new user the empty state IS the product. And they must
be live in both directions — create restores populated, delete restores empty.

**Measure, do not eyeball.** Two bugs this session were invisible in screenshots and
in diffs: the accent-filled `button` leak and the `td` font-size leak. Both were found
by reading computed values and comparing them against prototype.css. Screenshot *and*
probe; a screenshot alone caught neither, and twice a mid-render screenshot nearly
produced a false report of a bug that did not exist.

**Element-level rules beat inherited ones.** See §9. This is why "the container has
the right class" is not evidence that its children render correctly.

**Say what was not checked.** A verification table with honest blanks is more useful
than one with assumed passes, because the blanks are where the next bug is.

### Mint now — empty state, element by element (verified 2026-08-18)

Checked against docs/prototype-pages/mint.html with the account's only wallet deleted:

| Element | Prototype | Rendered |
|---|---|---|
| Banner | `.nt.w` "Create a wallet before minting." + "The form below is shown disabled so you can see what minting looks like." | matches |
| Banner action | `.b.sm` "Create a wallet" | matches |
| Contract input | disabled, `0x… paste a contract address` | matches |
| Wallet select | disabled, "No wallets yet" | matches |
| Quantity picks | `1 2 3 Max`, first `.on`, all disabled | matches |
| Price input | disabled, "Detected once a contract is entered" | matches |
| CTA | `.b.big.bl` disabled, "Create a wallet to mint" | matches |
| Footnote | "Preview stays visible at all times — a collapsed total is a hidden total." | matches |

The form is shown DISABLED rather than hidden, which is the point of the state.

### Schedule tab — the action row. RULED 2026-08-19: selection, not per-row

The prototype (mint.html:145) puts a SINGLE action row after the scheduled list:
Pause / Resume / Retry / Cancel. It was first built per-row instead, on the reasoning
that a single row cannot be wired to anything because the design has no selection
model — no checkboxes, no active row, nothing to say which scheduled mint the buttons
would act on.

**The owner rejected that, reading the prototype back against the build:** the bar
belongs under the list exactly as drawn, and the rows become selectable. Their words —
"the pause, resume, retry and cancel buttons were under the three schedule items,
while yours is beside the single scheduled one ... there will be multiple pause and
resume and cancel buttons, so I think they should be selectable."

Two things that reasoning got right, worth keeping:

- The per-row build read the single bar as a *legend* because there were three rows
  and one bar. But the bar sits under three rows in the prototype and would sit under
  ten in the app — the count was never the variable. One bar is the design.
- The missing selection model was a real gap, but the prototype does define a checkbox
  treatment: the Batch wallet list (mint.html:171-173) and Automation (auto.html:49),
  both `min-height:auto;width:16px;height:16px`. Reusing that is staying inside the
  prototype's own vocabulary; inventing a selected-row highlight would not have been.

Built now as: a checkbox opening each `.r`, one `.br` under the list carrying all
four controls in the prototype's order and classes (`.b.sm` ×3 + `.b.d.sm`), then the
pager. Controls the current selection cannot take are `disabled` rather than hidden,
so the row does not reflow as the selection changes — `.b[disabled]` (prototype.css:354)
is the prototype's own treatment for exactly that.

**The rule this generalises to:** when the prototype's placement looks inoperable,
the missing mechanism is the thing to find, not the placement to move.

### Pager

Rebuilt to the prototype's .pager: a .pinfo "N of M" pushed left, a single-glyph
prev, numbered buttons with the current one .on, and a single-glyph next. The legacy
centred "Previous / Page 1 of 3 / Next" is deleted. Windowed to five numbers so a
long list cannot spill its own row — the prototype only ever shows three pages and
does not say what fourteen should look like.

## 11. Scheduled-mint semantics, and the pagination rule for the WHOLE project

Stated by the owner 2026-08-18, reading their own prototype back. Recorded because
the reasoning generalises well beyond this one card.

### 11.0 Owner rulings, 2026-08-19 — the Schedule card, second pass

Read against the built page. These SUPERSEDE parts of §11.1 and §10 below, and the
prototype (`mint.html`) has been updated to match rather than left behind — otherwise
rule 1 turns into a trap, and the next session "corrects" the app back to a design the
owner has already moved past.

1. **No checkboxes.** Selection is a highlight on the row itself (`.r.on`); the row
   carries `role="button"` and `aria-pressed`. Multi-select still applies.
2. **A selection is homogeneous.** The first row picked fixes the action set; only rows
   offering exactly the same actions can join. Mixing was previously allowed with the
   action applying to whichever subset could take it — one row changing while another
   silently did not. Owner: "I cannot select a scheduled item, then also select another
   one, and it now be cancelled ... I don't think that should be allowed."
3. **Selection stays per page**, on the owner's decision after asking for a
   recommendation. Cancel can therefore never act on a row that is off screen, and no
   selection counter is needed because everything selected is visible.
4. **"N pending" became a filter**, one bucket at a time, pending by default.
5. **Pending EXCLUDES paused.** See §11.1 — this reverses the earlier ruling.
6. **Failed is red; cancelled is not.** Failed went wrong on its own; cancelled is
   something the user chose. Coluring a deliberate act like an error teaches people to
   ignore red, and this account's list is mostly cancelled test rows.
7. **Pager gains « and »**, only past three pages, disabled at the ends like the
   single arrows.

### 11.0b Third pass, 2026-08-19 — expired, and the filter actually filtering

8. **The countdown ring was filling over a fixed final hour**, so a mint two minutes out rendered
   96.7% full on its first frame and crept the last 3%. It now fills across the mint's OWN wait
   (`createdAt` -> `mintTime`), starting empty whatever the distance.
9. **`expired` is a sixth bucket**, derived rather than stored — the schema allows seven statuses
   and this is not one of them. It is a paused or failed mint whose time went by **more than an
   hour ago** (`EXPIRY_GRACE_MS`), and it takes precedence, so the buckets stay a partition.

   The grace period is the whole design. Expiry cannot be "mint_time < now": a mint FAILS because
   its time arrived, so that test is true for essentially every failure, which left `failed`
   permanently empty and piled everything into `expired`. Measured live before the fix —
   failed 0, expired 1. Inside the hour a failure is worth retrying (flaky RPC, a wallet you can
   top up); past it the drop is over.

   Expired withholds Retry and Resume, which is the owner's point: expired is a state, not an
   action. An expired **paused** mint can still be Cancelled (the server's cancel accepts
   'paused'); an expired **failed** one accepts nothing, since Retry was its only route.
10. **Filtering works before the server ships**, via a shim in `Tasks`. A response carrying
   `counts` means a server that filters; one without does not, and the client then fetches up to
   50 rows unfiltered and filters and pages locally, reusing `bucketOf` rather than duplicating
   it. Past 50 rows it says so in an `.nt.i` rather than quietly showing a subset. It disables
   itself the moment the server answers with counts.

   This was avoided for two turns as duplicated logic, and that was the wrong call: the feature
   was unusable on the only environment the owner can see.

### 11.0c Chip colours, 2026-08-19 — one hue per state

Grey was carrying four different meanings: All, Paused, Cancelled and Successful all wore it, so
Cancelled was indistinguishable from the no-filter view sitting beside it. The owner ruled each
should stand apart. The prototype's pill palette had only four tones (`ok` `bad` `wn` `nu`), so
three were added: `.p.ac` (theme accent), `.p.info`, `.p.idle`.

| chip | tone | why |
|---|---|---|
| All | `nu` grey | the absence of a filter; it should not compete |
| Pending | `ok` green | live and coming |
| Paused | `info` blue | deliberately held, not broken |
| Failed | `bad` red | the only one that went wrong on its own |
| Expired | `wn` amber | a window that went past |
| Cancelled | `idle` violet | ended by choice — distinct from grey AND from red |
| Successful | `ac` accent | the theme's signature, the liveliest colour it has |

**`--info` and `--idle` are defined in all five themes, and the hue is chosen against each
theme's own accent.** `clean-vault` and `quiet-ledger` are already blue/navy, so a blue "paused"
would have collided with the accent that now marks Successful — both use teal instead.

Contrast measured against each theme's real backdrop (not the card, which is transparent in two
themes — measuring against that gave false failures first time round). Every chip clears WCAG AA:
the weakest is Successful at **4.95** in `clean-vault`, which is that theme's own `--accent` and
therefore inherent to the token rather than introduced here.

### 11.1 "2 pending" above three rows

The prototype's Scheduled card shows a `.p.nu` chip reading **2 pending** above
THREE rows: one Scheduled, one Paused, one Failed. The arithmetic is the spec:

- **Pending = not yet fired.** Scheduled counts. Failed does NOT count; it is terminal.
- Counting only `status === 'scheduled'` prints 1 against those same three rows,
  which is how the first implementation got it wrong.

**Paused: reversed 2026-08-19.** This section originally counted paused as pending
("suspended, not finished"). The owner reversed it when specifying the filters: pending
means "scheduled items that have not been cancelled or failed or paused". The reasoning
holds up — with paused as its own filter, counting it under pending too would put one
row in two buckets, and the five counts would no longer sum to the total.

Statuses now group into five buckets that **partition** all seven the schema allows
(`TASK_BUCKETS`, schedulerRepository.js):

| bucket | statuses |
|---|---|
| pending | `scheduled`, `claimed`, `retry` |
| paused | `paused` |
| failed | `failed` |
| cancelled | `cancelled` |
| done | `succeeded` |

`done` is not one of the owner's four. Without it, a mint that actually fired would be
reachable under no filter at all — the partition is the point, not the tidiness.

Separately, `ACTIVE_STATUSES` (pending + paused) still backs `countActive`, which
answers a different question: what work this deployment owns, not what is queued.

### 11.2 What each control means

- **Pause** — suspend a mint that is still going to fire.
- **Resume** — un-suspend a paused one.
- **Retry** — re-attempt one that has already failed.
- **Cancel** — stop a mint that is still going to fire. It does **not** delete the
  row: `schedulerRepository.cancel` (schedulerRepository.js:137) sets
  `status='cancelled'` and the row stays in the list wearing a cancelled pill. The
  confirmation said "Delete this scheduled mint?" until 2026-08-19, which was simply
  untrue; it now reads "Cancel this scheduled mint? It will not fire, and this cannot
  be undone." The ellipsis stays, which is what an ellipsis on a button means: this
  opens something before it acts.

**Which control a status accepts is the server's decision, not the UI's.** The four
guards are WHERE clauses in schedulerRepository.js:137-155 and the UI now mirrors them
exactly:

| status | accepts |
|---|---|
| `scheduled` | Pause, Cancel |
| `retry` | Pause, Cancel |
| `paused` | Resume, Cancel |
| `failed` | Retry |
| `cancelled`, `completed`, `claimed` | nothing |

Found by live testing, not by reading: Cancel was previously offered on **anything**
selected, so cancelling an already-cancelled row produced "id was not found or cannot
be canceld" — an error the user could do nothing about, from a button that should
never have been live. `retry` status offered nothing at all, because the old list of
statuses was guessed rather than taken from the server.

The controls act on the **selection** — see §10, ruled 2026-08-19. An action is
offered when at least one selected schedule can take it, and then runs against exactly
those: select a paused and a failed mint together, press Retry, and the failed one
retries while the paused one is left alone rather than erroring on the pair. Cancel
applies to anything selected.

Selection is scoped to the page in view. Paging clears it, and every control
intersects the selection with the rows actually on screen, so a control can never be
enabled with nothing behind it.

(An earlier revision of this section recorded the opposite — that the controls act on
individual rows. That was the pre-ruling build; §10 has the correction and the
reasoning.)

### 11.3 Pagination — applies to every list in the project

From "three of 14 ... if I click the right arrow, it should show me the fourth one,
and so on. Please apply this logic, not just for this page, but for the whole
project including the navigation."

- `.pinfo` reads **"N of M"** where N is how many rows have been shown UP TO AND
  INCLUDING the current page, and M is the total across all pages. On page 1 of a
  3-per-page list of 14 that is "3 of 14"; on page 2, "6 of 14".
- The right arrow advances to the next page — item 4 onwards in that example. The
  numbered buttons jump directly, current one `.on`.
- **Every paginated surface uses the one shared `Pager`.** Tasks and Activity
  already did; the admin Users table had a hand-rolled "Previous / Page X of Y /
  Next" and has been converted. Any new list must use the shared component rather
  than growing its own, so this behaviour cannot drift apart again.

The general principle, which is the part worth keeping: **a truncated list must say
what it is truncating.** "3 of 14" tells the user 11 more exist; "Page 1 of 5" makes
them do the arithmetic, and a bare list tells them nothing at all.

### 11.4 The "N pending" chip counted one page. FIXED 2026-08-19

Measured 2026-08-19 with 22 tasks (14 scheduled, 8 cancelled) at pageSize 10:

| page | chip reads | truth |
|---|---|---|
| 1 | 10 pending | 14 |
| 2 | 2 pending | 14 |

The count is computed from `listing.data.items`, which is only the page in view, so it
changes as the user pages. It was invisible until this session because the account had
never held more than one page of schedules — the bug was always there, the data was not.

Fixed server-side: `listPageForUser` counts pending in the same round trip as `total`,
over the **same WHERE clause**, so the two numbers always describe one set — under a
search, "N pending" narrows with it. `pageFrom` stays generic: it forwards any extra
total a repository returns, and takes a `counts` function for the in-memory fallback
path, which is handed every matching row rather than the ten being returned.

The status list now lives once, as `PENDING_STATUSES` in `schedulerRepository.js`, shared
by `countActive` and the per-user count so they cannot drift.

**The client keeps a fallback, and it is load-bearing rather than defensive.**
`dashboard/vite.config.js` proxies `/api` to the deployed instance, so until this ships
the response has no `pending` field. App.jsx falls back to the page count — the old
wrong number, which beats rendering "undefined pending" — and self-corrects the moment
the server catches up. Verified live: the chip still reads "10 pending" against
production today, with no undefined leaking through.

**Activity was checked and is clean** — it renders items and a pager with no aggregate
over the collection. Its only count is `items.length===0` for the empty state, which is
a per-page question and correctly answered per page. The Scheduled chip was the only
instance of the trap.

## 12. Batch and Presets — notes from the rebuild

**Batch has no price field.** The prototype's form is three fields only: Contract
address, the wallet checkbox list, Quantity per wallet (mint.html:161-181). The app
had a "Price per mint (ETH)" input; removing it to match meant the price has to come
from somewhere, so it is detected from the contract exactly as Mint now does it.
Same endpoint, same address-shape guard, same no-visible-trigger behaviour.

**Low-balance wallets are tinted.** The prototype colours a wallet row that cannot
cover the mint in `--warn-text`, so the row that is going to fail is legible before
you submit rather than after.

**Presets "Use" now does something.** The old Mint-now form had a "Saved preset"
select that was dead code — `inspect()` hardcoded `presetName: undefined`, so its
value was discarded before the request. The select is gone (the prototype has no
such field) and the prototype's `Use` button on each preset row carries the intent
instead: it prefills the Mint now form and switches to that tab.

**The method registry is a static list.** The prototype hardcodes its supported
signatures, and nothing exposes the server's real signature table to the dashboard,
so this is a reference panel rather than live data. **If a route is ever added, bind
it** — a hardcoded list here silently goes stale when the server's list changes.

Quantity quick-picks, for the third time, are per-form literals: Mint now `1 2 3 Max`,
Schedule `1 2 5`, Batch `1 2 3`. Each site carries a comment saying so.

## 13. Quantity quick-picks — the rule, replacing the prototype's literals

The prototype hardcodes three different sets: `1 2 3 Max` (Mint now, cap 3),
`1 2 5` (Schedule, cap 100), `1 2 3` (Batch, cap 3). The owner's read on 2026-08-18
was that Schedule's set does not follow from its cap, and asked for the RULE instead
of the literals — "should we make it automatic, so it senses the max quantity?"

**Agreed rule** (`quantityPicks` in `shared.jsx`, used by all three forms):

> 1 and 2 always, then the largest round step at or below half the cap, then Max.
> If that third step collides with 1 or 2, use the cap itself.

| cap | picks | note |
|---|---|---|
| 3 | 1, 2, 3, Max | identical to the prototype's Mint now |
| 5 | 1, 2, 5, Max | owner's "maybe one, two, the max is five" |
| 10 | 1, 2, 5, Max | owner's "if it's ten, maybe one, two, five, max" |
| 100 | 1, 2, 50, Max | Schedule |

This is a **deliberate, owner-approved departure** from RULE 1c for this one control:
the derived values reproduce the prototype exactly where its cap is 3, and only
differ where the prototype's literals did not follow their own cap.

## 14. Schedule's price field — covering a case the prototype does not

The prototype's Schedule form has no price input, because it assumes every contract
can be priced automatically. Some cannot: the server rejects with
`priceETH: could not be determined from this contract; please provide it`, and with
no field there was nowhere to type one — the form was unsubmittable for those
contracts. Confirmed live, not reasoned about.

The field now appears **only after that rejection**, carrying the server's own
message in the prototype's `.in.bad` + `.fielderr` treatment. A gap in the design
rather than a departure from it, but flagged for a ruling.

**Found alongside it:** `api()` in `shared.jsx` flattened validation issues into the
error message and never attached them to the error, so `error.issues` was always
undefined. The prototype's per-field validation state could therefore never fire
anywhere — Mint now's quantity `.fielderr` included. `api()` now keeps `issues` on
the error. This is worth remembering: a state can be fully built, correctly styled,
and still be unreachable because nothing upstream supplies its trigger.

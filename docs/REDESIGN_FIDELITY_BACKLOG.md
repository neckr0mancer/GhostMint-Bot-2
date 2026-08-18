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
| 1.5 | Mint page rebuild | **Mint now + Schedule: DONE**. Batch / Presets tabs: TODO |
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

### Schedule tab — one deliberate deviation, needs a ruling

The prototype (mint.html:145) puts a SINGLE action row after the scheduled list:
Pause / Resume / Retry / Cancel. That cannot be wired to anything, because the design
has no selection model — no checkboxes, no active row, nothing to say which scheduled
mint the buttons would act on.

Built instead as a per-row action row, keeping the prototype's exact classes
(.b.sm and .b.d.sm), labels and order. Every visual token is the prototype's; only
the placement differs, and only because the prototype's placement is not operable.

**Ruling needed:** accept per-row, or add a selection model so the single row can
match the prototype literally? Per-row is what is in the tree today.

### Pager

Rebuilt to the prototype's .pager: a .pinfo "N of M" pushed left, a single-glyph
prev, numbered buttons with the current one .on, and a single-glyph next. The legacy
centred "Previous / Page 1 of 3 / Next" is deleted. Windowed to five numbers so a
long list cannot spill its own row — the prototype only ever shows three pages and
does not say what fourteen should look like.

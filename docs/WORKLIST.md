# GhostMint Feature Worklist

Tracks the backlog of user-facing feature work (mint reliability, transaction modes, sniper, gas,
wallet import, OpenSea pricing, send/deposit UX, Telegram formatting). Separate from
[`ROADMAP.md`](../ROADMAP.md), which covers the numbered platform/safety milestones (1–16, all
shipped).

- **Round 1** (Sections A–K) was scoped and implemented on 2026-08-16; 9 of 11 sections shipped in
  commit `423c7c1`. Kept below as the record of what exists.
- **Round 2** (Sections L–R) is the newer batch of requirements, not yet started.

Status legend: ✅ Done · 🟡 Partial · ❌ Not started

---

# Round 2 — additional requirements (current backlog)

## Section L — Custom "X amount" input everywhere ❌

Round 1 added fixed quick-pick buttons (send: Max/75/50/25; mint quantity: 1/2/5/max). What's
missing is an explicit **`X` / custom** button on those same keyboards that switches to manual
entry, rather than relying on the user knowing they can just type a number.

- Applies to: send amount, mint quantity, and any other quick-pick keyboard added later
  (scheduled-mint quantity, sniper caps).
- Typing a raw number already works today on both steps — this is about making that discoverable
  as a button, and making the prompt say so.

## Section M — Automatic contract detection → one-shot mint popup 🟡

Round 1 got partway: pasting a bare `0x…` address with no command now auto-detects the contract
and shows the details screen, on Telegram and Discord. What's missing is collapsing the rest of
the flow into that one popup.

- Today after detection: details → Continue → (quantity, if max>1) → wallet → (price) → confirm.
  That's up to five taps.
- Wanted: the detection result **is** the mint interface — one popup carrying default amount
  buttons, the `X` custom-amount button from Section L, and Yes/No confirm, completing the mint
  without leaving it.
- **Multi-wallet behavior (decided):** show a select-wallet prompt first, then the confirmation
  after it. So the shape is:
  - *One wallet* (the common case, already auto-selected today): paste → popup with amount
    buttons + `X` custom → Yes/No confirm → done.
  - *Multiple wallets*: paste → popup with amount buttons + `X` custom → select wallet →
    confirm → done.
- **Depends on Section N.** The headline case here is "user pastes an address" — i.e. the user
  types a message — which is exactly when the anchored-panel bug bites. Today pasting an address
  already renders the details panel *above* the pasted text (the bare-address branch doesn't
  delete the user's message the way flow steps do). Building M before N means shipping the new
  popup directly on top of the bug, so N should land first or alongside.

## Section N — Telegram prompts appear above the user's input ✅

Reported symptom: new prompts still render above what the user just typed.

**This is a real consequence of Round 1's Section J**, and worth being upfront about: converting
every one-shot command reply to edit an anchored message means the panel stays where it was in the
transcript. When you then type `/gas`, your message is the newest thing in the chat and the bot's
updated panel sits above it — so the chat reads out of order. Guided flows hide this by deleting
the user's message (`tgDeleteUserMessage`), but that only runs on flow text steps and only works
when the bot has delete permission.

Three candidate fixes, in increasing order of intrusiveness:

1. **Re-anchor on divergence** — if the anchored panel is no longer the most recent message in the
   chat, delete it and send a fresh one instead of editing in place. Keeps one live panel and
   keeps it at the bottom. Costs one delete + one send per interaction.
2. **Delete the user's command message too**, extending what guided flows already do to one-shot
   commands. Cheapest, but silently removes the user's own messages from their history, and fails
   closed where the bot lacks delete rights.
3. **Only edit while the panel is still last**, otherwise send new — a middle ground that leaves
   stale panels behind in scrollback.

**Shipped (option 1, re-anchor).** Ordering logic lives in `src/telegram/panelState.js` as a pure,
unit-tested store (11 tests), mirroring how `flowState.js` separates sequencing from delivery;
`server.js` keeps only the Telegram calls that act on its decisions. Behavior:

- The panel is edited in place while it is still the newest message in the chat.
- Once the user sends anything below it, the panel *moves*: a fresh one is sent at the bottom and
  the stale one deleted. The delete is attempted only after the replacement sends, so a failed
  send can never leave the chat with no panel.
- Guided flows that delete the user's reply roll that back (`noteDeleted`), so they keep editing
  in place rather than pointlessly chasing a message nobody can see.
- Telegram message ids are per-chat sequential, so `newest > anchor` decides this with no extra
  API call.

Writing the tests caught a real ordering bug in the first implementation: the size sweep ran
before the insert, so a store one entry below its threshold never swept at all.

## Section O — Button ⇄ command parity ❌

Every UI button must do exactly what its `/` command does, sharing the same code path rather than
a parallel implementation. Round 1 fixed two of these (Telegram's Gas and Transaction mode buttons
now act directly, calling the same `botCommands.gas()` / `selectMode()` the commands use). The
rest are still placeholder screens that just tell the user to go type a command:

| Surface | Buttons still telling the user to type a command |
|---|---|
| Telegram | `menu:snipers`, `menu:watch`, `menu:activity`, `menu:admin` |
| Discord | `menu:mint`, `menu:tasks`, `menu:snipers`, `menu:watch`, `menu:activity`, `menu:gas`, `menu:admin` |

Discord's menu is substantially further behind than Telegram's — effectively every entry is a
placeholder there.

**On the Gas / Transaction-mode wording:** the requirements say these buttons "should not
prompt/use the equivalent command" but also "must remain consistent with the command-based
implementation" and, under parity, must "act as UI shortcuts to the existing command
functionality." Read literally those pull in opposite directions, so I've taken it as: *the button
must not reply with "go type `/gas <chain>`" — it must perform the action itself, through the same
underlying service the command calls, so results are identical either way.* That's what Round 1
already implemented for Telegram's two. **Correct me if you meant something else** — specifically
if "independently fetch gas data" was meant to imply a separate data source rather than a separate
prompt, that's a different (and contradictory) requirement.

## Section P — Watch specific transactions ❌

Today's watching is wallet-level (`sniperService` copies a target wallet's confirmed transactions;
`socialWatch` monitors social sources). Wanted: watch a **specific transaction** tied to a wallet
address and notify on occurrence/state change.

- Delivery routes to whichever platform is configured — Discord if configured, Telegram if
  configured. `notificationService` already resolves a user's linked platforms, so the delivery
  half largely exists; the tracking half does not.
- Overlaps with Section R (sniper contract-open detection) — both want a poller watching chain
  state and firing a notification/action. Worth building one watcher abstraction for both rather
  than two.

## Section Q — Accept OpenSea collection links ❌

Accept `opensea.io` collection URLs anywhere a contract address is accepted, resolve the URL to
its collection/contract, then continue into the normal contract/mint workflow.

- `openSeaService` already talks to the OpenSea API and can map a collection slug to a contract
  (`/collections/{slug}` → contract address), so this is mostly URL parsing plus one lookup, not
  new integration work.
- Should slot into the same entry points as a bare address (Section M), so pasting a link behaves
  exactly like pasting the contract it refers to.

## Section R — Sniper guided config + contract-open auto-detection ❌

Carried over from Round 1, still the largest single item.

- No guided config flow: Telegram has no sniper-creation command at all; Discord's `/sniper create`
  takes one pre-validated JSON blob.
- No mint-open detection. Plan: guided flow (contract → chain → wallet → fee tolerance → caps), a
  `sniper_mode: 'copy' | 'contract_open'` field, and for `contract_open` a poller on
  `PublicDrop.startTime` (SeaDrop) or a `paused()`/`saleActive()` getter, firing through the same
  transaction engine once open and respecting the sniper's own caps. Share the watcher with
  Section P.

## Section S — Discord guided task-schedule ❌

Carried over. Discord's `/task create` still needs a raw JSON body with explicit `mintTime`, while
Telegram and the dashboard both auto-detect price and opening time. Needs a modal/select-menu flow
like Discord's existing wallet create/import. Natural to bundle with Sections O and R, which all
need the same Discord component patterns.

## Suggested order for Round 2

1. **Section N** (prompt position) — it's a live UX regression from Round 1 and needs a decision
   from you before anything else touches Telegram rendering.
2. **Section L** (custom X button) — small, self-contained, and Section M depends on it.
3. **Section M** (paste → one-shot mint popup) + **Section Q** (OpenSea links) — same entry point,
   best done together.
4. **Section O** (parity) — mechanical but broad; Discord is the bulk of it.
5. **Section P** + **Section R** — share one watcher abstraction, build together.
6. **Section S** — folds naturally into O/R's Discord work.

## Open questions blocking clean implementation

- ~~**Section N:** which of the three fixes?~~ **Answered:** re-anchor. Shipped — M is unblocked.
- ~~**Section M:** multi-wallet behavior?~~ **Answered:** select-wallet prompt first, then
  confirmation.
- **Section O:** confirm the Gas/mode reading above — "don't make the user type the command,"
  not "use a different data source."

---

# Round 1 — shipped 2026-08-16 (commit `423c7c1`)

## Section A — Mint reliability ✅

- `/mintnow` is a real one-shot: with a resolvable contract, one wallet, and a known price it
  reaches execution with zero taps *when the caller's transaction mode allows bypass* (Degen).
  Anything unresolvable is still asked for; without bypass it behaves like `/mint`.
- Bare `0x…` addresses with no command show contract details on Telegram and Discord.
- Telegram formatting migrated from broken `*asterisk*` Markdown (which never rendered, since
  `parse_mode` was never set) to HTML bot-wide, with `escapeTelegramHtml` applied to every
  interpolated free-text value.

## Section B — Scheduled mint parity ✅

- Fixed a real bug: `executeTask` hardcoded `mint(uint256)` straight to the NFT contract while
  immediate `/mint` correctly branched to SeaDrop's core contract — a scheduled SeaDrop mint would
  not have minted. Both paths now share `prepareMintCall()`.
- Dashboard's Schedule form gained the same auto-detect the Minting form had.

## Section C — Transaction modes (Degen → Normie) ✅

- Migration `035` adds `gas_price_multiplier` to `mode_presets` (Degen 1.5×, Fast 1.2×, Cautious
  1.05×, Normie 1.0×), applied in `transactionEngine.js` to auto-computed fees only — never
  overriding an explicit caller-supplied gas price.
- Button/dropdown mode selection on Telegram, Discord, and the dashboard.

## Section D — Gas per-chain ✅

Telegram's `/gas` takes a chain argument and the Gas button renders a real chain switcher.
`ETHERSCAN_API_KEY` set; live data on all 6 configured chains.

## Section F — Batch wallet import ✅

Owner-only, on dashboard and Discord, reusing `persistWallet` per key with per-key success/failure
reporting. Skipped on Telegram deliberately (pasting raw private keys into Telegram is a worse
security posture).

## Section G + K — OpenSea price fallback, accept-price, quantity ✅

- `OPENSEA_API_KEY` set via OpenSea's public self-service free-tier endpoint
  (`POST /api/v2/auth/keys`, no login). Expires ~weekly; `npm run opensea:refresh-key` renews it.
- Unreadable contract price → OpenSea floor offered as one-tap accept, free-text fallback either
  way, on both `/mint` and `/schedule`.
- `maxPerWallet > 1` now prompts for quantity instead of hardcoding 1.

## Section H — Deposit + wallet list ✅

`/deposit` on Telegram and Discord; `EVM` prefix on Telegram wallet balance blocks.

## Section I — Send quick amounts ✅

Max/75/50/25 buttons; Max reserves a gas buffer (21000 gas at current fast fee +30%) so it doesn't
leave nothing for the network fee.

## Section J — Telegram edit-in-place ✅ (see Section N)

All ~45 one-shot command replies now edit the chat's anchored message via `tgRender`. **Note the
side effect captured in Section N above** — this is what causes prompts to render above newly
typed user input.

## Verification (Round 1)

`npm run check`, `npm run lint`, `npm run dashboard:build`, and the full 375-test suite all pass.
Migration `035` applied and spot-checked against the database. Two real defects were caught by
actually booting/merging rather than by tests: a Discord command-registration ordering error
(optional option before a required one, which discord.js accepts at build time but Discord's API
rejects at registration), and a merge that would have reverted a wrong-network safety fix on
`main`. A third finding — the banned-account scheduler smoke test failing — was diagnosed as a
pre-existing 15s timing budget against a ~14s operation, not a regression; deadline widened to 60s
with assertions unchanged.

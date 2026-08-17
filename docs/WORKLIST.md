# GhostMint Feature Worklist

Tracks the backlog of user-facing feature work (mint reliability, transaction modes, sniper, gas,
wallet import, OpenSea pricing, send/deposit UX, Telegram formatting). Separate from
[`ROADMAP.md`](../ROADMAP.md), which covers the numbered platform/safety milestones (1–16, all
shipped).

- **Round 1** (Sections A–K) was scoped and implemented on 2026-08-16; 9 of 11 sections shipped in
  commit `423c7c1`. Kept below as the record of what exists.
- **Round 2** (Sections L–S) is the newer batch of requirements, not yet started.
- **Round 3** (Sections T–Z) is candidate work sourced from studying an external reference project,
  not yet scoped or estimated.
- **Round 4** (Section AA) is a follow-up requirement raised while shipping Round 2's Section Q,
  not yet started.

Status legend: ✅ Done · 🟡 Partial · ❌ Not started

---

# Round 4 — Discord guided mint flow (2026-08-17)

## Section AA — Discord guided mint flow via pasted text/link, with real wallet/quantity picking ❌

Section Q (below) added OpenSea-link acceptance to Discord's bare-content detector, but that
detector is still read-only — it shows contract details and stops. Discord has no equivalent of
Telegram's `mint_guided` flow, so there's nowhere for a pasted address or link to lead beyond the
preview: no step-by-step wallet or quantity picking for the ambiguous cases (multiple wallets,
`maxPerWallet > 1`, unknown price), the exact gap called out while scoping Section Q's Discord
side. Explicit product decision: build the real guided flow, not the smaller one-shot-command
fallback that was also on the table (a `!mint <address>` text command auto-executing only when a
single wallet and known price make it unambiguous, falling back to "use `/mint` with these
options" otherwise).

- **Goal:** pasting a bare address or an OpenSea link on Discord — the same trigger Section Q
  already recognizes — starts a real stateful mint flow with wallet and quantity picking, not just
  a preview. `/mint` with no options should reach the same flow.
- **Design sketch (from scoping conversation, not yet built):**
  - Reuse `src/telegram/flowState.js` the way Discord's guided wallet create/import already does
    (Milestone 15c) — keyed by `('discord', chatId)`, same TTL/sweep behavior, no new store.
  - Mirror Telegram's `mint_guided` step shape (`awaiting_quantity` → `awaiting_wallet` →
    `awaiting_price` → `awaiting_confirm`) and its Section M one-shot-popup behavior (skip
    straight to whichever step is actually needed, no dead "here's the contract" screen), but
    rendered as Discord embeds + buttons/select-menus instead of Telegram inline keyboards.
  - Every step still ends by calling the exact same `botCommandService` functions
    (`detectMintContract`, `resolveMintContractInput`, `mint`) the slash command and Telegram
    already use — no parallel validation or execution path, per this file's and `ROADMAP.md`'s
    existing rule for every guided step on every platform.
  - Natural to bundle with **Section O** (Discord's `menu:mint` button is currently a placeholder
    pointing at the slash command — this flow is what it should actually open) and **Section S**
    (same Discord modal/select-menu component patterns needed for guided task-schedule).
- Not started. Scope is closer to "give Discord a mint_guided" than a small follow-up fix — sized
  accordingly rather than folded silently into Section Q's commit.

---

# Round 3 — candidate improvements from studying OSNM-Z (2026-08-17)

`osnm-z-main` — a separate, unrelated Rust CLI for sniping OpenSea-hosted SeaDrop mints
(single-operator, no multi-user/DB/bot layer) — was found dropped into this repo's working
directory by mistake and moved out to a sibling directory
(`C:\Users\hp\Documents\osnm-z-main`, outside this repo). It was reviewed for patterns GhostMint
could adopt. None of the items below are scoped or estimated; they're candidates only.

## Section T — Extract token IDs from mint receipts ❌

`osnm-z-main/src/nft.rs`'s `extract_minted_assets()` parses `receipt.logs` for the ERC-721
`Transfer` and ERC-1155 `TransferSingle`/`TransferBatch` events, filtered to `from == 0x0`,
`to == wallet`, on the target contract, and decodes the minted token ID(s). This is a working,
tested reference for exactly blocker #1 in this file's own deferred P&L sales-detection note
under Section G + K: "no token ID is captured from a mint receipt today." Would land in
`transactionEngine.js`'s `inspectChain`, alongside the existing `gasUsed`/`gasPrice`/`blockNumber`
read, and unblocks that deferred work.

## Section U — Validate mint calldata before signing, not just before broadcasting ❌

`osnm-z-main/src/opensea.rs`'s `validate_stage_calldata`/`validate_mint_transaction` decode the
ABI words of any externally supplied calldata (contract address, minter, quantity, selector) and
cross-check them against what was actually requested, rejecting anything that doesn't match,
before it's ever signed. Needs confirming whether `src/mint/seaDropCall.js`/`mintCall.js` already
do the equivalent for GhostMint's own constructed calls — matters most wherever calldata comes
from an external source (OpenSea price/eligibility lookups) rather than being built entirely
in-house.

## Section V — Verify bytecode, not just the address, for canonical contracts ❌

`osnm-z-main` pins `MULTICALL3_RUNTIME_HASH`/`AUDITED_EXECUTOR_RUNTIME_HASH` and checks deployed
bytecode against them before trusting a canonical contract address. `seaDropDiscoveryService.js`
already checks OpenSea's canonical SeaDrop core address as a discovery tier (commit `32875d6`) —
needs confirming that also validates the bytecode hash, not just that *something* is deployed at
that address, since an address-only check is exactly what a spoofed/reorg-substituted contract at
the same address would defeat.

## Section W — Capture-then-revalidate timing for contract-open sniping ❌

`osnm-z-main/src/multi_mint.rs`'s wake-lead constants (10–15s before a known open time, capture
nonce/fees/balance once) plus a ~2s pre-submit calldata refresh are the shape this file's own
Section R plan needs ("poller on `PublicDrop.startTime`"): sleep-until-near, capture state once,
re-validate right before submit, rather than either constant polling or a single blind shot at a
guessed timestamp. Feeds directly into Section R's implementation, not a separate feature.

## Section X — Fee-policy as pure, unit-tested functions ❌

`osnm-z-main/src/fee.rs`/`src/domain/fees.rs` cleanly separate an *initial* multiplier from a
*replacement* (stuck-transaction) bump, both basis-point math with overflow-safe ceiling division,
plus a bounded max-fee ceiling computed across N retry attempts. Needs checking whether
`transactionEngine.js` has an equivalent bounded escalation policy for replacing stuck
scheduled-task transactions, or just applies the mode multiplier once with no replacement bump.

## Section Y — Test that decrypted key material can never leak through Debug/logging ❌

`osnm-z-main/src/wallet_generator.rs`'s test `debug_output_never_contains_generated_private_keys`
asserts a struct's debug/string formatting can't contain a raw private key. Cheap regression
insurance worth adding to GhostMint's own test suite for whatever in-memory structure carries a
decrypted private key during signing, against an accidental future log/error-message leak.

## Section Z — Bounded response reads and selective retry for external HTTP calls ❌

`osnm-z-main/src/opensea.rs`'s `read_limited_body` hard-caps response size to avoid unbounded
memory growth from a malformed/oversized response, and `is_retryable_request_error` retries only
429/5xx/408/409/425, failing fast on everything else. Needs confirming `openSeaService.js`/
`priceFeedService.js` don't retry indiscriminately or buffer unbounded response bodies.

## Considered and explicitly not recommended

- **EIP-7702 sponsored-gas mode + a custom on-chain batch-executor contract**
  (`osnm-z-main/contracts/src/SponsoredMintExecutor.sol`): transient-storage batch execution,
  EIP-712 per-wallet signatures, up to 25 wallets sponsored atomically. Requires deploying and
  auditing a custom contract that transiently holds native value and NFTs — a materially bigger
  security surface than GhostMint's current model, which deliberately sticks to an audited
  registry of common mint shapes with no custom contract deployment (`ROADMAP.md`). Powerful, but
  a scope change, not a borrow.
- **SIWE-authenticated OpenSea GraphQL access** for per-wallet WL/FCFS eligibility checks against
  OpenSea's private API: `osnm-z-main/src/opensea.rs` pins a `CAPTURE_REVISION` constant to one
  specific OpenSea frontend deployment, meaning it silently breaks whenever OpenSea redeploys their
  site — a fragility their own source acknowledges. GhostMint's current OpenSea usage (public
  `/collections/{slug}`, `/stats`) is far more stable; leave this alone unless per-wallet
  WL-eligibility checking becomes an actual product ask.

---

# Round 2 — additional requirements (current backlog)

## Section L — Custom "X amount" input everywhere ✅

Round 1 added fixed quick-pick buttons (send: Max/75/50/25; mint quantity: 1/2/5/max). What was
missing was an explicit **`X` / custom** button on those same keyboards that switches to manual
entry, rather than relying on the user knowing they can just type a number.

- Typing a raw number already worked on both steps before this — the free-text branches in
  `server.js`'s message handler for `mint_guided`'s `awaiting_quantity` and `send_guided`'s
  `awaiting_amount` were already live. This was purely a discoverability gap, closed by adding an
  "✏️ Enter manually" button to each keyboard (`quantityStepPayload` and the send-amount step),
  mirroring the identical pattern Round 1's `flow:pricemanual` already used for the price step.
  Tapping it edits the panel to a cancel-only prompt without changing flow state, so the very next
  text message the user sends is handled exactly as it already was.
- New callbacks `flow:mintqty:x` / `flow:sendamount:x` are covered by the existing
  `FLOW_CONTINUATION_PREFIXES` allowlist prefixes (`flow:mintqty:`, `flow:sendamount:`) with no
  changes needed there.
- Scoped to what actually exists today: Telegram's mint-quantity and send-amount quick-picks.
  Scheduled-mint quantity and sniper caps don't have quick-pick keyboards yet (Section R is still
  ❌), and Discord has no quick-pick buttons to extend (Section I's Max/75/50/25 was Telegram-only;
  Discord's quantity prompt was already free-text). Extend this when either lands.
- Verified: `npm run check`, `npm run lint`, and the telegram-focused unit suites
  (`telegramFlowState`, `telegramMenus`, `telegramPanelState`, `telegramBot`, 40 tests) all pass.
  No existing test asserted on these keyboards' exact shape, so none needed updating — consistent
  with `flow:pricemanual` having no dedicated test either.

## Section M — Automatic contract detection → one-shot mint popup ✅ (Telegram)

Round 1 got partway: pasting a bare `0x…` address with no command auto-detected the contract and
showed a details screen, on Telegram and Discord, with its own separate "▶️ Continue" tap before
anything else happened.

- **What shipped:** `mint_guided` (Telegram) no longer renders a standalone "here's the contract,
  tap Continue" screen. `startMintFlow` now resolves straight through to whichever screen is
  actually the flow's first actionable one — quantity buttons (Section L, if `maxPerWallet > 1`),
  wallet picker (multiple wallets or `/batch`), the OpenSea-price-accept step (price unknown), or
  the Yes/No confirm screen directly — with the contract details prepended to it
  (`telegramMenus.contractDetailsText`, extracted from the old `contractDetails()` so both the
  merged first screen and task_guided's unchanged details-then-Continue screen share one
  source of truth for that text).
  - *One wallet, no quantity choice, known price* (the common case): paste → one merged
    details+confirm popup → tap Yes → done. **Actually zero intermediate taps**, better than the
    two-screen shape originally sketched here.
  - *One wallet, quantity choice needed*: paste → merged details+quantity popup → tap a quantity
    (or Section L's "✏️ Enter manually") → confirm screen → tap Yes → done.
  - *Multiple wallets / `/batch`*: paste → merged details+(quantity, if applicable) popup → select
    wallet(s) → confirm → done, exactly the shape this section originally called for.
  - Implementation: `advanceFromDetails`/`advanceFromQuantity`/`advanceFromWalletSelection` gained
    an optional trailing `withDetailsHeader` parameter (default `false`) threaded only through the
    single initial call chain `startMintFlow` makes — every button-tap-driven call to these same
    functions omits it, so the header can only ever appear on the flow's actual first render. It's
    a plain call parameter, never flow-state data, specifically so it can't leak into a later
    screen by accident.
- **Multi-wallet behavior (decided, and now implemented as decided):** select-wallet prompt first,
  then the confirmation after it.
- **Section N dependency:** resolved — N shipped first, so this was never at risk of building on
  top of the panel-position bug.
- **Scope decision — Discord not included.** Discord's bare-address detector
  (`discordBot.js`'s `messageCreate` listener) is still read-only (shows details, no flow to
  collapse); Discord's `/mint` is a single-shot slash command with `contract`/`wallet`/`quantity`/
  `price`/`chain` as direct options, not a multi-step guided flow the way Telegram's is — there is
  no "up to five taps" sequence on Discord to collapse. Nothing here needed to change on Discord
  for Section M; see Section Q below for what Discord *did* gain from this pass.
- Verified: `npm run check`, `npm run lint`, and 107 tests across the telegram/discord/openSea/
  botCommandService suites all pass, including a new `contractDetailsText`-vs-`contractDetails`
  parity test. No live-bot manual click-through (would need a real Telegram/Discord session) —
  flagged here rather than claimed.

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

## Section Q — Accept OpenSea collection links ✅

Accept `opensea.io` collection URLs anywhere a contract address is accepted, resolve the URL to
its collection/contract, then continue into the normal contract/mint workflow.

- **Resolution:** `openSeaService.resolveCollectionContract(slug, supportedChains)` calls the same
  `/collections/{slug}` endpoint `fetchCollectionDetails` already used for metadata, but reads its
  `contracts: [{address, chain}]` field (never needed before now) and returns the first entry
  whose OpenSea chain identifier maps back to a chain this app actually supports — a genuinely new
  lookup direction (slug → contract), not new integration surface, matching what this note
  originally expected.
- **Parsing:** `parseOpenSeaCollectionSlug(input)` accepts `https://opensea.io/collection/<slug>`
  or the `www.` host, requires `https:`, and validates the slug's charset/length (mirroring
  `validate_slug` in the OSNM-Z reference reviewed for Section T-Z) before it ever reaches a URL
  path segment. Both this and `resolveMintContractInput` (address passthrough, or link → resolved
  address, returning `null` for anything else exactly like an invalid address always did) live in
  `botCommandService.js` — shared there rather than duplicated per platform, since both Telegram's
  `server.js` and Discord's `discordBot.js` needed the identical logic.
- **Wired into every entry point that used to check an address directly:** Telegram's
  `startMintFlow` (`/mint`, `/mintnow`, `/batch`, the guided flow's contract-input step, and the
  bare-paste detector), `startTaskScheduleFlow` (`/schedule` and its guided contract-input step),
  and Discord's bare-content `messageCreate` detector. A pasted link now behaves identically to a
  pasted contract at every one of these, per this section's own "same entry points as Section M"
  goal.
- **Scope decision — Discord's `/mint`/`/batch-mint` slash-command `contract` option not
  included.** That option still requires a raw address; only Discord's read-only bare-content
  detector gained link support. The slash command takes contract/wallet/quantity/price/chain as
  one direct value-bearing call with no intermediate detection step to hook a resolution into
  without changing that command's shape — a larger, separate decision than "accept a link
  wherever an address already works."
- That read-only detector also has no step-by-step wallet/quantity picking to hand off to once a
  contract resolves — **Section AA** (Round 4, below) is the tracked follow-up to build that.
- ✅ The OpenSea-key blocker noted here previously is resolved (see Section G + K) — production
  has a working `OPENSEA_API_KEY`, so this isn't shipping degraded.
- Verified: `npm run check`, `npm run lint`, and 26 new/updated tests across
  `openSeaService.test.js` (`resolveCollectionContract`: picks a supported chain, returns `null`
  for an unsupported one / no key / a network failure or malformed response) and
  `botCommandService.test.js` (`parseOpenSeaCollectionSlug` accept/reject cases,
  `resolveMintContractInput` passthrough/resolve/unresolvable/no-service-configured), plus the
  full existing suite (107 tests total) still passing.

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
- Migration `038_mode_advanced_access_and_default.sql`: the admin Presets editor was still showing
  the raw `display_name` ("Ultra Fast" etc.) since it rendered the DB value directly with no
  relabeling — now fixed at the source. Normie (`safe`) is now a real seeded default
  (`mode_presets.is_default`), resolved in `getEffectiveGovernance` for both display and actual
  policy enforcement, instead of unset users silently falling back to unrelated chain defaults.
  Degen and Fast now require `seat_groups.advanced_modes_allowed` or a per-user
  `user_governance.advanced_modes_allowed` grant — previously any user could select Degen with no
  gating at all.

## Section D — Gas per-chain ✅

Telegram's `/gas` takes a chain argument and the Gas button renders a real chain switcher.
`ETHERSCAN_API_KEY` set; live data on all 6 configured chains.

## Section F — Batch wallet import ✅

Owner-only, on dashboard and Discord, reusing `persistWallet` per key with per-key success/failure
reporting. Skipped on Telegram deliberately (pasting raw private keys into Telegram is a worse
security posture).

## Section G + K — OpenSea price fallback, accept-price, quantity ✅

- `OPENSEA_API_KEY` set via OpenSea's public self-service free-tier endpoint
  (`POST /api/v2/auth/keys`, no login). `npm run opensea:refresh-key` re-requests and rewrites it
  into `.env` when it lapses.
- Unreadable contract price → OpenSea floor offered as one-tap accept, free-text fallback either
  way, on both `/mint` and `/schedule`.
- `maxPerWallet > 1` now prompts for quantity instead of hardcoding 1.
- ✅ **Key status resolved (2026-08-17).** Two earlier notes here turned out to both be wrong in
  sequence: first that the key was "set, expires 2026-08-23" (it wasn't deployed anywhere),
  then that it was "genuinely gone" (it was actually valid, just missing from Railway). The real
  gap was that `OPENSEA_API_KEY` had never been added to Railway's production environment
  variables — `.env` is git-ignored and never deploys, so a locally-refreshed key doesn't reach
  production on its own. Fixed: the key now matching local `.env` is set on Railway's
  `GhostMint-Bot-2` production service, and the current production boot log (deployment
  `f995edd7`, 2026-08-17T05:58:44Z) confirms `"openSeaConfigured":true`. Value intentionally not
  repeated in this doc — this repo is public; see local `.env` (expires 2026-08-23,
  `npm run opensea:refresh-key` renews it — that script hit OpenSea's own key-creation rate limit
  while investigating this and needed a ~87 min cooldown, unrelated to the key's validity). Since
  Railway vars are separate from local `.env`, every future refresh still needs a manual copy into
  Railway unless that gets automated.
- **Deferred follow-on: P&L OpenSea sales-detection (auto-fill the "sale" side).** Every confirmed
  mint auto-creates its own `pnl_records` row with real cost + gas (`recordMintActivity`/
  `autoRecordPnl` in `src/server.js`), but `sale` is always left at 0 — there is still no data
  source that knows when/for-how-much a minted NFT actually resold. Three concrete blockers before
  picking this up:
  1. **No token ID is captured from a mint receipt today.** `transactionEngine.js`'s `inspectChain`
     only reads `gasUsed`/`gasPrice`/`blockNumber` — it never parses `receipt.logs` for the
     ERC-721 `Transfer(address,address,uint256)` mint event, so there's no
     `(chain, contractAddress, tokenId)` triple recorded per mint to later ask OpenSea "did this
     specific token sell?". Needed first: parse that event, add `token_id`/`contract_address`
     columns (`activity` has neither today), and a new per-minted-token tracking table
     (`last_sale_checked_at`/`sold_at`/`sale_price_wei`, linked back to its `pnl_records` row).
  2. **`openSeaService.js` has never called a per-token endpoint** — only collection-level
     floor-price/metadata (`/api/v2/collections/{slug}` and `/stats`). A sales watcher needs
     OpenSea's per-NFT events endpoint instead, with zero prior usage here to pattern-match
     against — confirm its real response shape with a live call before writing a parser from
     memory of the docs.
  3. **Blocked on the API key itself** — see the correction above.
  - Worker skeleton to reuse once unblocked: `src/social/socialWatchWorker.js`'s shape
    (`setInterval` + re-entrancy guard + `health()` + swallow-and-log failures), mirroring
    `contract_value_cache`'s "NULL value + non-null `resolved_at` = attempted-but-empty, no row =
    never attempted" caching convention so a per-token poll loop doesn't hammer OpenSea's
    free-tier ~600 req/h budget it already shares with floor-price lookups.

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

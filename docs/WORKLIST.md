# GhostMint Feature Worklist

Tracks the backlog of user-facing feature work (mint reliability, transaction modes, sniper, gas,
wallet import, OpenSea pricing, send/deposit UX, Telegram formatting). Separate from
[`ROADMAP.md`](../ROADMAP.md), which covers the numbered platform/safety milestones (1–16, all
shipped).

- **Round 1** (Sections A–K) was scoped and implemented on 2026-08-16; 9 of 11 sections shipped in
  commit `423c7c1`. Kept below as the record of what exists.
- **Round 2** (Sections L–S) is the newer batch of requirements; L, M, N, and Q have shipped,
  O/P/R/S remain open.
- **Round 3** (Sections T–Z) is candidate work sourced from studying an external reference project,
  not yet scoped or estimated.
- **Round 4** (Section AA) is a follow-up requirement raised while shipping Round 2's Section Q;
  shipped 2026-08-17.
- **Round 5** (Section AB) is a guided watch-rule create/manage flow on both platforms, requested
  directly rather than surfacing from earlier work; shipped 2026-08-17.
- **Round 6** (Section AC) differentiates SeaDrop's own revert reasons into plain English instead
  of one generic "would revert" message; shipped 2026-08-17.
- **Round 7** (Section AD) is a degen-bot-style refreshable collection info card, both platforms —
  logged 2026-08-17; splits into a cheap tier and a research-first tier, see below. Tier 1 shipped
  2026-08-17; Tier 2 remains research-only, nothing built.
- **Round 8** (Section AE) adds a gas-tolerance step to Telegram's guided `/batch` flow, requested
  directly alongside three other items (FCFS/GTD phase scheduling, a simulation-before-execution
  question, and repo-privacy); shipped 2026-08-17. The other three were answered without code —
  see the note at the end of this section.
- **Round 9** (Section AF) is phase-aware scheduled mints — logged 2026-08-17. Shape 1 (manual
  multi-phase scheduling on Telegram) shipped 2026-08-18, together with the scheduled-mint
  confirmation copy fix flagged in the same section; shape 2 (allowlist phases via a hand-entered
  merkle proof) remains deliberately unbuilt.

Status legend: ✅ Done · 🟡 Partial · ❌ Not started

---

# Round 9 — phase-aware scheduled mints (2026-08-17)

## Section AF — Scheduling a mint against a specific phase, not just a fixed clock time 🟡

Raised 2026-08-17 alongside a copy-accuracy bug in the same area (see below). **Shape 1 shipped
2026-08-18; shape 2 remains deliberately unbuilt.**

**The actual request:** "schedule mint" is not a reminder/alarm — it means the bot should *carry
out* a mint automatically once a given time (or, ideally, a given drop *phase*) arrives. The
existing `/schedule` flow already does this for a fixed clock time (`src/scheduler/` fires the
real mint at `mintTime`, not a notification). What's missing is scheduling against a *phase*
(e.g. "the FCFS phase" or "the GTD phase") rather than a time the user has to already know and
type in by hand.

**Phase determinability — re-checked 2026-08-17, unchanged from Round 8's research:**
- **Allowlist-gated phases (true GTD/FCFS) still aren't determinable.** They need a per-wallet
  merkle proof, which comes from the project's own mint site/API, not from anything on-chain or
  any generic third-party service. No standardized source exists across projects. This app also
  still only ever constructs `mintPublic()` calls — it doesn't build `mintAllowList`/`mintSigned`
  calldata at all yet, a separate, currently-unbuilt capability (same finding as Round 8's Tier 2
  "Insiders" research: reading someone else's differently-shaped mint tx needs those signatures).
- **Public-only phases aren't pre-declared anywhere either.** SeaDrop's `PublicDrop` (the struct
  this app already reads for price/timing/limits) is a *single mutable* struct the project updates
  live when each phase begins — not a stored schedule of upcoming phases. There's nothing on-chain
  to poll ahead of time that says "phase 2 starts at X with price Y."
- **Net effect:** nothing here is a data-fetching problem this app can solve by calling a
  different API — the phase schedule genuinely only exists off-chain, in the project's own
  announcements (Discord/website/socials).

**Two workaround shapes worth scoping, not mutually exclusive:**
1. **Manual multi-phase scheduling (buildable now, zero new capability):** ✅ **shipped
   2026-08-18** — let a user create *several* `/schedule` tasks against the same contract, each
   with its own manually-entered time/price taken from the project's own announcement — one task
   per known phase. `/schedule` already accepted manual price/time when the contract doesn't
   expose them, so this turned out to be exactly the predicted UX/copy question rather than new
   engineering. See "What shape 1 actually shipped" below.
2. **Allowlist-phase support via manual proof entry:** ❌ still not started, deliberately — extend the guided schedule flow to
   optionally accept a merkle proof (mirroring `/mintcall`'s existing manual-proof capability) so
   an allowlist-stage mint can be scheduled at all, even without automatic discovery. Bigger lift:
   needs `mintAllowList`/`mintSigned` calldata construction added to `src/mint/mintCall.js` (or
   wherever SeaDrop calls are built), a new schedule-flow step for proof entry on both platforms,
   and probably a "which phase is this for" label since the same contract could have several
   scheduled tasks running against different phases in parallel.

Recommend scoping shape 1 first (cheap, immediately useful, no new mint-construction capability)
and treating shape 2 as a distinct, larger follow-up if the manual-proof workflow turns out to be
something users actually want, rather than building it speculatively. *That recommendation was
followed: shape 1 shipped, shape 2 is still unbuilt and should stay that way until asked for.*

### What shape 1 actually shipped (2026-08-18) ✅

**Scope: Telegram's guided `/schedule` only** — the same reasoning Section AE recorded for
`/batch`. Discord's `/task create` takes one raw JSON `input` string with every parameter
supplied up front and never enters a guided step machine, so there is no "next step" moment to put
an add-a-phase button into; issuing `/task create` several times is already one task per phase
there. Nothing on the Discord side needed touching. (Section S — a guided Discord task-schedule
flow — stays open and is where this would land if it's ever wanted there.)

- **The success screen became the feature.** Creating a task used to end on a dead-end
  "✅ Scheduled X for <time>" line. It now renders `telegramMenus.taskScheduled`, which offers
  **"➕ Add phase N"** as the primary next tap, plus See all tasks / Back to base. Tapping it
  re-enters the guided flow against the same contract with the phase counter incremented, so
  staging a three-stage drop is contract-paste → phase 1 → tap → phase 2 → tap → phase 3.
- **The add-phase button is stateless.** Its callback data is `flow:phase:<n>:<address>`, so it
  keeps working on a success screen that's still on screen after a bot restart (guided flow state
  is deliberately in-memory only — see `src/telegram/flowState.js`'s own note). 55 bytes for a
  40-hex address, comfortably inside Telegram's 64-byte `callback_data` limit; a test pins that.
- **A later phase never inherits the live stage's numbers.** This is the correctness core of the
  change. `startTaskScheduleFlow` re-detects the contract for phase 2+, but everything detection
  reports about price and opening time describes whichever stage is live *right now* — so the
  detected `priceETH` is demoted to a `suggestedPriceETH` one-tap suggestion, `mintTime` is
  cleared so the flow always asks, and the details screen is skipped (the user saw it moments ago
  on the way to phase 1). Without this, phase 2 would silently inherit phase 1's price and fire at
  phase 1's time.
- **Phase-aware copy at every step it matters:** the price step asks what *phase N* costs and says
  plainly that the chain only knows the live stage; the name step explains the name is how you'll
  tell stages apart in `/tasks` and suggests `Phase N public`; the time step says a stage isn't
  announced on-chain before it goes live, so the time comes off the project's own post; and the
  confirm screen is headed "Confirm phase N" and labels the price "your number for this phase"
  rather than claiming the contract exposed it.
- **`/tasks` now shows each task's contract.** Staging several phases of one drop is a normal
  thing to do as of this change, and one user can stage two drops at once — the name alone stopped
  being enough to tell rows apart.
- **Not silently replacing a live flow:** `flow:phase:` is deliberately *not* in
  `FLOW_CONTINUATION_PREFIXES.task_guided`, so tapping "add phase N" on an older success screen
  while some other guided flow is mid-air raises the usual abandon-this-flow prompt instead of
  quietly discarding it.
- **Still true, and worth restating:** none of this makes phases *discoverable*. The bot cannot
  tell you when phase 2 opens or what it costs — the user reads that off the project's
  announcement and types it in. What shipped is the ability to pre-arm every stage once you know
  them, which is the whole of what was buildable without the merkle-proof capability shape 2
  describes.

## Also flagged: "Confirm Scheduled Mint" copy reads like a reminder, not an execution ✅

From the same 2026-08-17 message, and from the then-in-flight Telegram copy-tone pass —
`taskConfirmation`'s Telegram text ended with "Set the alarm?", which undersells what actually
happens: the bot doesn't just remind the user, it submits a real transaction unattended at the
scheduled time.

**Fixed 2026-08-18**, with Section AF's shape 1. The tone pass (commit `1029c5d`) shipped without
touching this line, so it was picked up here — same screen, same session, and leaving a known
inaccuracy on the one screen this round was rebuilding made no sense. The confirmation now reads
"This is not a reminder — the bot signs and sends the mint itself at that moment, phone in your
pocket, you asleep." and ends on "Lock it in?" — the shape suggested above: still on-brand, no
longer describing an alarm clock. A test pins both halves (the claim is present, the word "alarm"
is gone) so a future copy pass can't quietly reintroduce it.

---

# Round 8 — /batch gas-tolerance step (2026-08-17)

## Section AE — Per-batch gas tolerance for the guided /batch flow ✅

Requested as one of four items in the same message: "batch mint should follow the telegram flow
(/batch -> contract -> select wallets -> gas tolerance -> mint)". Scoped via three follow-up
questions before building (see the answers baked into the design below), then shipped the same
session.

- **Scope: Telegram's guided `/batch` only**, confirmed explicitly. Discord's `/batch` is a
  one-shot slash command with every parameter supplied up front
  (`/batch wallets contract quantity price chain`) — it never goes through the shared
  `mintFlowDecision` step machine at all, so there's no guided-flow moment to insert a step into.
  Discord's paste-triggered guided flow (`startMintGuidedFlow`) also hardcodes `multi:false`, so it
  can never reach this step either way — nothing there needed touching.
- **What it is:** a new `awaiting_gastolerance` step in `mintFlowDecision.js`'s shared decision
  core, reached only when `data.multi` is true, inserted right after the price is settled and
  right before confirm. A single `/mint` is completely unaffected — `afterPriceKnown` skips
  straight past it exactly as before this step existed.
- **What it does:** lets the user cap what *this specific batch* is willing to pay in gas, on top
  of (never above) the account's existing governance `gasCeilingGwei` — shown for context on the
  same screen so the user isn't picking blind. Two choices, mirroring the existing price step's
  accept/manual shape: "✅ No extra limit" (relies on the governance ceiling alone, i.e. unchanged
  behavior) or "✏️ Set a gwei limit" (typed value). The chosen `maxGasGwei` rides along in flow
  data and shows on the confirm screen, then reaches `transactionEngine.submit` as an independent
  check alongside (not instead of) the existing ceiling check — enforced even for a
  `ceilingExempt` (owner) account, since it's the caller's own choice for this batch, not something
  governance grants an exemption from. A new `GAS_TOLERANCE_EXCEEDED` error keeps the message
  distinct from a governance-ceiling rejection.
- **Known limitation, not fixed by this change:** `botCommandService.batchMint`'s wallet loop
  aborts the whole batch on the first wallet that throws (gas-tolerance or otherwise), rather than
  skipping just that wallet and continuing — a pre-existing behavior for any per-wallet failure,
  not something this feature introduced. Setting a tight tolerance makes hitting it more likely,
  so it's worth knowing about, but redesigning batch error-resilience was out of the scope that was
  confirmed for this pass.
- **The other three items from the same message, answered without code:**
  - *Simulation before execution* — already true. `transactionEngine.submit` calls
    `simulateCallSafely` whenever `policy.simulationEnabled` (the default), before broadcast, for
    every mint including each wallet in a batch.
  - *FCFS/GTD phase-based scheduling* — scoped to "public-stage only for now": multiple
    independently-timed **public** mint stages need no new code at all, just separate `/schedule`
    tasks per known public time. True allowlist-gated GTD/FCFS phases need a merkle proof per
    wallet per stage that this app doesn't fetch today and has no generic/standard source for
    (project-specific) — deliberately deferred rather than built partially.
  - *Repo collaborator-only access* — the repo was public; switched to private
    (`gh repo edit --visibility private`) on explicit confirmation.

---

# Round 7 — degen-style collection info card, both platforms (2026-08-17)

## Section AD — Refreshable collection info card with market/holder/risk data, both platforms 🟡

Reference: a screenshot of a Discord bot ("Lute Synapse") posting a rich embed for a pasted token
— contract address in a copyable block, socials, **Market Cap / ATH / Volume**, a **Top Holders**
breakdown (per-wallet % with medal emoji for the largest few), a risk-scoring block ("Lute
Shield": **Dev Hold %**, **Bundlers %**, **Insiders %**, **Snipers %**, each flagged
✅/⚠️), and action buttons (Send, Call, 🔄 Refresh, Copy CA, plus one more). Wanted: the same shape
for NFT **collections** instead of tokens, on both Telegram and Discord.

This splits cleanly into two tiers by how much is actually known right now vs. how much needs
research before it can even be scoped:

### Tier 1 — buildable from data this app already has or already fetches ✅

Shipped 2026-08-17. Market cap uses `maxSupply` (not current minted count) once known, falling
back to minted count alone when `maxSupply` is unset — floor price × supply, computed in
`botCommandService.js`'s `detectMintContract` behind a new opt-in `includeStats` flag so every
other caller (task scheduling, batch mint, plain slash-command lookups) is unaffected and pays no
extra latency. Implementation:

- `openSeaService.js` gained `getCollectionStats(chain, contractAddress)` — live, never cached
  (unlike the existing metadata/price cache), reading `total.volume`/`total.sales`/
  `total.num_owners`/`total.floor_price` plus the `intervals[]` one/seven/thirty-day breakdown from
  `GET /collections/{slug}/stats`, exactly the endpoint identified during Tier 2's research pass.
- `contractValueResolver.js` gained `probeTotalMinted(chain, contractAddress)` — a live,
  **uncached** read of just `totalMinted`, added after discovering that the shared
  `contract_value_cache` row (one row per chain+contract, columns for price/supply/SeaDrop/OpenSea
  fields all sharing it) makes `resolve()`'s normal cache check return truthy — and skip probing —
  the moment *any* prior save touched that row, even one that never actually probed
  `totalMinted` itself. Market cap needs a real current count, so this bypasses the cache
  entirely rather than risk a stale or never-fetched value.
- Holder count shows as `total.num_owners` next to the floor price line, labeled plainly as a
  holder count — not represented as the screenshot's per-wallet Top Holders % breakdown, which
  still needs Tier 2's Alchemy integration.
- The card itself: `collectionInfoCard()` in both `src/telegram/menus.js` and
  `src/discord/menus.js`, shown as `mint_guided`'s real first screen (`awaiting_details`) on both
  platforms, superseding the older Section M/AA behavior of folding contract details into
  whatever the next step happened to be. Actions: **🪙 Mint Now** (advances the flow via the
  shared `mintFlowDecision.afterDetails` core, same as before), **🔄 Refresh** (re-runs
  `detectMintContract` with `includeStats:true` and re-renders in place), **📋 Copy CA** (a
  standalone ephemeral/plain echo that never touches flow state), **🔗 View on OpenSea** (a link
  button, omitted when the chain isn't in `OPENSEA_CHAIN_SLUGS`), **❌ Cancel**. Every
  stats-derived line (floor, market cap, volume) is simply omitted rather than shown as a
  placeholder when unavailable, matching the existing "unknown is fine" convention the plain
  contract-details text already used.
- Two bugs surfaced and fixed while wiring this up (both from real user reports, not found by
  chance): `OPENSEA_CHAIN_SLUGS` was missing a `robinhood` entry despite Robinhood Chain being one
  of the app's `supportedChains` — this silently broke OpenSea-link resolution *and* degraded
  collection metadata/stats for every Robinhood collection (confirmed live against a real
  Robinhood Chain collection, "FISH IT"). And `transactionEngine.js`'s `explainCallFailure` was
  parroting ethers' cryptic `require(false)` text verbatim for any zero-data revert, which is
  ambiguous (could be a real bare `require()`, or the contract simply not implementing the
  function called) — now explains both possibilities in plain English instead.

### Tier 2 — research complete (2026-08-17); real findings below, nothing built yet ❌

- **ATH (all-time-high floor price): no data source exists anywhere, confirmed.** OpenSea's stats
  endpoint has no ATH field, only current `floor_price` (checked above). Alchemy's `getFloorPrice`
  is confirmed current-only too (5–15 min cache, no history). The only path is this app starting
  to persist its own floor-price snapshots over time (the current `contractValueRepository` cache
  is point-in-time, not a time series) — meaning any ATH this app ever shows would only cover
  "highest since GhostMint started tracking it," not a collection's real all-time high, unless a
  specialized paid NFT-analytics dashboard with real historical data turns out to have an
  affordable API (not checked — a distinct, separate research task if this matters enough to
  pursue).
- **Top Holders % breakdown: no via OpenSea, yes via Alchemy (confirmed).** OpenSea's per-asset/
  ownership endpoints (`/chain/{chain}/contract/{address}/nfts`) live-tested with this app's real
  key and returned `401 Invalid API key` — confirmed gated behind a higher tier than the free
  self-issued key `openSeaService.js` uses, unlike the collection-metadata/stats endpoints already
  in use. **Alchemy's NFT API `getOwnersForContract` does exactly this** (owner address + token
  balance per owner, i.e. exactly what's needed to compute top-N holder %) — confirmed via current
  docs, with a real free tier (100k requests/month, 1000 req/min) as of this check. This is a new
  vendor integration (one new free Alchemy account/key) but a concretely available one, not a dead
  end.
- **"Shield"-style risk scoring (Dev Hold / Bundlers / Insiders / Snipers %): no vendor exists for
  NFTs — confirmed, this is a token/DEX-launch concept, not an NFT one.** Searched specifically;
  every platform that offers this exact scoring (Trojan, Photon, BullX, GMGN, BonkBot — the same
  category the screenshot's "Lute" bot belongs to) does it for Solana/EVM **token** launches
  against AMM liquidity-pool creation, not NFT mints. Nothing surfaced offering it for NFT
  collections. **But the raw on-chain data to build a scoped version in-house is already
  reachable with infrastructure this app has today, live-verified**: this app's existing
  `ETHERSCAN_API_KEY` (already used for gas — `src/gas/etherscanGasService.js`) can pull raw
  `Transfer` event logs (`module=logs&action=getLogs`) for any contract on every Etherscan V2
  chain this app supports — tested live against a real contract just now, returned real log data
  including block timestamp and transaction hash. That reframes the four metrics into very
  different difficulty levels, not one uniform "hard" bucket:
  - **Dev Hold — cheap.** Current balance of the deployer/team wallet (found via the contract's
    creator, itself an Etherscan API lookup) is a single `balanceOf` call.
  - **Snipers — cheap.** Mint-event block timestamps (already in the log data above) compared
    against the drop's own known `startTime` (SeaDrop's `PublicDrop.startTime`, which this app
    already reads) directly identifies wallets that minted within N seconds/blocks of opening —
    no new data source needed at all.
  - **Bundlers — cheap, if defined strictly as "same transaction."** Grouping the same mint-event
    logs by `transactionHash` directly shows multiple recipients minted in one transaction — no
    additional lookups. (A looser "same funding wallet across several separate transactions"
    definition, closer to what token scanners actually mean by "bundler," is the expensive
    version below.)
  - **Insiders — the genuinely expensive one.** Either tracing each top-holder wallet's own
    funding transaction backward (who sent it its first ETH, and when, relative to the deployer) —
    roughly one extra lookup per wallet checked, scaling with how many wallets get analyzed — or
    decoding *other* minters' calldata to tell a private/allowlist-stage mint from a public one,
    which needs this app to also know SeaDrop's `mintAllowList`/`mintSigned` signatures (it
    currently only constructs `mintPublic` calls; reading someone else's differently-shaped mint
    tx is a different, currently-unbuilt capability).
- **Net finding:** a scoped version of this section — Dev Hold + Sniper % + strict same-tx
  Bundler %, using only the Etherscan key this app already has — is realistically buildable without
  any new vendor account. Real Top Holders % needs one new (free) Alchemy account. True ATH and
  the funding-trail definition of Insiders remain the two genuinely open-ended pieces.

**Tier 1 shipped, Tier 2 not started.** Recommend a scoped Tier 2 pass covering
Dev Hold/Sniper/same-tx-Bundler (zero new accounts) and Top Holders (one new free Alchemy account)
next, leaving true ATH and funding-trail Insiders explicitly deferred rather than blocking on
them.

---

# Round 6 — differentiated SeaDrop revert reasons (2026-08-17)

## Section AC — Decode SeaDrop's own revert reasons into plain English instead of one generic message ✅

Asked directly: a SeaDrop mint failing because the stage hasn't opened, because supply is
exhausted, or because the wrong price was sent all produced the same generic
`"Simulating this call failed -- the contract may not implement this function, or the call would
revert."` from `transactionEngine.js`'s `explainCallFailure`. Root cause (confirmed by reading the
installed ethers package's own source, `AbiCoder.getBuiltinCallException`): a bare `provider.call()`
with no `Contract`/`Interface` attached — which is all this engine ever does — never auto-decodes a
custom Solidity error. Ethers can only decode `Error(string)`/`Panic(uint256)` reverts on its own;
for anything else it just hands back the raw revert bytes (`error.data`) and a generic
`"execution reverted (unknown custom error)"` message. Modern contracts, including SeaDrop, use
custom errors almost exclusively, so this generic path was the common case, not an edge case.

- **`src/mint/seaDropErrors.js`** (new): a real `ethers.Interface` built from SeaDrop's actual
  custom-error definitions, fetched directly from
  [`ProjectOpenSea/seadrop`'s `src/lib/SeaDropErrorsAndEvents.sol`](https://github.com/ProjectOpenSea/seadrop/blob/main/src/lib/SeaDropErrorsAndEvents.sol)
  (MIT licensed) via `gh api` rather than assumed from memory — the same discipline
  `seaDropRegistry.js` already applies to the mint function signature itself, and the same lesson
  this file's own Section T–Z notes called out about OSNM-Z's OpenSea integration ("do not write
  the parser from memory of the docs alone"). Limited to the 7 errors actually reachable through
  `mintPublic()` (`NotActive`, `MintQuantityCannotBeZero`,
  `MintQuantityExceedsMaxMintedPerWallet`, `MintQuantityExceedsMaxSupply`,
  `MintQuantityExceedsMaxTokenSupplyForStage`, `FeeRecipientNotAllowed`, `IncorrectPayment`) —
  SeaDrop also defines allowlist/signed-mint/admin-configuration errors this app's mint call can
  never trigger, since it only ever calls `mintPublic` (no allowlist proof, no signature).
  `describeSeaDropError(data)` decodes the raw revert bytes against that interface and returns a
  specific plain-English sentence per error (e.g. `NotActive` distinguishes "hasn't opened yet"
  from "already closed" using the contract's own reported timestamps; `IncorrectPayment` reports
  both amounts in ETH, not raw wei), or `null` for anything that doesn't match — purely
  selector-based, so trying it against a non-SeaDrop failure is harmless.
- **Wired into `explainCallFailure`** as the first thing tried, before the existing
  `reason`/`shortMessage`/`message` fallback chain (which still handles plain `mint(uint256)`
  contracts using old-style `require(condition, "string")` reverts correctly on its own).
- **What this doesn't cover:** a non-SeaDrop contract's own custom errors (no known ABI to decode
  against — falls through to the existing generic message, honestly, rather than guessing), and
  the "wallet not eligible" framing from the original ask doesn't map cleanly onto `mintPublic`
  specifically — public mint has no allowlist by definition (that's a separate SeaDrop function,
  `mintAllowList`, this app doesn't call). The closest real `mintPublic` equivalent is `NotActive`
  (stage timing). Genuine on-chain eligibility checks are already handled separately and already
  had a specific message before this section — see the M8 mint preset `allowlistCheck` feature
  (`src/mint/allowlistCheckRegistry.js`), which independently produces `"wallet is not eligible for
  this mint"` before a transaction is even built.
- Verified: `npm run check`, `npm run lint`, and 8 new tests. `tests/seaDropErrors.test.js` (7
  tests) round-trips every error through the same `Interface`'s real `encodeErrorResult` rather
  than hand-typed hex, proving the decode genuinely works rather than just that the code compiles.
  `tests/transactionEngine.test.js` gained one true end-to-end case: a mocked `provider.call()`
  failure shaped exactly like a real ethers `CALL_EXCEPTION` (verified against the installed
  package's own source) reaches `engine.submit()`'s rejection with the fully decoded plain-English
  message, not the generic one.

---

# Round 5 — guided watch-rule flow, both platforms (2026-08-17)

## Section AB — Guided social watch-rule create + manage flow on Telegram and Discord ✅

Both platforms' `menu:watch` were plain placeholders pointing at `/watch add|edit|disable|remove|
list`, which requires typing raw JSON to create a rule (`{"type":"twitter_account","method":
"official_api","config":{"handle":"..."}}`) and knowing a rule's UUID to disable/remove one.
Requested directly: a real guided flow on both platforms, comparable in scope to Section AA.

- **Shared decision core** (`src/social/watchRuleFlowDecision.js`): `configFieldsForType(type)`
  maps each of the 6 watch-rule types to the config field(s) it needs (`handle` for
  `twitter_account`/`farcaster_account`, `channelId` for `discord_channel`, `keywords` for the
  three keyword types), plus a shared `CONFIG_FIELD_PROMPTS` label/hint per field the `scraper`
  method's `sourceUrl` field is appended to. Both platforms' flows call this instead of
  hand-duplicating which fields a type needs — the Section AA lesson applied up front this time
  rather than discovered after the fact.
- **Telegram** (`server.js`, new `watch_guided` flow): name (free text) → type (inline buttons) →
  method (inline buttons, with a one-line description of what each means) → config field(s) one at
  a time via `nextConfigField` (free text, reusing the same edit-in-place panel every other
  Telegram flow uses) → confirm. `menu:watch` now shows a real list (`watchRulesList`) instead of
  the placeholder; tapping a rule opens Disable/Re-enable/Remove actions
  (`watchRuleActions`/`confirmRemoveWatchRule`).
- **Discord** (`discordBot.js`, new `watch_guided` flow): same shape, Discord-idiomatic —
  name via modal, type and method via select menus, then **one combined modal** for every
  remaining config field (at most 2: the type's own field plus `sourceUrl` for `scraper`) rather
  than one modal per field. Deliberate: Discord modals can only be opened in response to a normal
  component interaction, not chained directly off another modal's submission, so collecting
  multiple fields in a single modal sidesteps that constraint entirely instead of relying on
  cross-version support for chained modals. Every step here is reached from an already-ephemeral
  message (`/menu` or `menu:watch`), exactly like wallet create/import — none of Section AA's
  public-message/ownership handling was needed, since that was specific to the mint flow's
  paste-triggered entry point.
- **Re-enable, not just disable:** `updateWatchRule(id, {enabled: true})` wired to a toggle button
  alongside Disable — the underlying patch endpoint already supported this, it just had no UI
  surface on either platform before now.
- **Explicitly out of scope, not silently dropped:** editing an existing rule's type/method/config
  after creation stays on the raw `/watch edit <id> <json>` form. Showing current values and
  routing to the right step per field is a materially different (and larger) shape than "collect
  these fields once" — list/disable/re-enable/remove covers the rest of the CRUD surface without
  it. `discord_keyword`'s optional `channelIds` restriction (watch only specific channels) also
  isn't collected by the guided flow; the rule applies to all channels unless edited by hand.
- Verified: `npm run check`, `npm run lint`, `npm run check:discord-menu`, and the full relevant
  suite (148 tests) — `tests/watchRuleFlowDecision.test.js` (5 tests, shared core) and
  `tests/discordWatchFlow.test.js` (8 tests: full create happy path per type shape, the
  single-combined-modal behavior for `scraper`, empty-field rejection, list/manage/toggle/remove,
  cancel-confirmation, and a `ValidationError` surfacing cleanly). No direct Telegram-side test —
  matches this file's existing precedent that `server.js`'s Telegram flow logic has no test harness
  today (Section L/M/Q shipped the same way); the shared decision core's own tests cover the
  branching Telegram and Discord both depend on.
- Found and fixed in passing, not part of this section's scope: Discord's `/gas` command had no
  graceful-degradation catch (unlike Telegram's), so any provider failure showed a generic
  "Command failed safely" instead of a clear per-chain message — fixed separately (`a646a0c`).
  Etherscan's gas oracle has no data for Robinhood Chain at all (confirmed live against
  `api.etherscan.io/v2/chainlist`) — a chain-RPC fallback for that was also shipped separately
  (`b0e0e5d`), not part of this feature.

---

# Round 4 — Discord guided mint flow (2026-08-17)

## Section AA — Discord guided mint flow via pasted text/link, with real wallet/quantity picking ✅

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
- **Design (revised after a second pass — the first sketch had real gaps, not just nuances):**
  1. **Shared pure decision core, not a hand-mirrored copy.** `advanceFromDetails`/
     `advanceFromQuantity`/`advanceFromWalletSelection`/`advanceFromPriceResolved` in `server.js`
     are today side-effecting (they call `tgUpdate`/`telegramFlowState.advance` directly). Extract
     the pure "given step + data, what's next" branching (skip wallet-select when there's one
     wallet, skip quantity when `maxPerWallet <= 1`, skip confirm when `skipConfirm`, etc.) into
     something both platforms' rendering layers call, so a future change to that branching can't
     silently drift between Telegram and Discord the way two independently-hand-mirrored copies
     eventually would.
  2. **Authorization and visibility, not just storage.** The bare-paste trigger fires from a plain
     channel message, and plain message replies can't be ephemeral (unlike every other Discord
     command in this bot, which is ephemeral by design) — so the flow's embed is visible
     channel-wide. The follow-up wallet/quantity/confirm buttons must therefore (a) reject any
     click from someone other than the original author and (b) reply to accepted clicks
     ephemerally, so wallet contents and the in-progress mint stay private even though the
     triggering message wasn't.
  3. **Buttons/select-menus/modals only — no free-text steps.** Telegram's flow accepts typed
     numbers at some steps and needs `isTextStep` gating plus message deletion to disambiguate
     "flow input" from "just chat." Discord doesn't need that class of problem: quantity's
     custom-amount entry (Section L's equivalent) uses a modal instead of a follow-up plain
     message, keeping every step interaction-based.
  4. **Reuse the existing cancel-confirmation divergence pattern**, not just `flowState.js`'s
     storage mechanics — the same "navigating away mid-flow prompts before discarding progress"
     behavior Milestone 15b already built and `discordFlowUX.test.js` already tests for wallet
     create/import.
  5. **Test to the higher existing bar.** Telegram's `mint_guided` state machine has essentially no
     direct unit tests today. Discord's wallet-create/import flow already has real behavioral
     coverage (`discordFlowUX.test.js`: modal submission, chain selection, cancel-confirmation,
     asserted end to end). Section AA should match that precedent, not the weaker one.
  6. **Sequencing:** build the shared decision core and Discord rendering building blocks first,
     ship this section as its own vertical, then wire Section O's `menu:mint` button and Section
     S's schedule flow on top as separate follow-ups rather than one bundled change.
- Every step still ends by calling the exact same `botCommandService` functions
  (`detectMintContract`, `resolveMintContractInput`, `mint`) the slash command and Telegram already
  use — no parallel validation or execution path, per this file's and `ROADMAP.md`'s existing rule
  for every guided step on every platform.
- **What shipped, against each of the six design points above:**
  1. `src/mint/mintFlowDecision.js` is the one shared, pure, platform-agnostic decision core
     (`afterDetails`/`afterQuantity`/`afterWalletSelection`/`afterPriceResolved`) — Telegram's
     `server.js` was refactored to call it too (not just Discord), so the branching now lives in
     exactly one place. `advanceFromDetails`/`advanceFromQuantity`/`advanceFromWalletSelection`
     collapsed into thin wrappers around it plus a new shared `applyMintFlowStep` tail.
  2. Ownership is enforced by construction, not a bolted-on check: `flowState` is already keyed to
     the *clicking* user's own Discord id, so a stranger's click on the flow's public message
     simply finds no matching flow under their id — every mint-flow component handler checks this
     and replies with an ephemeral "this isn't your mint prompt" rather than silently no-oping.
     Visibility: the owner's first interaction against the flow (`data.originMessagePublic`) fires
     `neutralizeMintOriginMessage` (strips the public message's components — best-effort, never
     blocks the real response) and switches every response from there on to an ephemeral
     `interaction.reply`; once already ephemeral, later steps just `dcRespond` (update in place)
     like any other guided flow. Confirmed: wallet labels, price, and the mint result never appear
     on the public message once the owner has engaged.
  3. No free-text steps: quantity and wallet picks are select menus (`flow:mintqty:select`,
     `flow:mintwallet:select`); price is accept/manual buttons; custom quantity and manual price
     both use modals (`flow:mintqty:submit`, `flow:mintprice:submit`). Every custom_id is fixed
     (values carry the choice, not the id), so `FLOW_CONTINUATIONS.mint_guided` needs no
     dynamic/prefix matching, unlike Telegram's callback-data scheme.
  4. The existing mid-flow divergence pattern covers `mint_guided` for free: `FLOW_LABELS` and the
     generic `activeFlow` checks in both `handleComponent` and the slash-command dispatcher already
     key off `flow.flow`, so no code changed there beyond adding `mint_guided: 'minting'` to
     `FLOW_LABELS`. A second paste while a flow is active now also asks before discarding it
     (new: `handleMintPasteMessage`'s own `existingFlow` check, mirroring the same UX).
  5. `tests/discordMintFlow.test.js` (13 tests) plus `tests/mintFlowDecision.test.js` (6 tests) —
     full happy path, one-shot zero-tap confirm (single wallet + `maxPerWallet` 1 + known price),
     quantity >1, custom quantity/price via modal, OpenSea floor accept, non-owner rejection,
     rate-limit-preserves-flow, OpenSea-link resolution, cancel-confirmation (paste-triggered and
     slash-command-triggered), and invalid-input-is-ignored. `discordFlowUX.test.js`'s 14 remained
     green throughout the refactor.
  6. Sequencing followed as planned: this shipped as its own vertical. Section O's `menu:mint`
     button and Section S's schedule flow were **not** touched — both remain open, now with
     `discordMenus.mintQuantitySelect`/`mintPriceStep`/`mintConfirmation`/`numberModal` available
     as building blocks to reuse rather than re-invent.
- **Scoped out of this pass, not silently dropped:** `/mint` with no options does not yet reach
  this flow (only the bare-paste/link trigger does) — the slash command's `contract`/`wallet`/
  `quantity` options are still all required, unchanged. `skipConfirm`/zero-tap bypass mode
  (`/mintnow`'s Telegram equivalent) is not wired here either: Telegram's own bare-paste trigger
  never bypasses confirmation, so Discord's paste trigger matches that, not `/mintnow`. `/batch`-
  equivalent (multi-wallet) paste minting is also out of scope — the trigger always starts a
  single-wallet flow (`multi: false`), matching what a bare paste already means on Telegram.
- Verified: `npm run check`, `npm run lint`, `npm run check:discord-menu`, and the full relevant
  suite (126 tests: every file above plus every previously-passing Telegram/Discord/OpenSea/
  botCommandService test, confirming the `mintFlowDecision` extraction didn't change Telegram's
  observable behavior). No live-bot manual click-through — flagged here rather than claimed, same
  as Section M.

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

## Section O — Button ⇄ command parity ⚠️ (Discord's mint/activity/gas shipped)

Every UI button must do exactly what its `/` command does, sharing the same code path rather than
a parallel implementation. Round 1 fixed two of these (Telegram's Gas and Transaction mode buttons
now act directly, calling the same `botCommands.gas()` / `selectMode()` the commands use). A
follow-up shipped three more of Discord's placeholders the same way: `menu:gas` now performs the
lookup directly (`discordMenus.gasMenu`, mirroring Telegram's `gasMenu` shape — Safe/Standard/Fast
readout plus chain-switch buttons, `gas:chain:<chain>`), `menu:activity` shows page 1 directly via
the same `botCommands.activityPage()` `/activity` uses (`discordMenus.activityMenu`, with
Prev/Next paging buttons `activity:page:<n>`), and `menu:mint` opens a modal for the one field a
mint genuinely can't avoid being free text — the contract address — then routes through the same
`startMintGuidedFlow` a bare paste and `/mint`'s under-specified path already use, rather than a
separate implementation. The rest are still placeholder screens that just tell the user to go type
a command:

| Surface | Buttons still telling the user to type a command |
|---|---|
| Telegram | `menu:snipers`, `menu:activity`, `menu:admin` |
| Discord | `menu:tasks`, `menu:snipers`, `menu:admin` |

`menu:watch` is done on both platforms — see **Section AB** below; it went well past "make the
button call the same function" into a full guided create flow plus list/manage actions, so it's
tracked as its own section rather than folded into this row.

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

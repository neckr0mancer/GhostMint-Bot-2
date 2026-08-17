# GhostMint Feature Worklist

Tracks the backlog of user-facing feature work (mint reliability, transaction modes, sniper, gas,
wallet import, OpenSea pricing, send/deposit UX, Telegram formatting). Separate from
[`ROADMAP.md`](../ROADMAP.md), which covers the numbered platform/safety milestones (1–16, all
shipped). Last updated 2026-08-16 after a full implementation pass — see "What shipped" per
section for the actual code, and "Verification" at the bottom for how it was checked.

Status legend: ✅ Done · 🟡 Partial · ❌ Not started

## Section A — Mint reliability ✅

- `/mintnow` is a real one-shot now: with a resolvable contract, one wallet, and a known price,
  it reaches execution with zero taps *when the caller's transaction mode allows bypass*
  (Section C's Degen preset). Anything genuinely unresolvable (multiple wallets, unknown price)
  is still asked for; without bypass mode it behaves like `/mint`. `startMintFlow`/
  `isVerificationBypassed` in `src/server.js`.
- Bare `0x…` addresses with no command now show contract details on both Telegram
  (`handleFlowTextMessage`) and Discord (new `messageCreate` listener in `discordBot.js`).
- Telegram message formatting migrated from broken `*asterisk*` Markdown (never had `parse_mode`
  set) to real HTML across the entire bot — every one-shot command, every guided-flow template,
  every background push notification. `escapeTelegramHtml` (`src/security/botSecurity.js`) added
  and applied to every interpolated free-text value.

## Section B — Scheduled mint parity with `/mint` ✅

- Fixed the real bug: `executeTask` (scheduler fire-time execution) used to hardcode
  `mint(uint256)` sent to the NFT contract directly, while immediate `/mint` correctly branched
  to SeaDrop's core contract when needed — a scheduled mint of a SeaDrop drop would not have
  minted correctly. Factored a shared `prepareMintCall()` in `src/server.js` used by both
  `executeMint` (immediate) and the scheduler's `executeTask`, so they can't drift apart again.
- Dashboard's Schedule form now has the same "Auto-detect price & opening time" button Minting
  already had (`dashboard/src/App.jsx`, `Tasks` component).
- 🟡 Discord's `/task create` still requires a raw JSON body with an explicit `mintTime` — no
  auto-detection reaches Discord. Tracked separately (see "Still open" below) since it needs a
  guided modal/select-menu flow, bundled with Section E's Discord work.

## Section C — Transaction mode UX (Degen → Normie) ✅

- Data model: migration `035_mode_preset_gas_multiplier.sql` adds `gas_price_multiplier` to
  `mode_presets` (Degen 1.5×, Fast 1.2×, Cautious 1.05×, Normie 1.0× network price), applied in
  `transactionEngine.js`'s fee computation — only to auto-computed fees, never overriding an
  explicit caller-supplied gas price. Threaded through `policyRepository.js` including the
  per-target preset override path.
- UI: Discord's `/mode` is a proper `.addChoices()` dropdown. Dashboard Settings has a
  self-service mode-picker panel (`TransactionModePanel` in `App.jsx`) plus the owner preset
  editor (`Admin.jsx`) got a gas-multiplier field. Telegram's Settings → Transaction mode is a
  real button menu (`telegramMenus.modeMenu`) — tap a preset, Y/N confirm, applied.
- Migration `038_mode_advanced_access_and_default.sql`: the admin Presets editor was still
  showing the raw `display_name` ("Ultra Fast" etc.) since it rendered the DB value directly with
  no relabeling — now fixed at the source. Normie (`safe`) is now a real seeded default
  (`mode_presets.is_default`), resolved in `getEffectiveGovernance` for both display and actual
  policy enforcement, instead of unset users silently falling back to unrelated chain defaults.
  Degen and Fast now require `seat_groups.advanced_modes_allowed` or a per-user
  `user_governance.advanced_modes_allowed` grant — previously any user could select Degen with no
  gating at all.

## Section D — Gas command per-chain selection ✅

- Telegram's `/gas` accepts an optional chain argument (was hardcoded to `ethereum`) and both
  `/gas` and the Gas menu button render a button-based chain switcher
  (`telegramMenus.gasMenu`) instead of the old placeholder text.
- `ETHERSCAN_API_KEY` is set in `.env` (user-provided) — `/gas` returns real data on all 6
  configured chains (ethereum, base, arbitrum, polygon, robinhood, sepolia).

## Section E — Sniper configuration + auto mint-open detection ❌ still open

The largest remaining item — not started this pass.

- No guided config flow anywhere: Telegram has no sniper-creation command (list/edit-by-raw-JSON
  only); Discord's `/sniper create` takes one pre-validated JSON string.
- No mint-open auto-detection integrated into sniper. Today's "sniper" is post-confirmation
  copy-trading of a target wallet (`src/sniper/sniperService.js`), unrelated to detecting when a
  contract's own mint opens. SeaDrop's on-chain `PublicDrop.startTime` is the one real signal
  that exists, currently wired only into `/mint`/`/schedule`.
- Plan (unchanged from original scoping): guided flow (contract → chain → wallet → fee tolerance
  → caps) on both platforms; a new `sniper_mode: 'copy' | 'contract_open'` field; for
  `contract_open`, poll `PublicDrop.startTime` (SeaDrop) or a `paused()`/`saleActive()` getter
  (plain contracts), firing through the same transaction-engine path once open, respecting the
  sniper's own fee/value/daily caps. `socialWatchWorker.js`/`schedulerWorker.js` are reusable
  poll-loop skeletons.

## Section F — Batch wallet import ✅

- Owner-only (`governance.requireOwner`), on both dashboard (Admin → Batch import page) and
  Discord (`/wallet batch-import`). Reuses `persistWallet` per key — same validation/encryption
  as a single import — so one bad key doesn't sink the batch; per-key success/failure reported.
  Intentionally skipped on Telegram (pasting many raw private keys into a Telegram text field is
  a worse security posture than the other two surfaces) — say so if you want it there too.

## Section G + K — OpenSea price fallback + accept-price flow + quantity prompt ✅

- `OPENSEA_API_KEY` is set in `.env`. Turned out OpenSea has a public, self-service, no-login
  "agent" free-tier key endpoint (`POST https://api.opensea.io/api/v2/auth/keys`) — confirmed
  working, currently issued key expires 2026-08-23. `npm run opensea:refresh-key`
  (`scripts/refresh-opensea-key.js`) re-requests and rewrites it into `.env` when it lapses.
- When a contract's price can't be read and OpenSea has a floor price, it's offered as a one-tap
  accept via Y/N-style buttons ("Use X ETH" / "Enter manually") on both `/mint` and `/schedule`'s
  guided flows — reuses the existing free-text fallback either way.
- When a contract's `maxPerWallet` allows more than 1, Telegram's mint flow now asks quantity
  (quick buttons for 1/2/5/max, or type a number) instead of hardcoding 1 — threaded through to
  execution and the confirm screen. Discord and the dashboard already asked.

## Section H — Deposit command + wallet list format ✅

- `/deposit` added on Telegram and Discord (deposit-framed wallet-address lookup).
- Telegram's `/wallets` and `/start` wallet summary now prefix each wallet's balance block with
  `EVM` before the per-chain lines, matching the dashboard's existing chain-family labeling.

## Section I — Send flow quick-select amount buttons ✅

- Telegram's send flow shows Max/75%/50%/25% buttons alongside free-text entry. Max reserves a
  gas buffer (21000 gas at the chain's current fast fee + 30% headroom — `/send` is always a
  plain native-currency transfer, so gas usage is deterministic) so it doesn't leave nothing for
  the network fee; percentage tiers are straightforward fractions of balance.

## Section J — Telegram "edit in place" ✅

Per your explicit choice ("every bot reply, chat becomes one living panel"): all ~45 remaining
one-shot command replies (`/mode`, `/gas`, `/stats`, `/watch *`, `/mintpreset`, `/admin`,
`/mintcall`, task pause/resume/retry, error-catch branches, background push notifications'
formatting-only) now use `tgRender` instead of a bare `sendMessage`, so they edit the chat's
anchored message instead of posting a new bubble. Guided multi-step flows already worked this
way and are unchanged.

---

## Still open

1. **Section E — Sniper guided config + contract-open auto-detection.** Largest remaining item;
   not started.
2. **Discord guided flows for task-schedule.** Give Discord's `/task create` the same contract
   auto-detection (price, opening time) Telegram and the dashboard have, instead of a raw JSON
   body — likely a modal/select-menu flow similar to Discord's existing wallet create/import.
   Natural to bundle with #1 since both need the same Discord component patterns.
3. **P&L: OpenSea sales-detection (auto-fill the "sale" side).** As of 2026-08-17, every confirmed
   mint auto-creates its own `pnl_records` row with real cost + gas (`recordMintActivity`/
   `autoRecordPnl` in `src/server.js`), but `sale` is always left at 0 — there is still no data
   source anywhere that knows when/for-how-much a minted NFT actually resold. Deferred rather than
   guessed at, because:
   - **No token ID is captured from a mint receipt today.** `transactionEngine.js`'s `inspectChain`
     only reads `gasUsed`/`gasPrice`/`blockNumber` from the receipt — it never parses
     `receipt.logs` for the ERC-721 `Transfer(address,address,uint256)` mint event, so there's no
     `(chain, contractAddress, tokenId)` triple recorded per mint to later ask OpenSea "did this
     specific token sell?" Needed before anything else here: parse that event, add
     `token_id`/`contract_address` columns (`activity` has neither today), and a new
     tracking table (one row per minted token, `last_sale_checked_at`/`sold_at`/`sale_price_wei`,
     linked back to its `pnl_records` row).
   - **The existing OpenSea integration (`src/mint/openSeaService.js`) has never called a
     per-token endpoint** — only collection-level floor-price/metadata (`/api/v2/collections/
     {slug}` and `/stats`). A sales watcher needs OpenSea's per-NFT events endpoint instead, which
     this codebase has zero prior usage of to pattern-match against.
   - **Blocked on the key itself, confirmed by production telemetry, not just a local sync gap.**
     `OPENSEA_API_KEY` is absent from this working copy's `.env` (checked directly — zero matches),
     and the 2026-08-17T00:19:48Z production boot log's own startup config line confirms
     `"openSeaConfigured":false` in production too — despite this file's "Inputs already provided"
     section below previously claiming it was set and wouldn't expire until 2026-08-23. The key is
     genuinely gone, not just unsynced to this dev copy; that "Inputs already provided" line is
     stale and should be treated as wrong until re-confirmed. Before building the sales-watcher
     parser: run `npm run opensea:refresh-key` (or otherwise obtain a fresh key) so
     `openSeaConfigured` reports `true` on the next boot, then do a live one-off call against the
     real per-NFT events endpoint to confirm its exact response shape — do not write the parser
     from memory of OpenSea's docs alone, the same discipline the rest of this file's OpenSea work
     already followed. Note this also means the Section G/K OpenSea floor-price fallback (mint
     price detection) is currently non-functional in production too, not just the P&L piece here —
     worth confirming that's also on your radar.
   - Worker skeleton to reuse once unblocked: `src/social/socialWatchWorker.js`'s shape
     (`setInterval` + re-entrancy guard + `health()` + swallow-and-log failures) is the pattern to
     copy for a new `salesWatchWorker.js`, mirroring `contract_value_cache`'s "NULL value + non-null
     `resolved_at` = attempted-but-empty, no row = never attempted" caching convention so a
     per-token poll loop doesn't hammer OpenSea's free-tier ~600 req/h budget it already shares with
     floor-price lookups.

## Verification

Every change this pass was checked with: `npm run check` (syntax across the whole project),
`npm run lint`, and the full test suite (`npm test`, 375 tests, all passing) — including
integration tests against the real database. `npm run dashboard:build` was re-run after every
dashboard change. Migration `035` was applied and its values spot-checked directly against the
database. A real bug this process caught: the new Discord `/wallet batch-import` subcommand had
an optional option ordered before a required one, which discord.js's builder didn't reject at
build time but Discord's own API rejected at command-registration time (surfaced only by actually
booting the bot) — fixed, then verified programmatically that no other command has the same
ordering defect.

## Inputs already provided

- **Etherscan API key** — set in `.env`, Section D confirmed working.
- **OpenSea API key** — ⚠️ stale claim, contradicted by production telemetry: this previously said
  it was set (expiring 2026-08-23), but the 2026-08-17T00:19:48Z production boot log reports
  `"openSeaConfigured":false`, and it's absent from this dev copy's `.env` too. The key is
  genuinely gone from wherever it's supposed to live — re-run `npm run opensea:refresh-key` (or
  otherwise obtain a fresh one) and confirm `openSeaConfigured:true` on the next boot before
  trusting this line again. Affects both Section G/K's mint-price fallback (already shipped, now
  silently degraded) and the deferred P&L sales-detection work above.

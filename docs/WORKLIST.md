# GhostMint Feature Worklist

Tracks the backlog of user-facing feature work (mint reliability, transaction modes, sniper, gas,
wallet import, OpenSea pricing, send/deposit UX, Telegram formatting). Separate from
[`ROADMAP.md`](../ROADMAP.md), which covers the numbered platform/safety milestones (1–16, all
shipped).

- **Round 1** (Sections A–K) was scoped and implemented on 2026-08-16; 9 of 11 sections shipped in
  commit `423c7c1`. Kept below as the record of what exists.
- **Round 2** (Sections L–S) is the newer batch of requirements; L, M, N, Q, and O have shipped.
  R is partial (Phase 1, guided sniper creation, shipped 2026-08-20 — see Round 19 below); P and
  R's own Phase 2 (contract-open detection) remain open; S remains open.
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
- **Round 12** (Sections AI-AK) adds a password gate for sensitive bot actions (built, but SHIPPED
  OFF behind the phrase "ghost lock, arm it"), refuses importing a wallet already held on all three
  surfaces, and reverts AH's two-wallet batch minimum on the owner's call; 2026-08-20.
- **Round 11** (Section AH) makes batch mint and batch import reachable as guided flows on the
  dashboard, Telegram and Discord, rather than JSON commands; requested directly, outside the
  redesign phases; shipped 2026-08-19. Fixed two real defects on the way — see the section.
- **Round 10** (Section AG) is the dashboard redesign — design complete, build well underway on
  `redesign/dashboard`. Shell chrome, the Mint page (all four tabs) and the four-state pass are
  done; see `docs/REDESIGN_HANDOFF.md` for what is next. It began scoped to `dashboard/**` alone,
  but now also carries server-side work in `botCommandService`/`server.js` for the schedule status
  filters, failure reasons and the low-balance pre-flight.
- **Round 13** (Sections AL-AS) is a sequential run of smaller fixes plus the full three-part
  OpenSea Drops build (phase display, OpenSea-backed minting, OpenSea-backed scheduling) requested
  directly ("All three, in that order"); shipped 2026-08-19/20. Also records a live-verified finding
  that OpenSea's API cannot support pre-checking wallet eligibility before a phase opens, and an
  unresolved Discord `/info` "no response" report that got a diagnostic (not a confirmed fix).
- **Round 14** (Section AT) is a speed pass for scheduled mints and Degen mode specifically,
  requested directly and deliberately scoped away from manual mints; shipped 2026-08-20.
- **Round 15** (Section AU) splits RPC traffic into isolated pools so sniper's continuous polling
  can never queue behind a time-critical scheduled broadcast. Pool 1 (scheduled/Degen fast path, a
  generic opt-in `{ENVNAME}_FAST_URLS` per chain) shipped 2026-08-20; pool 2 (sniper isolation + a
  real WebSocket endpoint) remains open, needs its own provider/budget decision.
- **Round 16** (Section AV) is the owner's own two-tier plan for sniper execution speed —
  2026-08-20. Worklist A: finish Round 15's pool 2 (sniper's own RPC/WS pool), same-tx multi-RPC
  broadcast for sniper, sniper as its own execution profile, precise near-launch timers, and
  end-to-end timing logs all shipped; pre-arming scheduled mints (item 3) remains open, deliberately
  paused pending real timing data rather than built speculatively. Worklist B (after A is stable):
  parallelized pre-arm, dynamic fee presets, RPC health scoring/failover, hot wallet session cache
  (security tradeoff, needs its own sign-off), and latency dashboards — none started.
- **Round 21** (Section AX) fixes the live-reported "scheduled transactions always fail" —
  diagnosed from production logs read directly through the Railway API, then live-probed against
  OpenSea: OpenSea-backed scheduled tasks failed permanently whenever `buildMintTransaction`
  couldn't serve calldata at fire time (contract not indexed by OpenSea at all, bare collection
  with no drop-mint endpoint behind it, or plain OpenSea unavailability), with no fallback to this
  app's own on-chain minting. Public stages now fall back; eligibility-gated stages still fail
  honestly. Shipped 2026-08-22 — see Round 21 below.
- **Round 20** (Section AF/AD follow-up) makes OpenSea phase detection show on every paste, not just
  `/info` — live-reported ("I need you to be able to detect and show phases, Telegram and Discord
  still doesn't do that") and confirmed live against a real drop (KIYO, contract
  `0x90c888ea77194e52c97c3692e715e276bb68931b`, Robinhood Chain): the backend detection already
  worked (`openSeaService.getDrop` correctly returned three real, named stages), it just never ran
  outside `/info` — `includeStats`'s gate covered `drop` too, so a bare paste got the leaner card by
  design. Split into its own opt-in flag; shipped 2026-08-21.
  **Follow-up, same day:** the owner flagged that this multiplies read-call volume against OpenSea's
  API (every paste now, not just `/info`) and asked whether splitting into separate keys/accounts
  would help. Live-verified against OpenSea's own docs (two independent pages): rate limits pool
  **per account**, not per key — "creating multiple API keys will not increase your overall rate
  limit" — so a second key on the *same* account buys nothing. What already exists for free: OpenSea
  splits its limit into separate read (600/h) and write (30/h) buckets, and this app's only write
  call is `buildMintTransaction` (the actual OpenSea-backed mint) — so the increased read volume was
  never actually threatening mint execution in the first place. Built anyway, as a genuine
  least-privilege/blast-radius improvement the owner wanted regardless: a **second, real OpenSea
  account's key**, `OPENSEA_READ_API_KEY` (optional, aliases the main key when unset — same
  zero-behavior-change-if-unconfigured shape as Round 15's RPC pool split), now carries every read
  call (`getDrop`/`getCollectionMetadata`/`getCollectionStats`/`resolveCollectionContract`);
  `OPENSEA_API_KEY` keeps handling `buildMintTransaction` alone. `server.js` composes one
  `openSeaService`-shaped object from two underlying `createOpenSeaService` instances so every
  existing caller (both platforms, the scheduler) needed zero changes. Live-verified the new key
  actually works (real `getDrop` call against the same KIYO contract, correct data back) before
  setting it on Railway via `variableUpsert`. New tests in `tests/config.test.js` covering both the
  aliased-when-unset and genuinely-separate-when-configured cases, keys never leaking into the
  summary either way.
- **Round 19** (Section R, Phase 1) is the guided sniper-creation flow on both platforms — Telegram
  had no way to create a sniper at all before this, Discord's only path was a hand-typed JSON blob.
  Scoped explicitly to just this against the existing copy-mode schema (no new DB migration);
  contract-open detection (Phase 2) and Section P's tx-watching are real, separate pieces deferred
  on purpose. Shipped 2026-08-20 — see Section R below for the full write-up.
- **Round 18** (no section letter yet — folded into Section AH's batch-mint work) fixes a live-found
  regression in Discord's batch-mint wallet multi-select: picking one wallet from the dropdown
  advanced the flow immediately instead of letting more be added, since each dropdown submission
  only carries what was checked in that one session and the menu never marked earlier picks
  `default: true` on re-render. Now stays on the picker (showing the running selection, pre-checked)
  until an explicit Continue tap, mirroring Telegram's toggle-then-`flow:walletcontinue` shape;
  2026-08-20.
- **Round 17** (Section AW) is a run of live-reported bugs found via real production use,
  2026-08-20. Shipped: Telegram's `/batchmint` — the one command Telegram's own "/" autocomplete
  actually advertises — was wired only to a raw-JSON power-user path and silently did nothing when
  typed bare, now opens the same guided wallet-picker flow the "Batch mint" button uses. A SeaDrop
  collection's mint price displaying wrong once sold out, fixed (`soldOut` now checks
  `totalMinted >= maxSupply` too, not just the stage's time window). Discord's `/batch-mint` "wallets
  not pulling up a picker" turned out to be working as designed (typing into `wallets` is the
  documented direct-fill shortcut) but that field had no autocomplete backing up its own "omit to
  pick from a list" description — now autocompletes like every other wallet-label field. Diagnosed,
  Discord-side, not this app's code: auto-detect on pasted links working in only one channel per
  server turned out to be that channel's own restricted permission list simply never including the
  bot's role, confirmed live via the diagnostic logging this round also shipped (which stays in
  place) — fixed by the user directly in Discord, nothing to change here.

Status legend: ✅ Done · 🟡 Partial · ❌ Not started

---

# Round 22 — launch squads: the ACO/coordinated-burst service, day 1 of 9 (2026-08-22)

## Section AZ — squads skeleton: plan → stage → fire → settle ✅ (D1–2 of the 9-day plan)

Owner goal: `/batchmint`-class fan-outs that compete with dedicated mint scripts at hyped drops
(guaranteed-spot + FCFS wallets fired together, as fast and as dependably as possible). Design
decision recorded up front: **separate orchestrator (`src/launch/`), shared engine** — `/batchmint`
stays a manual fan-out; launches get their own lifecycle (stage → arm → fire → settle) composed
from the same primitives (`executePrepared`, intent idempotency, nonce safety, governance), so
there is no second transaction path to keep correct.

Shipped today:

- **Migration `048`**: `launch_squads` + `launch_squad_members`. Deliberately no signed-tx column —
  v1 signs inside `submit()` at fire time; pre-signing (a speed lever) stays a gated follow-up.
- **`planner.js`** (pure): priority-ordered wave chunking — lower priority number fires earlier,
  ties keep selection order.
- **`stager.js`**: pre-fire verification — account status, SeaDrop detection (method + fee
  recipient + live PublicDrop price captured once), per-wallet existence/chain/balance checks with
  a 400k-gas buffer heuristic. Underfunded wallets are *skipped with a reason*, never fatal to the
  squad. Nonces/simulation stay at fire time by design (freshness + idempotency).
- **`launcher.js`**: waves fire back-to-back, all members within a wave simultaneously
  (`Promise.allSettled`); one member's send failure marks just that member failed. Settlement
  reconciles every sent member's intent in the background (same `reconcileIntent` mechanism the
  scheduler uses) until final states or a 15-minute window elapses, then writes the report card
  (`{counts:{confirmed,reverted,failed,skipped}}`) and notifies. Timer-triggered squads fire from a
  light 1s poll; manual FIRE is instant.
- **Telegram `/aco`** power syntax (`/aco <contract> <qty> w1,w2,...`) with staging summary +
  🚀 FIRE NOW / ❌ ABORT inline buttons; **Discord `/aco`** slash command mirrors it fully
  (contract/wallets/quantity/price/chain options, comma-separated wallet autocomplete reused from
  batch-mint, FIRE/ABORT components) — Discord is the owner's primary surface, both shipped same-day.
  Guided picker flow is the next polish item.
- **Engine**: `triggerSource 'launch'` joins scheduled/sniper on the fast RPC path (tight timeout,
  fast pool) — a coordinated burst is exactly as time-critical as a scheduled fire.
- **RPC grid wired live on Railway**: verified Alchemy lane #2 + Infura appended to ETH/Base
  general+fast+sniper pools (ETH 4→6, Base 2→4, every FAST/SNIPER tier 1→3) — the multi-provider
  broadcast race now has real backbones to race across.

Verification: 11 new tests across planner/stager/launcher (ordering, skip-with-reason, plain-contract
price requirement, failure isolation, settlement convergence, wave chunking); full suite 856 → 852
pass, failures unchanged (the two by-design review repros; two integration timeouts passed in
isolation).

## Section BA — broadcast race for launches + the bump ladder ✅ (D4–5)

1. **Launch broadcasts now race across the fast pool** (`transactionEngine`): same signed bytes to
   every endpoint concurrently, identical nonce+signature so losers' "already known" responses are
   discarded -- the sniper's competitive-inclusion argument applies verbatim to a coordinated
   burst whose staging already did every slow check.
2. **The bump ladder** (`src/transactions/bumper.js`): a pending broadcast stuck past
   `TX_BUMP_AFTER_MS` (45s default) gets re-bid same-nonce at +15% (`TX_BUMP_INCREMENT_PCT`),
   floored by the live fee, capped by the wallet's effective governance gas ceiling, at most three
   rungs (`TX_BUMP_MAX_ATTEMPTS`), scoped to launch+scheduled sources (`TX_BUMP_SOURCES`). Same-
   nonce replacement is safe under uncertainty; a consumed nonce is skipped (reconciliation owns
   it); `attachBump` moves the new hash primary, preserves the old in `bumped_from_tx_hash`
   (migration `050`), resets `pending_at` so each rung gets a full window, and logs a
   pending→pending transition for the audit trail.

Verification: 5 new bumper tests (fee math both fee models, floor-wins branch, ceiling refusal,
consumed-nonce skip, attempt ceiling); eslint clean on touched files -- which would have caught
today's two boot crashes (`no-undef`) and is now a hard pre-push gate; full suite 868 → 866 with
only the two by-design review repros failing.

Next in this round (days 6–7): live monitor/report UI for running launches, load rehearsal
(50+ synthetic wallets), then D9 acceptance run -- internetmonkes on Aug 28 is the natural target.

## Incident (same day): lane wiring crashed production for ~5 minutes

The RPC-grid wiring appended two URLs to `ETH_RPC_URLS` without checking the consuming
constraint — config's `validateUrlList` enforces **1–5 unique URLs per pool** and throws at boot.
Production crash-looped from 20:26 until 20:31 UTC (`ConfigurationError: ETH_RPC_URLS must contain
1-5 unique URLs`). Fixed by trimming to 5 with diversity preserved (original alchemy primary +
lane-2 alchemy + infura + the drpc/cloudflare lanes already present that this session didn't know
about). Deploy `eff2e4ce` SUCCESS, all workers healthy. The cap is now documented in
`.env.example`; rule for any future external-config writes: **read the consumer's validation
before writing, and re-verify the deployment after every variableUpsert** — six upserts fired six
redeploys and none were checked until a human noticed.

## Incident (same day): paste-detect dead on Discord — zombie gateway session + latent matcher gap

Reported as "paste for info no longer works on Discord." Diagnosis chain, from logs alone thanks
to the Round 17 diagnostic logging plus a temporary gateway-entry probe:

1. Zero Paste-detect lines despite real pastes, while slash interactions worked — the message
   stream was silently dead. Root cause: **a half-dead Discord gateway session after ~7 deploys of
   churn** (two crash windows today). A clean container restart forced a fresh session; delivery
   returned instantly and a real paste flowed through detection end-to-end (logged live).
2. The report also exposed a **latent matcher gap**, now fixed: detection tested the ENTIRE
   message body against anchored patterns, so multi-entity pastes (address + address + OpenSea
   link) or wrapped/backticked/zero-width-poisoned lines matched nothing — silently. Detection now
   scans per line (first match wins), strips edge decorations and invisible characters.

The temporary `messageCreate` entry log shipped with the fix and is removed now that delivery is
confirmed healthy; the per-line matching and its two regression tests stay permanently.

Next in this round (days 3–7): block-height + pending-tx triggers (`trigger.js`, the front-running
piece), multi-RPC broadcast race extension beyond sniper (owner-approved direction), accelerated
bump/replace for launch sends, live monitor/report UI, load rehearsal.

---

# Round 21 — "scheduled transactions always fail" (2026-08-22)

## Section AX — OpenSea-backed scheduled mints no longer die when OpenSea can't serve them ✅

Live-reported, absolute terms. Diagnosed from evidence rather than inspection, in three steps:

1. **The dev Supabase `mint_tasks` table is all test debris** (879 failed rows against fake
   contracts `0x…44`/`0x…22`, wallet labels like `scheduler-1787409370215`, mint times in 2027) —
   integration tests run against the same `DATABASE_URL`. Nothing diagnosable there; production
   writes to its own database.
2. **Production logs via the Railway GraphQL API** (`deploymentLogs` on the current deployment):
   `OpenSea buildMintTransaction (slug lookup) failed for ethereum:0x30cf…: HTTP 404` — and the same
   for two more contracts — at exactly 12:00:00, 13:00:00 and 14:00:00 UTC. Round-the-hour stamps =
   scheduled tasks firing on the hour and dying inside the one call an OpenSea-backed
   (`via_opensea`) task hard-requires.
3. **Live probes of those exact contracts with this app's own key**: two aren't indexed by OpenSea
   at all ("Contract … not found" from the slug lookup), the third resolves as a bare,
   address-named collection whose `POST /drops/{slug}/mint` 404s. The API behaved as documented;
   the scheduler treated every one of these answers as a permanent validation failure.

Root cause: since Section AR, a task scheduled through the OpenSea phase flow sets
`via_opensea=true`, and `executeTask`'s whole branch was "ask OpenSea for calldata or throw
permanently". Any OpenSea miss at fire time — unindexed contract, drop endpoint gone, transient
outage — killed the task. No retry, no fallback, even though this app's own SeaDrop/on-chain
calldata path sat directly below in the same function.

Fix (`src/server.js` `executeTask`): when `buildMintTransaction` returns null (its own 409/422
eligibility answers still throw inside it and keep their meaning), the task now falls through to
the shared on-chain path — the same drift preflight + `prepareMintCall` + `executePrepared` a
manual mint uses. One guard keeps honesty where falling back could only burn gas:
`OPENSEA_ELIGIBILITY_ONLY_STAGES` (`allowlist`, `gtd`, `fcfs`, `presale`) refuses the fallback when
the stage the task was created against is eligibility-gated (stored now, see below) or when
OpenSea's live data says the currently-active stage is. For those, the failure message says why.

Supporting change: `mint_tasks.stage_type` (migration `047`, nullable) records the OpenSea stage
type at schedule time via `openSeaPhaseTaskData` → `createTask` → `saveTask`, mapped back through
both repositories. This is what lets a gated-stage task keep failing honestly even when OpenSea is
too unreachable at fire time to ask what's active.

Verification: `node --check` clean on all five touched sources; migration applied and confirmed in
`schema_migrations`; targeted suites 113/113 (scheduler unit + integration, openSeaService,
botCommandService, dashboard); full suite 840 tests → 838 pass with only the two known
by-design-open review repros failing, zero cancellations.

## Section AY — pre-arming scheduled mints (Round 16 item A3, un-paused) ✅

The competitive analysis paused item A3 "pending real timing data." That data can't exist yet —
Railway retains only the current deployment's logs, and the only timing line in it is a manual
robinhood mint (prep 357ms, sign 3ms, broadcast 114ms). Every scheduled fire in retained memory
died at the OpenSea 404s before submit() could log anything. Rather than stay blocked on evidence
that cannot accumulate, this ships the analysis's own fallback reasoning: the fire path provably
still runs checks/lookups that cannot change between T−lead and T0, so moving them is pure win.

Two changes:

1. **True pre-arm, opt-in via `SCHEDULE_PREARM_LEAD_MS`** (0 = off; zero behavior change when
   unset). `schedulerWorker` arms a second timer per imminent task at fire-moment-minus-lead,
   calling an injected `prearm(task)` hook that never claims, never mutates task state, and whose
   failures are logged and swallowed — `executeTask` must remain able to do everything itself.
   `server.js`'s hook runs account-status enforcement, wallet resolution and SeaDrop discovery
   warm-up, plus a PublicDrop sanity read whose only output is a log line when a task's scheduled
   time sits more than 10 minutes off its contract's live window (mis-scheduled tasks become
   visible BEFORE their silent T0 failure). Deliberately NOT cached: calldata and price. SeaDrop's
   PublicDrop is one mutable struct projects update around launches — msg.value carrying a stale
   mint price could only buy an on-chain revert. The cache entry just marks front matter verified;
   consumed exactly once by executeTask when its mintTime still matches. viaOpenSea tasks are not
   pre-armed: their expensive step must run at T0 anyway.
2. **One fresh PublicDrop read instead of two identical ones.** executeTask's drift preflight read
   PublicDrop live, then prepareMintCall read it again immediately after — two identical serial
   RPC round trips back to back on every non-OpenSea scheduled fire. prepareMintCall now accepts
   the already-read pair; freshness semantics unchanged (the single read still happens right
   before broadcast), one round trip gone.

Tests: four new schedulerWorker cases (prearm fires at lead time without claiming; moved mintTime
replaces the old timer without double-firing; throwing hooks are logged and forgotten; no options
means zero new behavior) + the repository fixture gained a live state box for scan-window moves.
Full suite 845 → 843 pass with only the two known by-design review repros failing.

## Also flagged during diagnosis, not fixed here

- Production shows 102 tasks stuck in `claimed` (99 of them test fixtures) and a recurring
  hourly `buildMintTransaction` 404 pair that may be TWO tasks per hour from one user retrying —
  both worth a look once real users confirm the fix landed.
- The dev DB doubles as the integration-test target; a cleanup script for fixture rows would make
  future log/DB triage much faster.

---

# Round 17 — live-reported bug run (2026-08-20)

## Section AW — Batch-mint command/button parity, SeaDrop sold-out price ✅

Three separate live reports came in back to back while Round 16 was wrapping up. Tracked together
since they surfaced the same way (a real user hitting a real drop or a real command), not because
they share a root cause.

### `/batchmint` silently doing nothing on Telegram ✅

Reported as "batch mint still doesn't pull up wallets to select from when using the slash command,
but it works when using the button." Root cause: Telegram's registered command list
(`bot.setMyCommands`, the thing that actually populates the "/" autocomplete users tap) advertises
`batchmint` — "Mint the same drop from several wallets" — but the only handler wired to that name
was the raw-JSON power-user path (`bot.onText(/^\/batchmint(?:@\w+)?\s+([\s\S]+)$/i, ...)`), which
requires a hand-typed JSON payload and never shows a wallet picker. The guided flow that actually
shows the picker — the same one `menu:mint:batch` (the button) starts via `startMintFlow({multi:
true, ...})` — only existed under an undocumented `/batch` command, never added to `setMyCommands`.
A bare `/batchmint` matched neither handler's regex, so it looked like nothing happened at all.

Fix: added a second `bot.onText(/^\/batchmint(?:@\w+)?$/, ...)` handler that opens the same guided
flow the button does when called with no arguments; the existing JSON-payload handler is untouched
and still reachable by passing arguments. Mirrors how `/mint` (guided) and `/mintcall` (raw JSON)
already coexist. `src/server.js`. Verified: `node --check`, `npx eslint --max-warnings=0`, both
clean. `/batch` still works as a hidden alias; left in place rather than removed since it's harmless
and other in-flight sessions may reference it.

### SeaDrop mint price wrong once a collection sells out ✅

Reported live against `phoenix-in-the-hood` (contract `0x6209e8d1e28cc40427f8e7ec8cc1e9410a35612a`,
Robinhood Chain): both Telegram and Discord showed "Mint price: 0.002 ETH per item" despite the
collection being confirmed free (OpenSea's API and a live on-chain read both independently report 0
wei for every stage) and confirmed sold out (4444/4444, visible in Discord's own Stats block — the
decisive piece of evidence, since it ruled out phase drift, floor-price leakage, a stale DB cache,
and cross-platform formula divergence, all checked and ruled out first).

Root cause: `detectMintContract`'s SeaDrop branch in `src/commands/botCommandService.js` computes
`soldOut` from the stage's `endTime` alone —
`Boolean(seaDrop.publicDrop?.endTime && seaDrop.publicDrop.endTime * 1000 <= Date.now())` — never
checking `totalMinted >= maxSupply` the way the plain-mint branch a few lines below correctly does.
This collection is sold out but its stage window hasn't closed, so `soldOut` evaluates `false` and
`resolveDisplayPrice` falls through to the real (non-zero-looking, stale) per-item price instead of
reporting sold-out/free.

**Fixed** — this doc's own "not yet written" note was stale (caught and corrected 2026-08-21):
`botCommandService.js`'s SeaDrop branch (line ~211) does compute `soldOut` as
`Boolean(timeWindowClosed || (maxSupplyValue !== null && typeof stats?.totalMinted === 'number' &&
stats.totalMinted >= maxSupplyValue))`, confirmed live against the actual code, not just this doc.

### Discord `/batch-mint` reported as the same symptom — not a bug, but a real trap ✅

Reported as "also the same on discord" immediately after the Telegram fix, before any diagnosis was
shared. Static + live inspection found no matching bug: `/batch-mint`'s `wallets`/`quantity`/`price`
options are all genuinely optional in the code (`src/discord/discordBot.js`), omitting any of them
routes to the identical `startMintGuidedFlow` call the "Batch mint" button uses, and a live
`GET /applications/{id}/commands` against Discord's own API confirmed the *currently registered*
command schema matches the code exactly — ruling out stale command registration.

Confirmed with the user: they were typing into `wallets` — the documented direct-fill shortcut, not
the picker path. That's working as designed, but the field had **no autocomplete at all**, so typing
a label by hand was the only thing that field ever visibly did; the "omit to pick from a list" note
in its own description had no on-screen affordance backing it up, making the direct-fill path the
path of least resistance even for someone who wanted the picker.

Fix: `wallets` now has `.setAutocomplete(true)`; the shared autocomplete handler
(`src/discord/discordBot.js`, the `interaction.isAutocomplete?.()` branch) gained comma-aware
handling — completes only the segment currently being typed (after the last comma), offers the full
accumulated string as each suggestion's value so picking one preserves everything already chosen,
and excludes labels already present so the same wallet can't be suggested twice. Verified:
`node --check`, `npx eslint --max-warnings=0`, both clean; 3 new tests in `tests/discordBot.test.js`
(definition asserts `autocomplete: true`; handler tests cover a fresh suggestion list and picking a
second wallet while the first stays chosen) — full file 26/26 passing.

### Discord auto-detect working in only one channel per server — root cause found, no code fix needed ✅

Separately reported: pasting a contract/OpenSea link auto-detects in one channel of one server, but
not in the other two servers, and not on other channels of the *same* server that does work — so
it's per-channel, not per-guild. Every hypothesis raised was checked directly against the real
servers and ruled out in turn, not assumed:

- **App-level config** — `DISCORD_CHANNEL_IDS` and `DISCORD_DEV_GUILD_ID` are both unset, confirmed
  against Railway's *live* production values (not just local `.env`) via `variables(...)`, so
  `verifyDiscordContext`'s guild/channel allowlist checks are no-ops everywhere right now.
- **Channel permissions** — confirmed by the user directly on the two broken channels: View Channel,
  Read Message History, Send Messages, and Embed Links are all present for the bot's role. (The
  reasoning for checking Send Messages/Embed Links specifically: every slash-command reply in this
  app is ephemeral — `deferReply({ ephemeral: true })`, the one place that's set, covers every chat
  command — and ephemeral interaction responses are delivered straight to the invoking user without
  needing the bot's normal channel-send permissions at all. So "slash commands work everywhere" was
  never actually evidence that `message.reply()`, a real channel message the paste-detector depends
  on, would also succeed — worth confirming separately, which the user did.)
- **Install method** — confirmed the bot was added via the classic `bot` + `applications.commands`
  OAuth invite (not Discord's newer "User Install," which can make slash commands work without the
  app ever joining the guild as a member) and shows as a real member in the two broken servers.

With every direct-permission and config explanation exhausted, the actual failure point needs to be
observed rather than guessed at — and `handleMintPasteMessage` swallows every failure completely
silently by design (a failed check here was never worth surfacing as a visible error in a channel
that may not even be the bot's), so there was nothing in Railway's logs to look at. Shipped: three
log lines on paths that already did nothing before, so behavior is unchanged — logs when an
address/link-shaped message is received (guild+channel), logs if `message.reply()` itself fails, and
logs if anything earlier (`verifyDiscordContext`, account resolution) throws. `log` threaded through
from `createDiscordBot`'s existing param down to `handleMintPasteMessage`, which gained an optional
`log = () => {}` parameter. `src/discord/discordBot.js`. Verified: `node --check`,
`npx eslint --max-warnings=0`, both clean; `discordTaskFlow.test.js` + `discordMintFlow.test.js` +
`discordBot.test.js` (70 tests covering `handleMintPasteMessage` and the wider Discord flow) still
pass unchanged.

**Resolved.** The user reproduced the failure live in a broken channel while also pasting in the
working one for comparison; `deploymentLogs(...)` filtered on `Paste-detect` showed exactly one log
line total, for the working channel only — the broken channel's paste produced *nothing*, not even
the "received" line that fires before any permission check runs. That put it beyond doubt that
Discord itself never delivers the `messageCreate` gateway event to the bot for that channel, not an
app-side failure. Checked the role's own permission page next (all green — View Channels, Send
Messages, Read Message History, Embed Links, one role only, no second role to conflict) and the
channel's own permission overwrite tab, at which point the user found it directly: **the bot's role
was never added to that channel's member/permission list at all** (a "Private"/restricted channel
that only grants access to explicitly-listed roles) — a fundamentally different thing from the
role's server-wide default permissions being correct, which is what every earlier check had
confirmed and why they kept coming back clean. Fixed by the user adding the role to that channel's
permission overwrites directly in Discord; nothing to change in this app. The diagnostic logging
stays in place — cheap, harmless, and exactly what made this conclusive instead of another guess.

---



## Section AV — Sniper as its own execution profile, pre-arming, precise timers, and same-tx multi-RPC broadcast 🟡

The owner wrote out their own plan directly, as two worklists — "A" (must ship) and "B"
(enhancements, after A is stable) — then added one architectural correction: **sniper should be
treated as a true execution profile, not just a gas preset.** That correction turned out to map
cleanly onto something that already exists: `triggerSource === 'blockchain'` already distinguishes
a sniper-fired execution from a scheduled or manual one in `policyRepository.js`'s
`applyGovernance` (it's how today's `blockchain_off` simulation mode works) — every item below
gates on that existing signal, not on the Degen/Normie mode-preset axis at all, and not on any new
signal invented for this round.

### Worklist A — must ship

**Shipped 2026-08-20: items 1, 2 (config only — see note), 4, 5, 6, 7. Still open: item 3**
(pre-arming) — deliberately paused rather than built speculatively; see its own note below for why.

1. **Finish Round 15's pool 2** — sniper gets its own RPC/WS pool, isolated from the scheduled/Degen
   fast path shipped in Round 15 pool 1. Decided: a **separate Alchemy app** from the scheduled
   pool's (continuous sniper polling must never share a rate-limit bucket with a time-critical
   scheduled broadcast — that was the whole point of splitting pools in the first place), same
   `{ENVNAME}_RPC_SNIPER_URLS`/`{ENVNAME}_RPC_SNIPER_WS` config shape Round 15 already established
   for pool 1.
2. **Account tier: Alchemy Pay-As-You-Go, not Free** — reconsidered given real scale (`i plan to
   use this in two server of about 100 users each`, ~200 users total). Free tier caps at **25
   requests/second**; the actual risk isn't monthly volume (`ensureChainWatcher` is per-*chain*,
   not per-user, so baseline watching load stays low regardless of user count) but *burst*
   throughput — if a popular drop opens and, say, 50 of 200 users' snipers match within the same
   few seconds, that's ~50 simultaneous fire sequences (fee/balance/nonce/simulate/broadcast each)
   easily exceeding 25 req/s at exactly the moment it matters most. Pay-As-You-Go jumps to 300
   req/s, usage-based at $0.40-0.45/1M compute units, no fixed monthly minimum. This is an
   account-level setting, so it covers both apps/pools, not just the new sniper one.
   - **QuickNode checked as an alternative, not assumed away.** Live-verified pricing: QuickNode's
     free tier is a **one-month trial only**, not permanent like Alchemy's; matching Alchemy's
     ~300 req/s requires QuickNode's top "Scale" tier at **$424-499/month fixed** (and that still
     only reaches 250 req/s) versus Alchemy's usage-based rate. QuickNode also supports Robinhood
     Chain, so chain coverage wasn't the deciding factor — the pricing structure was. QuickNode has
     a real reputation in trading/sniping circles for raw latency, but no verified benchmark
     comparing the two was found or claimed; the decision rests on the confirmed pricing gap, not
     an unconfirmed latency claim.
3. **Pre-arm scheduled mints** — genuinely new work, not something Round 14 already covered. Round
   14 fixed scheduler *concurrency* (tasks no longer serialize behind each other); it never touched
   *precision* — today's scheduler still starts all prep work (fee fetch, balance, nonce,
   simulation) only once a task becomes due, not before. Pre-arming splits "prepare" from "fire"
   into two phases, capturing nonce/fee state some lead time ahead of `mint_time` so the only work
   left at the fire moment is signing and broadcasting. Default lead time: **~10-15s**, matching the
   OSNM-Z reference's own constants (already logged in this file's Round 3, Section W) — open to
   tuning once real timing logs (item 6) show how stale a 10-15s-old fee/nonce snapshot actually
   gets in practice.
4. **Precise timers for near-launch tasks, replacing coarse polling** — distinct from item 3: this
   is about how the scheduler *wakes up* near a task's fire moment, not what it does once awake.
   Default: once a task is within one poll interval of due, switch from the normal ~1s poll tick to
   a direct `setTimeout` fire at the exact target moment, instead of waiting for the next tick.
5. **Same-tx multi-RPC broadcast, sniper only** — deliberately *not* extended to scheduled/Degen
   mints generally (Round 14 explicitly declined broadcast-racing there, reasoning the
   duplicate-broadcast complexity wasn't worth it for that lower-stakes case). For sniper it's
   justified: same signed transaction, same nonce and signature, so no double-spend risk — worst
   case a losing endpoint reports "already known." Fans out to whatever's configured in the
   sniper pool's own candidate list (item 1/2) — **not** a private MEV relay (Flashbots Protect,
   MEV-blocker, etc.), a deliberate scope decision: those solve front-running/sandwich protection,
   a DEX-trade problem where there's price slippage to extract. An NFT mint sniper isn't racing
   predators reading mempool intent, it's racing everyone else for inclusion in the first valid
   block after a contract opens — a pure speed/redundancy problem a relay doesn't obviously help
   with, at real added cost and a new vendor relationship.
6. **Keep the launch path minimal; add end-to-end timing logs** — deliberately no speculative
   complexity added to the hot path itself. Timestamp each stage (task claimed → pre-armed →
   signed → broadcast → confirmed) so items 3/4's tuning constants get adjusted from real data
   later, not re-guessed.
7. **Sniper as its own execution profile** — the owner's own correction, folded in here rather than
   left as a separate item: every behavior above (dedicated pool, multi-broadcast, precise timing)
   activates on `triggerSource === 'blockchain'` specifically, independent of whichever mode preset
   (Degen/Normie/etc.) the account has selected. This is also where Worklist B's own "sniper
   profile" item (below) turns out to already be covered, not a separate later task.

### What shipped 2026-08-20: items 1, 2, 4, 5, 6, 7 ✅

- **Item 4 (precise timers for near-launch tasks):** `schedulerRepository.js` gained
  `listImminent({ now, withinMs })` — a read-only lookahead (no locking, no row mutation, safe to
  call as often as needed) finding tasks due within `withinMs`, live-verified against the real
  database. `schedulerWorker.js` gained `armPreciseTimers()`, called from the same `setInterval`
  as `tick()`: for each imminent task not already tracked in an in-memory `Map`, it schedules an
  exact `setTimeout` that fires `tick()` the instant the task becomes due, instead of waiting for
  the next ~1s poll tick. Deliberately layered *on top of* the existing claim machinery rather than
  replacing any of it — a precise timer firing early, late, or for a task that's since been
  claimed/cancelled elsewhere is harmless by construction: it just calls the same `tick()` →
  `claimDue()` path, whose own `WHERE next_attempt_at <= NOW()` and `FOR UPDATE SKIP LOCKED` already
  guarantee correctness regardless of what triggered the check. `stop()` clears every armed timer.
  Default lookahead window is `pollIntervalMs * 2`, wide enough that nothing can slip through the
  gap between one lookahead scan and the next.
- **Item 1/7 (sniper's own pool + execution profile):** `config/index.js` gained `SNIPER_CHAINS`,
  built the same way Round 15's `FAST_CHAINS` was — `parseFastRpcUrls`/its validation logic was
  generalized into `parseNamedRpcUrls(definition, generalUrls, suffix)` so both pools share one
  implementation, and `parseWsRpcUrl` gained an optional `suffix` param so sniper can have its own
  `{ENVNAME}_RPC_SNIPER_WS` independent of any general-pool WS setting. `{ENVNAME}_RPC_SNIPER_URLS`
  prepends ahead of the general pool's URLs (same automatic-fallback shape as pool 1); unconfigured,
  `SNIPER_CHAINS[chain] === CHAINS[chain]` by reference, zero behavior change. `server.js`'s
  `ensureChainWatcher` now reads from `SNIPER_CHAINS` instead of `CHAINS`. `transactionEngine.js`
  gained an optional `sniperProviderService` constructor param; `submit()` computes
  `isSniperTrigger = request.triggerSource === 'blockchain'` and an `activeService` that prefers
  sniper's pool over the scheduled/Degen fast pool over the general one, in that priority order —
  this is the actual mechanism behind "sniper is its own execution profile," not a separate flag.
  `server.js` constructs `sniperProviderService` from `SNIPER_CHAINS` alongside the existing two.
- **Item 5 (same-tx multi-RPC broadcast):** `providerService.js` gained `performAll(chain,
  operationName, operation)` — fans one operation out to every configured candidate concurrently,
  resolving with whichever succeeds first, throwing `RpcUnavailableError` only if all fail. Used
  *only* for the broadcast step, *only* when `isSniperTrigger && sniperProviderService`; every other
  trigger source (including sniper with no sniper pool configured) keeps `perform()`'s ordinary
  sequential try-then-fallback. `preview()` and every pre-broadcast read path were untouched.
- **Item 6 (timing logs):** `submit()` captures four checkpoints (`submitStartedAt`, `preparedAt`,
  `signedAt`, `broadcastAt`) in a plain local object and reports them through one additional
  `notify({ event: 'timing', ... })` call right after broadcast — deliberately *not* persisted
  through `intentRepository` at all (a test pins this: `repository.intents[0].timings` stays
  `undefined`), so this can never affect what's actually stored for an intent regardless of what
  the repository's real schema supports. `confirmedAt` needed no new code: `reconcileIntent` already
  calls `transition()` on every state change including the final one, so the existing `state:
  'confirmed'` notify already reports that moment. `server.js`'s `notify` callback logs elapsed
  deltas between checkpoints (prep/sign/broadcast/total) per transaction.
- **Item 2 (Alchemy Pay-As-You-Go)** is a billing action outside this app's own code — nothing to
  ship there beyond what item 1 already enables (config is provider-agnostic; whatever URL an
  upgraded, separate Alchemy app produces just gets pasted into `{ENVNAME}_RPC_SNIPER_URLS`/`_WS`).
  Recorded as covered because the code path it depends on is real and tested, not because the
  account has actually been upgraded — that remains an owner action.
- **Item 3 (pre-arming) deliberately paused, not built.** Raised directly with the owner rather than
  built speculatively: pre-arming's value is now genuinely in question. Round 14's `feeDataCache`
  has a 5-second TTL, tuned specifically because gas prices move fast — a 10-15s-old pre-armed fee
  snapshot (the plan's own default lead time) is already past that staleness window, so it couldn't
  be safely reused at fire time without a fresh re-check anyway, which mostly defeats the point. And
  item 4, shipped the same day, already closes the *larger* measured gap (waking up to ~1 poll
  interval late); what's left is the actual RPC chain at fire time (fee → gas estimate → balance →
  simulate → nonce → network), likely 50-200ms per call against production's real RPC. Decided to
  wait for item 6's real timing data to show whether that remaining chain is an actual bottleneck in
  production before building pre-arming's real complexity (a cache with different staleness rules
  than the existing one, re-validation logic, more edge cases on a money-moving path) against a
  guess. Read the `Transaction timing (...)` log lines this app now emits for real scheduled/sniper
  mints — specifically the `prep` component — to make that call; see the note in CLAUDE.md for how
  to pull them from Railway directly.
- Verified: `npm run lint` on every touched file, and the full suite (728 tests; the only failures
  across two separate full runs were the same four DB-bootstrap/pool-restart integration tests this
  file already documents as flaky in this sandboxed dev environment, corroborated by a clean 128/128
  targeted run covering every file this round touched, including the normally-flaky
  `sniper.integration.test.js`). New coverage: `tests/config.test.js` (sniper pool alias-by-default,
  configured-and-hidden, malformed-URL, and sniper/fast-pool-independence cases);
  `tests/transactionEngine.test.js` (`performAll` racing/failure-tolerance/all-fail behavior;
  sniper-trigger routing including priority over the fast pool; the timing-event shape and its
  never-persisted guarantee).

### Worklist B — enhancements, after A is stable and shipped

1. Parallelize pre-arm prep (item A3) across multiple pending tasks instead of doing it serially.
2. Dynamic fee strategy presets, beyond the flat gas-multiplier Degen already applies.
3. ~~Sniper profile~~ — subsumed by A7 above; not a separate task.
4. RPC health scoring and fast failover, building on top of the pool split (route around a
   candidate that's been slow/erroring recently, not just retry-then-fallback per call).
5. **Hot wallet session cache — flagged, not defaulted in.** This means caching decrypted key
   material in memory for longer or more accessibly, which is a real security tradeoff, not a pure
   performance win. Deserves the same "checked with the owner directly" treatment Round 14's
   simulation-skip exception got — not something to build as a routine cache the way
   `feeDataCache.js` was.
6. Broadcast telemetry and latency dashboards, visualizing item A6's timing logs.

### Related but explicitly out of scope for this round

Raised in the same conversation (Alchemy also offers NFT APIs) but orthogonal to execution speed —
these are read/reporting capabilities, not write-path work, and stay separate backlog items:
- **Section AD Tier 2** (Top Holders % on the collection info card) — already researched in Round 7:
  OpenSea's holder endpoint is gated (401), Alchemy's `getOwnersForContract` does the job, free
  tier confirmed usable at the time. Still unbuilt, still just needs a "worth doing now?" decision.
- **Section T** (extracting which token ID a mint actually received) — currently unbuilt; Alchemy's
  `getNFTsForOwner` is a candidate alternative to parsing raw Transfer event logs from the receipt.

---

# Round 15 — split RPC traffic into isolated pools (2026-08-20)

## Section AU — Separate RPC/WS endpoints for scheduled+Degen mints, sniper watching, and everything else 🟡

Raised directly as a follow-up to Round 14's speed pass: "if we had different rpc's for different
actions, would performance be improved? and how would you split it between paid and free rpc's?"
— then narrowed to cover scheduled mints, not just the sniper. Scoped against the real config, not
assumed.

**Confirmed today, live against this repo's own config (not guessed):**
- **Every chain has exactly one RPC URL, with zero failover.** `ETH_RPC`/`BASE_RPC`/`POLYGON_RPC`
  are single legacy vars (not the plural `_URLS` form `parseRpcUrls` already supports); Arbitrum and
  Robinhood have **no dedicated RPC configured at all** and silently fall back to a hardcoded public
  default (`arb1.arbitrum.io/rpc`, `rpc.mainnet.chain.robinhood.com`). This is a real gap
  independent of the "split by action" question — right now a single bad endpoint is a hard outage
  for a whole chain, not a fallback.
- **No WebSocket RPC is configured on any chain**, despite `config/index.js`'s `parseWsRpcUrl()`
  and `chainWatcher.js` already fully supporting one (`{CHAIN}_WS` env var). Every sniper watcher is
  therefore stuck on 2.5s HTTP polling (`pollingIntervalMs` in `chainWatcher.js`) instead of
  instant block-push — a real, currently-unrealized latency cost specifically for sniping, where
  the whole point is reacting fast.
- **Scheduled mints, sniper watching, and ordinary manual mints all share the exact same RPC pool
  per chain today.** `ensureChainWatcher` (`server.js:680-683`) reads `CHAINS[chain].rpcUrls`/
  `rpcWsUrl` — the identical config `transactionEngine.js`'s `providerCall` uses for every mint.
  Round 14's scheduled+Degen fast path (tighter timeout, fee-data cache) shares this same pool too
  — it only changed *how patiently* this app waits on the shared endpoint, not *which* endpoint it
  waits on. A sniper watching several chains continuously can still be sharing a rate-limit bucket
  with a scheduled mint that needs to broadcast the instant a phase opens.

**Proposed shape: three pools, not two — the "just sniper" framing undersold it.**
1. **Scheduled + Degen fast path** — low request volume, but the one pool where a slow/rate-limited
   response is most costly (a missed phase-open window). Should get the best available endpoint
   (paid — this app already has an Alchemy key) as primary, with a fallback candidate behind it
   using the *existing* multi-URL failover `parseRpcUrls` already implements — no new failover
   logic needed, just real URLs in a new env var.
2. **Sniper watching** — continuous, high-volume, individually low-stakes (missing one block means
   catching the next one, not a failed mint). Isolating this from pool 1 is the actual point: it
   should never be able to add queueing delay to a scheduled broadcast. Wiring a real WS endpoint
   here (already-built, unused capability) is probably a bigger win than the paid/free question —
   instant block-push vs. 2.5s polling changes sniper reaction time regardless of which tier pays
   for it.
3. **Everything else** (manual mints, `/info`, `/gas`, dashboard preview/confirm, collection cards)
   — today's existing single-pool setup, unaffected. Latency here is already bounded by a human's
   own read-and-tap time; not worth new infrastructure.

### What shipped 2026-08-20: pool 1, scheduled+Degen fast path ✅

Scoped against a real budget decision rather than a guess ("How much do you want to spend on
this?" → "One paid endpoint, for scheduled/Degen only"). Two implementation angles were tried:

- **First built: auto-derive the fast-pool URL from the existing, already-present-but-unused
  `ALCHEMY_API_KEY`** (confirmed live 2026-08-20 that it's referenced nowhere in the codebase, and
  that one key already works across ethereum/arbitrum/robinhood — base/polygon just needed enabling
  as a network on the existing Alchemy app, a dashboard toggle, not a plan limitation; Alchemy does
  genuinely support Robinhood Chain, confirmed via `alchemy.com/rpc/robinhood`). Set aside at the
  owner's direction in favor of the option below, which keeps the provider choice entirely in
  config rather than hardcoding one vendor's URL-naming scheme into the app. The Alchemy variant's
  full diff and live findings are preserved for later in case zero-config auto-derivation is wanted
  as a default that the generic env vars below could still override.
- **Shipped: a generic, provider-agnostic `{ENVNAME}_FAST_URLS` env var per chain**, entirely
  opt-in — matches `parseRpcUrls`' own existing `{ENVNAME}_URLS` pattern exactly rather than
  inventing new parsing. Unset for a chain, `FAST_CHAINS[chain]` is a literal alias for
  `CHAINS[chain]` (`===`, not just equal) — zero behavior change, zero required config. Configured,
  the fast URL(s) are prepended ahead of that chain's own general-pool URLs, so
  `providerService.perform()`'s existing per-candidate retry/fallback already degrades to the
  general pool on a rate limit or outage — no new resilience code needed for that.
- `transactionEngine.js`'s `createTransactionEngine` gained an optional `fastProviderService` param
  (undefined by default — every existing caller/test unaffected). `providerCall`,
  `resolveFeeData`, `estimateGasSafely`, `simulateCallSafely` all gained a trailing
  `service = providerService` parameter; `submit()` computes `activeService` right alongside Round
  14's existing `useFastPath`/`fastRpcOptions` and threads it through every pre-broadcast read.
  `broadcastTransaction`'s own call site was deliberately left untouched (always the general pool),
  matching Round 14's own reasoning that a failed/slow broadcast is costlier to get wrong than a
  failed read. `preview()` (the dashboard's own flow) was not touched at all.
- `server.js` constructs a second `createProviderService({ chains: FAST_CHAINS, ... })` instance
  alongside the existing one and passes it into `createTransactionEngine`.
- Verified: `npm run lint`, `npm run check` (full syntax pass), and the full suite. New coverage in
  `tests/config.test.js` (unconfigured → no fast chains reported; configured → reported without
  leaking the URL; malformed → refused the same way a malformed general URL is) and
  `tests/transactionEngine.test.js` (scheduled mint routes reads through the fast service but still
  broadcasts via the general one; a manual mint never touches the fast service even when one is
  configured; no configured fast service → behaves exactly as Round 14 shipped it).
- A refactor mid-build (extracting shared URL-validation logic) briefly regressed one existing error
  message's exact wording (singular "must be a valid... URL" for the legacy single-value case vs.
  plural "must contain... URLs" for an actual list) — caught by the existing
  `tests/config.test.js` coverage, not missed.

### Not built this round, still open: pools 2 and 3 ❌

- **Sniper watching isn't isolated from the general pool yet**, and still has no WebSocket endpoint
  wired up despite `chainWatcher.js`/`parseWsRpcUrl()` already fully supporting one — every sniper
  watcher remains on 2.5s HTTP polling. `ensureChainWatcher` (`server.js`) still reads
  `CHAINS[chain].rpcUrls`/`rpcWsUrl`, the same pool every manual mint uses.
- Same config shape (`{ENVNAME}_RPC_SNIPER_URLS`/`{ENVNAME}_RPC_SNIPER_WS`) would extend cleanly
  once a provider/budget decision is made for this pool specifically — deliberately not built
  speculatively, same reasoning as before: needs a real answer, not a guess.

---

# Round 14 — speed pass for scheduled mints and Degen mode (2026-08-20)

## Section AT — Scheduler concurrency, fee-data caching, RPC timeout tightening, and a scoped simulation-skip ✅

Requested directly ("the speed stuff should be hardwired into scheduled mints and the degen
setting"), deliberately deferred until the OpenSea build finished. Four independent changes, each
scoped to scheduled and/or Degen-mode mints — a manual mint a human is about to confirm is
unaffected by any of them.

- **Scheduler concurrency was the dominant bottleneck, by far.** `schedulerWorker.js`'s poll loop
  used a single boolean `active` flag to guard `tick()`, but `processTask()` doesn't return once a
  transaction broadcasts — it awaits full on-chain finality, up to `transactionTimeoutMs` (10
  minutes by default) per policy. One slow-confirming scheduled mint therefore blocked every other
  due task behind it, including ones whose own `mint_time` had already arrived — worst case, up to
  10 minutes of pure queuing delay, dwarfing the ~1s poll-interval granularity anyone would assume
  from reading `pollIntervalMs`. Fixed by raising the single-slot guard to a small pool
  (`maxConcurrentTasks`, default 5): `tick()` still fully awaits its own claimed task unchanged (a
  test — `dashboard.test.js`'s `await worker.tick()` — depends on that), the fix only raises how
  many overlapping `tick()` calls the existing `setInterval` loop is allowed to have outstanding at
  once, which it was already structurally capable of.
- **Fee-data caching**: ether's `getFeeData()` fans out to three concurrent RPC legs and was
  fetched fresh on every `submit()`, with no caching anywhere in the codebase. `feeDataCache.js` is
  a short-TTL (5s) in-memory cache, chain-keyed, mirroring `walletBalanceCache.js`'s pattern —
  consulted only when `triggerSource === 'scheduled'` or `policy.gasPriceMultiplier > 1` (Degen's
  own multiplier already doubles as the "is this Degen" signal, no new lookup needed). A second
  scheduled/Degen mint on the same chain within the window skips the fetch entirely; a manual mint
  always gets a live quote, unconditionally.
- **RPC timeout tightening**: `providerService.perform()` now accepts a per-call `{timeoutMs,
  retries}` override, defaulting to the constructor's own settings for every existing caller.
  Scheduled/Degen mints use a 3s/0-retry budget for every pre-broadcast read (fee data, balance,
  gas estimate, simulation, nonce, network check) — a slow primary RPC is abandoned after one quick
  attempt instead of the conservative default (10s × 2 attempts per URL, compounding across every
  configured candidate). The broadcast itself and post-broadcast finality polling deliberately keep
  the conservative defaults — a failed/slow broadcast is far more costly to get wrong than a failed
  read, which just falls over to the next candidate URL regardless of which timeout is in effect.
- **Simulation skip, decided with the owner directly rather than assumed**: Degen's own preset
  already sets `simulation_mode='off'`, but a `simulationForced` safety setting (defaults to `true`
  for every account) was silently overriding that back on — meaning Degen's simulation-skip was
  not actually in effect for any account today unless the owner had separately disabled
  `simulationForced`. Investigated and surfaced this to the owner rather than guessing at the right
  tradeoff: their choice was to add one narrow exception — a mint that is **both** scheduled **and**
  Degen skips simulation regardless of `simulationForced`, since nobody is watching a scheduled
  mint fire and Degen is the account's own explicit signal it accepts more risk for more speed. A
  manual Degen mint keeps its human-at-the-confirm-screen safety net; a scheduled mint on any other
  preset keeps simulation too — scheduling alone was never the trigger.
- Verified: `npm run lint` on every touched file, and the full suite (685 tests, 0 failures) —
  `tests/transactionEngine.test.js` gained coverage for the fee-cache hit/miss/TTL-expiry/per-chain
  isolation behavior and the RPC timeout override; `tests/governance.test.js` gained a case pinning
  the scheduled+Degen exception against three angles (does apply to scheduled+Degen, does not apply
  to manual+Degen, does not apply to scheduled+any-other-preset) so a future change can't quietly
  widen or narrow who it affects.

---

# Round 13 — sequential fix run + the full OpenSea Drops build (2026-08-19/20)

A batch of smaller, independently-requested fixes, worked strictly in the sequence the owner set
("push the mintnow feature and others after testing before you start working on the opensea
stuff... keep it sequential"), followed by the three-part OpenSea Drops build approved as "All
three, in that order." All shipped, tested, and pushed to `origin/main`.

## Section AL — Telegram single-instance polling lock ✅

Root-caused two symptoms that looked unrelated until traced to the same cause: users occasionally
seeing a duplicate "Command failed safely" reply to one command, and a recurring
`ETELEGRAM: 409 Conflict` line in Railway logs. Both come from Railway's rolling deploys — a new
container starts polling before the outgoing one's `stopPolling()` has fully released its Telegram
long-poll connection, so two processes briefly handle the same update against two different
in-memory flow states.

Fixed with a Postgres session-level advisory lock (`pg_advisory_lock`/`pg_advisory_unlock`,
`src/security/telegramSingleInstanceLock.js`), held by a dedicated `pool.connect()`'d client and
acquired before `startPolling()` is ever called. This blocks at the database level with no lease or
expiry bookkeeping needed — if the holding process dies, Postgres releases the lock automatically,
so a crashed instance can't wedge the next deploy. Wired into `createGracefulShutdown`
(`src/security/gracefulShutdown.js`) so `release()` runs after the rest of shutdown, not before.
`tests/telegramSingleInstanceLock.test.js` covers acquisition, idempotent release, and that the
lock genuinely blocks (via a real second connection against a real Postgres in the test DB) rather
than just calling the query once.

## Section AM — Seed-phrase wallet import on both platforms ✅

`/importwallet` only ever accepted a raw private key, despite `validateWalletCreate` already
supporting `importMethod: 'seedPhrase'` underneath — the UI-layer regex was the only thing missing.
Fixed by widening the input regex to `/^\/importwallet(?:@\w+)?\s+(\S+)\s+(\S+)\s+(.+)$/i` and
auto-detecting which kind of secret was pasted: a private key is always one unbroken hex token, a
seed phrase always contains spaces. No new step or UI was needed on either platform — the routing
happens invisibly at the point the input is parsed.

## Section AN — Low-balance alarm gated on sold-out state ✅

A scheduled mint's low-balance warning fired even when the drop had already sold out, which is
misleading (there's nothing left to fund) and wastes the user's attention. `lowBalanceSweep` now
runs `botCommands.detectMintContract` before the balance comparison and, on a sold-out result,
auto-cancels the task via `controlTask(..., 'cancel', ...)` instead of warning.

## Section AO — Real Telegram Tasks menu ✅

`menu:tasks` was a static placeholder. It now lists real scheduled tasks with pagination
(`task:page:`) and per-task actions — manage, cancel (with a confirm step), pause, resume, retry —
each wired through the existing `controlTask` surface rather than a new one.

## Section AP — Discord `/mintnow` ✅

Telegram's one-shot, zero-confirmation mint command ported to Discord, matching its existing
semantics: resolvable contract, one wallet, and a known price mint immediately with no confirm
screen; anything ambiguous (multiple wallets, unknown price, `maxPerWallet > 1`) falls back to the
guided flow instead of guessing.

## Section AQ — OpenSea Drops phase display, `/info` + collection card ✅

The first of the three approved OpenSea pieces. `openSeaService.js` gained `getDrop(chain,
contractAddress)`, reading OpenSea's real per-stage phase data (`GET /drops/{slug}`) — `active_stage`
and `next_stage`, each with `label`, `start_time`/`end_time`, `price` (decimal wei string),
`max_per_wallet`, and `stage_type` — the same data OpenSea's own mint page reads, not something
this app derives from chain state (SeaDrop's on-chain `PublicDrop` struct only ever describes the
*current* live stage, never the schedule of stages before or after it). Surfaced on both `/info`
and the collection info card via new `humanizeStageType`/`stageSummaryLine` helpers in each
platform's `menus.js`. Returns `null` on anything that isn't a tracked OpenSea Drop (a 404, the
overwhelmingly common case) with no error surfaced to the card renderer.

**Live incident, found and closed 2026-08-20:** neither platform was actually showing drop phases
in production — reported directly by the owner. Live-reproduced against real, currently-open drops
(not assumed): every `/drops/*` endpoint returned `401 "Invalid API key"` with this app's
then-current `OPENSEA_API_KEY`, while the exact same key worked fine for `/collections/{slug}` and
everything else this file calls. This means Section AQ *and* Section AR below were shipped on the
strength of unit tests against mocked HTTP only — they were never actually verified against the
live API with this app's real credentials, despite this file's own established discipline of
live-verifying rather than assuming. The root cause was the key itself: OpenSea's docs don't
document any special tier for Drops endpoints, but the old key plainly didn't have that access and
a freshly-generated one did — regenerating the key (owner's own OpenSea account, Settings →
Developer) fixed both `getDrop` and `buildMintTransaction` immediately, live-confirmed against three
real drops (phase data decoded correctly, `buildMintTransaction` correctly threw the intended
`ValidationError`/`Insufficient balance` for a fresh test wallet) with no code changes needed at
all. Recorded here so a future stale-key symptom like this isn't re-investigated as a code bug.

## Section AR — OpenSea-backed minting for allowlist/GTD/FCFS stages ✅

The second piece. `buildMintTransaction(chain, contractAddress, minterAddress, quantity)` calls
`POST /drops/{slug}/mint`, which needs no wallet signature or session — OpenSea's own backend
selects the correct stage and returns ready-to-sign calldata (`{chain, data, to, value}`). This is
the answer to the phase-determinability problem Section AF's shape-2 analysis got stuck on for
allowlist/GTD/FCFS stages: this app was never going to be able to source a per-wallet merkle proof
itself, but it doesn't need to — OpenSea already holds the allowlist and does the proof-checking
server-side, this app just needs to ask.

Calldata returned by OpenSea is executed through the exact same safety pipeline as every other
mint (`executePreparedMint` → `mintExecution.executePrepared` → `transactionEngine.submit`) via a
synthetic `prepared` object (`{chain, calldata, valueWei, method: {signature:
'opensea:drops-mint'}, preview: {...}}`) rather than a separate execution path — governance
ceilings, simulation, and gas-ceiling enforcement all apply unconditionally, unchanged. A 422
response (insufficient balance, not on the allowlist, limit reached, sold out) throws a real
`ValidationError` with OpenSea's own reason; a 409 (drop not currently active — a different,
non-ineligibility condition) throws its own distinct message. Everything else (no key, unsupported
chain, not a tracked drop, network failure, 5xx) returns `null` so the caller falls back to this
app's own on-chain `mintPublic()` calldata path.

Reused the shared `mintFlowDecision.js` core unchanged: a `viaOpenSea: true, priceUnknown: false,
skipConfirm: true, quantity: 1` flag set on flow data routes through the same
`afterQuantity`/`afterWalletSelection`/`afterPriceKnown` functions every other mint uses, just
selecting `botCommands.mintViaOpenSea` instead of `botCommands.mint` at the end. "🎫 Mint via
OpenSea" appears as a button on the collection info card on both platforms when `drop.activeStage`
or `drop.nextStage` is present.

## Section AS — Schedule OpenSea-backed mints to fire when a phase opens ✅

The third piece, requested directly: *"eligibility checks should be done long before phase time so
as to cut down on time wastage. there should also be a button to schedule eligible phases."*
"🎫📅 Schedule for OpenSea phase" reuses the existing `task_guided` scheduling flow unchanged,
pre-filling `mintTime` from `drop.nextStage.startTime` and skipping the price/time steps
(`priceUnknown: false, priceETH: 0`) straight to wallet/name/confirm, since OpenSea's own backend
resolves both at mint time. At execution, `executeTask`'s scheduler callback takes an early branch
for `task.viaOpenSea` that skips this app's own SeaDrop drift preflight (there's no drift to check
— OpenSea supplies live calldata, not a pre-computed one) and calls `buildMintTransaction` +
`executePrepared` directly. `migrations/042_task_via_opensea.sql` adds the `via_opensea` column;
`postgresStorage.js` and `schedulerRepository.js` both carry it through their own `mapTask`.

**Investigated and explicitly rejected: pre-checking eligibility before the phase opens.** The
owner asked directly whether an already-imported wallet's eligibility for an upcoming allowlist
phase could be checked ahead of time, to avoid wasted time at the exact open moment. Live-verified
against `docs.opensea.io` (not assumed from memory): the only endpoint that answers this,
`GET /drops/{slug}/eligibility`, requires a pre-existing **OpenSea account session** for the wallet
being checked — there is no documented way for a third-party server-side API-key integration like
this one to establish that session for an arbitrary end user's wallet (confirmed via
`POST /accounts/wallets/siwx`, OpenSea's own wallet-linking endpoint, which is SIWE-style and
still needs the same session). The mint-build endpoint itself only ever answers "eligible right
now" (or its specific reason for refusing right now) — it has no "will this wallet be eligible
later" mode. A follow-up proposal (using the mint-build endpoint itself as a preflight, read
without broadcasting) was evaluated and doesn't change this: OpenSea's stated 409 for "not active
yet" doesn't distinguish "will be eligible when it opens" from "wallet was never going to be
eligible at all." Net: genuinely a hard external API limitation, not a gap in this app's own
integration — left unbuilt on that basis.

## Also flagged: Discord Settings had no "Transaction mode" button, unlike Telegram's ✅

Reported directly by the owner. Fixed on Discord's `⚙️ Settings` menu, mirroring Telegram's
existing picker (`eb21a47`). Built in parallel by the owner in a separate local session while this
one was occupied with the OpenSea build; the two sessions' work is coordinated, not duplicated —
see `CLAUDE.md`'s note on this repo's shared-workspace concurrency.

## Investigated, not resolved: Discord `/info` returning no response at all 🟡

Reported by the owner with no further detail than "no response at all." Traced the full code path
end to end — every branch, including every catch block, produces a real Discord reply; nothing
found that could silently swallow the interaction. No reproduction. Given the volume of deploys in
the same window, the leading (unconfirmed) theory is a transient Railway rolling-deploy overlap,
the same underlying issue Section AL fixed for Telegram polling — Discord's gateway connection
doesn't have the equivalent single-instance guard. **Not fixed, because the root cause isn't
confirmed** — what shipped instead is defensive logging in `openSeaService.js` (previously every
failure there was silently swallowed with no trace at all), so a recurrence has a chance of leaving
evidence. If this happens again, capture the exact contract/timestamp so the Railway logs for that
window can be checked directly.

---

# Round 12 — bot action gate + import duplicate check (2026-08-20)

## Section AI — Password gate for sensitive bot actions ✅ built, shipped OFF

Requested after the owner found they could remove two wallets from Telegram with no
authentication at all: *"someone else could have just done that... it applies to every other
thing, even checking my balance or exporting my key."* The design was approved before any code
was written, on the owner's explicit instruction.

**It ships disabled for every account and must stay that way** until the owner says the agreed
phrase — **"ghost lock, arm it"** (off again with **"ghost lock, stand down"**). Migration 041
defaults `users.bot_gate_level` to `'off'`, which is what every existing row gets. Approving the
design was deliberately separated from switching it on; do not conflate them.

**Shape**

- One password, three surfaces. Verifies against the same `users.security_password_hash` the
  dashboard has used since migration 036, via `src/security/securityPassword.js` (scrypt +
  `timingSafeEqual`). No second password exists.
- Three levels: `off` (default), `sensitive` (export key, remove wallet, send funds, imports),
  `strict` (adds the read-only surfaces — wallet list, balances, activity).
- An unlock belongs to **one conversation**, not the account: unlocking on a phone must not
  silently unlock a session someone else is looking at. 10-minute window, 5 attempts, then a
  15-minute lockout that refuses even the correct password (otherwise the lockout is decorative).

**Three deliberate refusals**

1. **A password can never be SET from chat.** Setting one would put it in message history
   permanently, which is the exact exposure the gate exists to reduce. An account without one is
   told to use the dashboard and the action stays blocked.
2. **An unclassified action is ungated at every level.** A missing entry can only fail open to
   today's behaviour; the opposite mistake locks someone out of their own wallets.
3. **`getBotGateLevel` swallows its read error and returns `'off'`.** Consulted before every gated
   action — a gate that ships off must never be the reason an owner cannot reach their wallets.

**Honest limitation, stated in the bot copy too:** typing a password into a chat is weaker than
typing it into the dashboard, whatever we do here. Discord verifies through a **modal**, whose
input never becomes a message and never enters channel history — genuinely safer. Telegram has no
modal, so the message is deleted on receipt (the same mitigation already used for private keys)
and the copy says the dashboard remains the safer place rather than implying the gate makes chat
safe.

## Section AJ — Import refuses a wallet already held ✅

Re-importing a wallet already in the account used to succeed silently, leaving two labels for one
address. The check lives in `persistWallet` — the single funnel `createWallet`, `importWallet` and
`importWalletsBatch` all pass through — so the dashboard, Telegram and Discord all get the same
answer without any of them implementing it, which is what the owner asked for ("the logic is for
all, not just one of them").

Matched on **address, not key**: the same wallet reached by a seed phrase and by its private key is
the same wallet. The error names the existing wallet (`is already imported as "my-main" (0x…)`) so
it can be found. A duplicate inside a batch fails only its own entry; the rest still import.

## Section AK — Batch minimum reverted to one ✅

Section AH raised the batch mint minimum to two wallets. The owner reverted that decision after
testing (*"just leave it and accept it like that since it's just burning credit"*).
`MIN_BATCH_WALLETS` is now 1 and a one-wallet batch simply behaves like a single mint. Kept as a
named constant rather than deleted, so the rule can move in one place if that judgement changes
again. The dashboard keeps its own stricter UI gate, which predates this.

---

# Round 11 — guided batch mint + batch import, all three surfaces (2026-08-19)

## Section AH — Batch mint and batch import as guided flows, not JSON commands ✅

Requested directly, outside the redesign phases: *"fully implement batch mint and batch import for
both the site and Telegram and Discord."* Followed by a design correction that set the shape —
batch must be reachable by **clicking**, not by knowing a command exists, and must let you add
inputs one at a time rather than hand-writing JSON. Discord was named the priority, then Telegram.

Both operations already existed as JSON slash commands (`/batchmint {...}`, `/batchimport {...}`)
and, on Telegram, batch mint already had a full guided flow behind `/batch` — with a working
multi-wallet toggle picker. **None of it was reachable from a menu.** That was the actual gap on
both platforms: the Mint button went straight into a single-wallet flow, and Wallets offered only
single-key import.

**What shipped**

- **Mint forks into single or batch** on both platforms (`mintModeMenu` in each menus module).
  The flow underneath is unchanged — it is the same guided flow, started with `multi` true or
  false — so batch inherits the wallet multi-select, the gas-tolerance step and the confirm screen
  it already had.
- **Guided batch import** on both platforms, keys added incrementally:
  - *Discord*: a paragraph modal, an `➕ Add more keys` button that reopens it, and a running
    tally. Each submission appends rather than replaces.
  - *Telegram*: no modals, so **each message is an add** — send keys one per line, several per
    message, or across several messages; the card re-renders with the count after each one.
  - Keys are split on any whitespace or comma, so they paste from wherever the user had them.
  - The card **never echoes keys back**: both platforms keep chat history, and repeating them
    would put every key back on screen.
  - Telegram deletes the user's key message on receipt, as the single-key import already did.
- **The 50-key cap is enforced when keys arrive, not at import.** `importWalletsBatch` rejects an
  over-cap list wholesale, and the card offers no way to remove a key — so an over-cap list was a
  dead end whose only exit was Cancel. Keys past the cap are now dropped as they arrive, with the
  card saying how many and why, and the 50 that fit stay importable.

**Two real defects found and fixed while building this**

1. **`batchMint` aborted the whole batch on the first wallet that threw** — `results.push(await
   mint(...))` in a bare loop. This is the worst possible shape for this operation: the wallets
   *before* the failure had already broadcast real transactions, and the caller got an exception
   carrying no txHash and no way to learn that a mint had gone out. Logged as a known limitation in
   Section AE and fixed here: every wallet is attempted, each result names its wallet and carries a
   state, and a failed one reports why. `/batchmint`'s reply has always rendered per wallet with a
   `state === 'failed'` branch — that branch was simply unreachable until now. Request-wide
   problems (unsupported chain, bad contract) still throw, since retrying them once per wallet
   would turn one mistake into N identical failures.
   The dashboard was never affected: it does not call `batchMint` at all, going through
   `previewMint`/`confirmMint`, whose per-wallet try/catch already cited `importWalletsBatch` as
   the model to follow. `batchMint` was the one path that had not.
2. **Discord's Import button was never actually disabled.** `button()`'s 4th parameter is `emoji`;
   the disabled flag was being passed there, which set `emoji: true` — a shape Discord rejects for
   the whole component payload — and left the button live with nothing to import. `disabled` is now
   its own 5th parameter.

The guided-flow reply for batch mint changed on both platforms as a consequence of (1): it reported
`Batch complete: N wallet transaction(s)`, which would have described a batch where half the wallets
never minted as an unqualified success. It now reports `N of M submitted` with a line per wallet.

**Still open**

- Discord's `/batch-mint` and `/wallet batch-import` slash commands, and both Telegram flows, are
  covered by unit tests but have not yet been exercised against the live bots.
- Discord still has no mint presets at all — a separate parity gap, unrelated to batch.

---

# Round 10 — dashboard redesign (2026-08-17)

## Section AG — Dashboard redesign ⏳ specified, not started

Design work is complete and lives in `docs/REDESIGN_BRIEF.md`, `docs/REDESIGN_PROMPT.md`,
`docs/REDESIGN_DATA_CONTRACT.md` and the prototype `docs/ghostmint-redesign-v3.html`. The redesign
itself is presentation-layer only (`dashboard/src/**`) — no route, request/response shape, or
validation schema changes.

Writing the data contract surfaced work the redesign **cannot** do, because it would require
`src/**` changes. Each item below was deliberately deferred, with the UI built in its honest
degraded form in the meantime.

1. **`GET /api/admin/health` is unreachable.** Registered in `src/server.js` after
   `app.use('/api', …404)`, so it always returns "API route not found". The admin System health
   panel has no data source. **One-line fix: move the route above the catch-all.** Reproduced; see
   `PROJECT_REVIEW_2026-08-17.md` §1.3.
2. **No `GET /api/profile/limits`.** A regular user cannot see their own spend ceiling or how much
   of today's budget they've used, so the daily-budget meter was cut from the redesign (contract
   §5.1). Would return
   `{maxTransactionValueWei, dailySpendingBudgetWei, spentTodayWei, gasCeilingGwei}`.
   **Blocked on item 3** — do not surface `spentTodayWei` until it is correct.
3. **`rollingSpendWei` under-counts by the full transaction value.** It sums
   `COALESCE(actual_network_cost_wei, estimated_cost_wei)`, but the actual column holds gas only,
   so a confirmed transaction's mint value drops out of the 24h total. The daily budget does not
   currently hold. Highest-severity item in the review; see `PROJECT_REVIEW_2026-08-17.md` §1.1.
4. **No dashboard routes for `triggerAudit`, `send`, or `transactionsPage`.** All three exist in
   `botCommandService` and are reachable from Telegram/Discord only. History → Audit evidence and
   Wallets → Send both ship as explanatory panels pointing at the bots (contract §5.11, §5.10).
   `send` is a value-moving path and deserves its own review rather than being added alongside a
   restyle.
5. **`pnl_records` has no wallet column**, so per-wallet performance cannot be computed —
   Performance is account-level in the redesign (contract §5.9). Also `activity` has no chain or
   mint-value column, so the activity feed shows gas only and derives its chain dot from the
   explorer URL (contract §5.8). Bundles naturally with Section T (extract token IDs from mint
   receipts), which is the same missing-provenance problem seen from the bot side.
6. **No historical balance data anywhere**, so the portfolio 7-day delta and sparkline were cut
   (contract §5.4). Would need a periodic balance snapshot.
7. **Admin has no volume metric.** `getAdminOverviewMetrics` returns account counts only — no ETH
   volume, no mint count. The tile now shows `activeAnyPlatform24h` instead (contract §5.2).

Two further items were settled while auditing the live deployment on 2026-08-17:

8. **The mobile layout exists in only two of the five themes.** `.mobile-bottombar` and
   `.more-sheet` are `display:none` globally and re-enabled only under `ghost-mint` /
   `ghost-mint-light`; `App.jsx`'s `RAIL_THEMES` holds the same two. Clean Vault, Neon Arcade and
   Quiet Ledger therefore have no bottom bar, no More sheet, and no mobile grid collapse — and
   Admin has no mobile nav at all in those three. The redesign deliberately targets Light and Dark
   only (brief §9.1-D15); restoring the other three is logged as brief §9.2-O10.
9. **Railway's `SUPPORTED_CHAINS` did not match this repo's documented list — fixed 2026-08-20.**
   `CLAUDE.md` records `ethereum, base, arbitrum, polygon, robinhood`; production's live var had
   drifted to `ethereum, sepolia, robinhood` at some point, missing `base`/`arbitrum`/`polygon` and
   still carrying `sepolia` (which Section AF deliberately removed from user-facing surfaces, a
   change that can't take effect while the env var still includes it). Surfaced by a real Discord
   `/mint` report — an OpenSea link on one of the missing chains resolved via OpenSea but then
   failed chain-detection with "not found on any supported chain." The owner corrected the variable
   directly in the Railway dashboard; verified live via the Railway GraphQL API (see item 10 below)
   that the running production deployment now carries the full five-chain list and the most recent
   deploy (`d24ffdcd`, 2026-08-20T08:57 UTC) is `SUCCESS`.
10. **This app can now read/write Railway config directly, via a workspace-scoped API token the
    owner created (Account Settings → Tokens → workspace, not "No workspace").** `RAILWAY_TOKEN` in
    `.env` (gitignored). Auth is `Authorization: Bearer <token>` against
    `https://backboard.railway.com/graphql/v2`; the `me` query only works with an *account* token,
    not a workspace one — use `projects { edges { node { id name } } }` to enumerate, then
    `project(id)`/`variables(projectId, environmentId, serviceId)` to drill in. GhostMint's
    production service lives in project `radiant-consideration`
    (`2d0ca629-63f4-4dcb-a29a-a6c3f3e087e5`), service `GhostMint-Bot-2`
    (`5a72c996-cd2b-4f70-965a-10cb22c8d61c`), environment `production`
    (`0a771389-b0b3-4035-8970-41b795d668e4`). No Railway CLI auth path worked for this token
    (`whoami`/`status` both rejected it) — the raw GraphQL API is the reliable path, not the CLI.

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

### Refinement (Round 22, 2026-08-21) — show every OpenSea phase, schedule any of them ✅

Separate from shapes 1/2 above: Section AR (Round 13) later gave `collectionInfoCard` real,
non-manual phase data via OpenSea's own Drops API (`drop.activeStage`/`drop.nextStage`/`drop.stages`),
and let "Schedule for OpenSea phase" pre-fill a task from it with no proof or manual entry needed.
Live user report: "it only shows the next phase. all phases should be shown and i should be able to
schedule a phase of my choice" plus "opensea doesnt always have 3 stages. some might have more than
3" — the card only ever showed OpenSea's own `activeStage`/`nextStage` convenience pointers (at most
two of potentially many stages), and the schedule button was hardcoded to `nextStage` specifically,
with no way to reach any other upcoming phase. Also flagged as "jam packed" -- verbose per-phase
lines and a full ISO timestamp with seconds.

**Fixed.** Source of truth switched from `activeStage`/`nextStage` to every entry in `drop.stages`,
classified against the current time (ended/live/upcoming) rather than trusting OpenSea's own two
pointers to be exhaustive. `collectionInfoCard` now lists every stage (capped at 10 lines, with an
overflow note) instead of at most two, in a shorter format (`Aug 21, 12:56 GMT+1`, no seconds --
`formatGmtPlus1` itself was shortened, benefiting the existing Opens/Opened line too). New shared
`schedulableStages`/`afterScheduleViaOpenSeaTap` in `src/mint/mintFlowDecision.js`: a single
upcoming stage still schedules itself directly (zero behavior change from before this round, and
the existing test fixture for it needed correcting -- it had `nextStage` set but `stages: []`,
unrealistic against a real OpenSea response where `nextStage` is always also an entry in `stages`);
more than one shows a new picker screen (`openSeaPhasePicker` on both platforms -- a select menu on
Discord, one button per stage on Telegram) so the user picks which phase, not just whichever one
OpenSea calls "next." The picker's option `value`/`callback_data` carries the stage's *index* into
`drop.stages`, not its OpenSea `uuid` -- a 36-char uuid would blow past Telegram's 64-byte
`callback_data` budget alongside the handler's own prefix, the same reasoning the existing
`flow:phase:<n>:<address>` button already relies on.

Also fixed in the same pass: "Mint via OpenSea" and "Schedule for OpenSea phase" were wrongly
mutually exclusive (an `if/else if` added by this session's own earlier Discord row-limit crash
fix) even though a stage can be live right now *while* a separate stage is upcoming later -- both
actions are genuinely useful at once. They're independent again; the Discord worst case (Mint Now +
Mint via OpenSea + Schedule for OpenSea phase + utility row + Cancel) is exactly 5 rows, still
inside the cap, pinned in `menuShape.test.js`.

### Follow-up (same day) -- drop the manual naming step for OpenSea-backed schedules ✅

Live-reported immediately after the above shipped: "the last name stuff for schedulers should be
removed because you can now actually schedule for phases." The manual "name this task"
GTD/FCFS/PUBLIC/custom quick-pick step (`TASK_NAME_QUICK_PICKS`) existed because nothing on-chain or
via any API said which real phase a scheduled task was for -- the user had to guess/type a label
themselves. That's no longer true for the OpenSea-backed path specifically: the actual stage (direct
or picked) now carries its own real label.

Fixed: `openSeaPhaseTaskData` (both platforms) now sets `name: stage.label || humanizeStageType(stage
.stageType)` -- the same label/fallback `collectionInfoCard`'s phase list and the picker already use,
now exported from both `menus.js` files for this purpose. Telegram's `advanceFromTaskWallet` and
Discord's `advanceFromTaskQuantity`/`flow:taskwallet:select` handler skip `awaiting_name` entirely
and go straight to `awaiting_confirm` whenever `data.viaOpenSea && data.name` -- every other
scheduling path (manual `/schedule`, the "Add phase N" shape-1 flow) is unaffected and still asks,
since those genuinely still can't know the phase automatically (see Section AF's own phase-
determinability research above, unchanged). Discord gained a small `taskConfirmPayload` helper so
the two new skip-to-confirm call sites and the existing `flow:taskname:select` handler all render
the confirm screen identically.

### Follow-up (same day) -- cancel button missing from the post-schedule success screen ✅

Reported live: "after a mint is scheduled, theres no cancel schedule button." Telegram's
`taskScheduled` success screen offered Add phase / See all tasks / Back to base but no way to undo
the very schedule it was just confirming (the cancel action existed, just only reachable via
`/tasks` afterward). Discord's gap was larger: `finishTaskScheduleDiscord`'s success message had
only "Back to menu," and Discord had **no button-based task cancellation anywhere** -- `tasksMenu`
is a read-only list, and the only way to cancel was the raw `/task cancel <id> <confirm>` command.

Fixed: Telegram's `taskScheduled` gained an `id` param and a `❌ Cancel this schedule` button
reusing the existing `task:cancel:ask:<id>`/`task:cancel:do:<id>` steps `tasksMenu`/`taskActions`
already have -- a freshly created task is always in the `scheduled` status, so no cancellability
check is needed here the way `CANCELLABLE_TASK_STATUSES` gates it elsewhere. Discord needed the
handlers built: new `confirmCancelTask` menu function (mirrors Telegram's), and two new standalone
handlers (`task:cancel:ask:`/`task:cancel:do:`, not part of any flow) sharing the exact same
`commands.tasks`/`controlTask` calls Telegram's version uses. Deliberately scoped to just the
success-screen button, not a full port of Telegram's `tasksMenu`/`taskActions` button surface to
Discord -- that remains the larger, still-unbuilt Section S gap.

### Follow-up (same day) -- OpenSea-backed scheduling couldn't ask for a quantity ✅

Reported live: "when scheduling for phases, i can't select how many i want to mint." Both
`flow:scheduleviaopensea` (direct) and `flow:scheduleviaopenseaphase` (picked) called
`advanceFromTaskQuantity` with a hardcoded `quantity: 1`, unlike `flow:schedulesuggest`'s own
re-detection branch, which already checks `maxPerWallet > 1` and shows a quantity selector first.
The OpenSea path simply never carried `maxPerWallet` into its task data at all, so there was nothing
for it to branch on even if it had checked.

Fixed: `openSeaPhaseTaskData` now threads `maxPerWallet` through from the mint flow's own detected
value. New `advanceFromTaskDetails` (Discord; Telegram already had one from the regular schedule
flow, reused as-is) replicates `mintFlowDecision.afterDetails`' shape: `maxPerWallet > 1` shows
`awaiting_quantity` first, otherwise defaults to 1 same as before. Discord's existing
`flow:schedulesuggest` handler now calls the same shared helper instead of its own inlined copy of
the same check, removing a duplicate.

### Follow-up (same day) -- auto-derived names now lead with the collection ✅

Live-reported: "you can actually schedule phases now [so] the task names should inherit the name of
the phase & collection in an easy to remember way." The phase-only name from the previous follow-up
("Public sale", "Allowlist") is ambiguous once more than one collection has a task staged --
`/tasks`/`/task list` had no way to tell them apart without opening each one. `openSeaPhaseTaskName`
(both platforms) now builds `"<collection> — <phase>"` when OpenSea has a collection name for the
contract, falling back to the phase name alone otherwise (an untracked or unnamed collection),
same "unknown is fine" convention the rest of this card already follows.

### Follow-up (same day) -- Discord notifications showed raw HTML tags instead of formatting ✅

Live-reported, with a screenshot: a Discord DM read "❌ Scheduled mint <b>PUBLIC</b> failed." with
the tags shown literally. Root cause: every `notifyUser` message (scheduled-mint success/failure,
sold-out auto-cancel, trigger confirmations, sniper alerts) is built once as Telegram HTML
(`escapeTelegramHtml` + `<b>`/`<code>` markup) and fanned out unchanged to every linked platform by
`notificationService.sendToUser` -- correct for Telegram (sent with `parse_mode:'HTML'`), but
Discord has no HTML parser at all.

Fixed at the single choke point every Discord DM passes through (`sendDirectMessage`, confirmed via
grep to have exactly one caller): new `src/notifications/discordMarkdown.js`
(`telegramHtmlToDiscordMarkdown`) converts the small, fixed set of tags these messages actually use
(`<b>`, `<code>`, `<i>`, `<pre>`) into Discord markdown, then reverses `escapeTelegramHtml`'s own
entity-escaping (`&amp;`/`&lt;`/`&gt;`) -- those were only ever needed to keep dynamic content (task
names, error text) safe inside Telegram's HTML parser, and Discord doesn't decode HTML entities
either. Tags convert before entities decode, so a task literally named `<b>` round-trips to literal
text on Discord, not a stray unmatched delimiter. 5 new tests.

### Follow-up (same day) -- dashboard admin writes silently corrupted on a blank field ✅

Live-reported: the dashboard's "Advanced mode access" form (and, per the user, "other admin stuff
too") appeared to do nothing when submitted. Root cause, found by testing the real write pipeline
directly rather than guessing: `adminInput` (`src/dashboard/api.js`) joins every dashboard form field
into one whitespace-separated string (the same shared syntax Telegram/Discord's own `/admin` text
command produces), which `adminCommandService.execute` then re-splits on `/\s+/`. A field containing
internal whitespace was already guarded against (a prior regression fix) -- but a genuinely **blank**
field passes that check trivially (there's no space to find in `''`), and `split(/\s+/)` collapses
consecutive whitespace, so the blank vanishes from the token stream and every field after it silently
shifts one slot to the left. Confirmed live: leaving "Platform user ID" blank put the literal string
`"inherit"` (the *next* field's value) into `platformUserId` and left `advancedModesAllowed`
`undefined` -- the write didn't fail, it silently applied to the wrong target with a garbled value.

Fixed: `adminInput` now rejects any blank/missing required field immediately, naming the actual
field, the same way the existing space-guard does. One field genuinely needed to accept blank as
"leave this alone" (`group-retention`'s `retentionPeriodDays`/`requireRecentActivityDays`, per the
form's own "leave as 'off' to disable" note) -- `durationDays` (suspend) already substituted a real
sentinel client-side before this ever mattered; the retention form gained the same pattern
(`retentionSubmit`) instead of relying on `formWrite`'s generic pass-through. 2 new regression tests
(matching the existing space-in-a-field test's shape) plus 2 pre-existing test fixtures fixed --
they'd always submitted incomplete bodies for `group-set`/`preset-set`, silently tolerated before
this fix since nothing validated field completeness at all.

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

## Section T — Extract token IDs from mint receipts 🟡

`osnm-z-main/src/nft.rs`'s `extract_minted_assets()` parses `receipt.logs` for the ERC-721
`Transfer` and ERC-1155 `TransferSingle`/`TransferBatch` events, filtered to `from == 0x0`,
`to == wallet`, on the target contract, and decodes the minted token ID(s). Confirmed as blocker #1
in this file's own deferred P&L sales-detection note under Section G + K: "no token ID is captured
from a mint receipt today" — `inspectChain` only ever read `gasUsed`/`gasPrice`/`blockNumber`.

**Shipped: the capture-and-persist piece.** New `src/transactions/mintReceiptTokens.js`
(`extractMintedTokenIds`) — pure function, parses `receipt.logs` for `Transfer`/`TransferSingle`/
`TransferBatch`, filtered to `from === zero address` (a genuine mint) landing on the wallet that
submitted the transaction, **on the contract that was actually minted** (`intent.callPreview
.contractAddress`) — deliberately never the transaction's own `to`, which for a SeaDrop mint is the
SeaDrop core/router, not the NFT contract; only the NFT contract itself ever emits `Transfer` for
its own tokens. A malformed/unrelated log is silently skipped, same "augment a receipt that already
confirmed, never fail one" philosophy the existing `gasUsed`/cost computation already follows.
Wired into `transactionEngine.js`'s `inspectChain` (computed once alongside the existing
`receiptCost`, only carried on the final `'confirmed'` state — no point re-persisting on every
`'pending'` reconciliation poll before the state settles). New `token_ids TEXT[]` column on
`transaction_intents` (migration `046_intent_token_ids.sql`, `ADD COLUMN IF NOT EXISTS`, purely
additive), threaded through `intentRepository.js`'s `transition()`/`mapIntent` the same way
`gasUsed`/`effectiveGasPriceWei` already are.

Verified: `node --check` + `npx eslint --max-warnings=0`, clean. 11 new tests in
`tests/mintReceiptTokens.test.js` (single/batch ERC-721, ERC-1155 single/batch, non-mint transfers
ignored, wrong-recipient ignored, a log from a different contract than the one minted correctly
ignored — the exact "never trust the tx's own `to`" case — malformed logs skipped not thrown,
deduplication, and the missing-input/no-logs cases), plus the full existing transactionEngine/
scheduler/sniper suite (79 tests) unaffected. Migration applied to and verified against the real
dev database (`transactionEngine.integration.test.js`/`storage.integration.test.js` both still
pass with real DB writes through the updated `transition()` SQL). **Still needs the migration
applied to production** before this actually starts capturing anything there — flagged, not done
by this session without a separate go-ahead, same as every other production infrastructure change.

**Not done, and deliberately out of scope for this pass:** actually wiring captured token IDs into
`activity`/`pnl_records` (neither has a `token_id`/`contract_address` column yet) or building the
OpenSea per-token sales-lookup this was always meant to feed — those are the other two blockers the
original G+K note names, real separate pieces of work, not something this pass claims to close.

## Section U — Validate mint calldata before signing, not just before broadcasting ✅

`osnm-z-main/src/opensea.rs`'s `validate_stage_calldata`/`validate_mint_transaction` decode the
ABI words of any externally supplied calldata (contract address, minter, quantity, selector) and
cross-check them against what was actually requested, rejecting anything that doesn't match,
before it's ever signed.

Investigated first, confirmed a real gap: GhostMint's own in-house calldata builders
(`buildSeaDropMintCall`/`buildMintCall`) encode already-validated arguments through a known ABI
fragment — decoding that back to "verify" it would be a tautology, correctly out of scope. But
OpenSea's own `POST /drops/{slug}/mint` response (`openSeaService.js`'s `buildMintTransaction`) —
calldata it constructs itself and hands back — was signed and broadcast entirely as OpenSea
supplied it, with nothing decoded or cross-checked against what the user actually asked to mint.
Both real call sites (`executeMintViaOpenSea` in `src/server.js`, and the scheduler's own
`task.viaOpenSea` execution branch) built `prepared` straight from `built.data`/`built.to`.

**Fixed:** new `validateOpenSeaMintCall({ built, contractAddress, quantity })` in
`src/mint/seaDropCall.js`, reusing the already-written-but-previously-unused
`decodeSeaDropMintCall` rather than a second decoder. Checks the two facts that are unambiguous
either way — the NFT contract actually being minted (`nftContract` from the decoded calldata must
equal what was requested) and the quantity — and throws a `ValidationError` if either doesn't
match, before signing. **Deliberately does not check `minterIfNotPayer`/`feeRecipient`**: OpenSea's
exact encoding for "payer is minter" (zero address vs. an explicit wallet address) isn't confirmed
against a real live response, and a wrong guess there would reject legitimate mints rather than
just catch bad ones — narrower-but-certain over wider-but-guessed on a path that signs and spends
real funds. Wired into both real call sites; OpenSea's eligibility *decision* (which this app has
no independent way to verify — the whole reason this feature exists) stays trusted exactly as
before, only the mechanical shape of the response is now checked.

Verified: `node --check` + `npx eslint --max-warnings=0`, clean. 4 new tests in
`tests/seaDropCall.test.js` (accepts a match; rejects wrong contract; rejects wrong quantity;
rejects non-`mintPublic` calldata entirely), plus the full existing SeaDrop/OpenSea/scheduler/
botCommandService suite (120+98 tests across the touched areas) still passing unchanged — none of
it exercises `server.js`'s real `executeMintViaOpenSea`/scheduler `task.viaOpenSea` branch directly
(that layer has no integration-test harness in this repo, same gap noted for Telegram's guided-flow
orchestration elsewhere in this file), so coverage lives at the `validateOpenSeaMintCall` function
level, where the actual logic is.

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

## Section Z — Bounded response reads and selective retry for external HTTP calls ✅

`osnm-z-main/src/opensea.rs`'s `read_limited_body` hard-caps response size to avoid unbounded
memory growth from a malformed/oversized response, and `is_retryable_request_error` retries only
429/5xx/408/409/425, failing fast on everything else. Needed confirming `openSeaService.js`/
`priceFeedService.js` don't retry indiscriminately or buffer unbounded response bodies.

**Retry half: nothing to fix.** Grepped every outbound-HTTP file in `src/` for retry/backoff
logic — none exists anywhere in this codebase. Every external call (OpenSea, Etherscan, price
feed, social adapters) either succeeds, throws, or is caught and returned as a typed error to the
caller. No indiscriminate-retry problem to have.

**Body-size half: fixed.** `axios` has no default response-size cap — a malformed or malicious
response (or a misbehaving `scraper` watch-rule target, since that one fetches an arbitrary
user-supplied URL) could buffer an unbounded body into memory. Added `maxContentLength: 1_000_000`
(1MB — every real response these calls expect is JSON on the order of KB) to every bare `axios`/
`http.get`/`request()` call in the app that didn't already have a cap:
`openSeaService.js` (all 7 call sites — collection slug/details lookups, stats, drop data, mint-tx
build), `priceFeedService.js` (`getUsdPrice`), `seaDropDiscoveryService.js` (`viaEtherscan`'s
`eth_getLogs` call), `etherscanGasService.js` (`gasoracle` lookup), and `social/adapters.js`'s
`createHttpAdapter` (covers `official_api`/`managed_service`/`scraper` — the last being the one
with a genuinely untrusted, user-configured target URL, the highest-risk case in this list).

Verified: `node --check` on all five files, clean. No existing test in this repo asserts on axios
call options for any of these five services (confirmed by grep before editing), so nothing broke;
the full suites covering all five (`seaDropDiscoveryService.test.js`, `gasService.test.js`,
`socialWatch.test.js`, `socialWatch.integration.test.js`, `socialUsage.test.js` — 33 tests) still
pass unchanged.

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

## Section O — Button ⇄ command parity ✅

Every UI button must do exactly what its `/` command does, sharing the same code path rather than
a parallel implementation. Round 1 fixed two of these (Telegram's Gas and Transaction mode buttons
now act directly, calling the same `botCommands.gas()` / `selectMode()` the commands use). Two
follow-ups closed out the rest:

- `menu:gas` (Discord) now performs the lookup directly (`discordMenus.gasMenu`, mirroring
  Telegram's `gasMenu` shape — Safe/Standard/Fast readout plus chain-switch buttons,
  `gas:chain:<chain>`).
- `menu:activity` (both platforms) shows page 1 directly via the same `botCommands.activityPage()`
  `/activity` uses, with Prev/Next paging buttons (`activity:page:<n>`).
- `menu:mint` (Discord) opens a modal for the one field a mint genuinely can't avoid being free
  text — the contract address — then routes through the same `startMintGuidedFlow` a bare paste and
  `/mint`'s under-specified path already use, rather than a separate implementation.
- `menu:tasks` (Discord) and `menu:snipers` (both platforms) now list directly via the same
  `botCommands.tasksPage()` / `botCommands.snipers()` calls `/task list` and `/sniper list`/
  `/snipers` already use (Telegram's `menu:tasks` already had a real "Schedule mint" action from
  Round 1, so it was never on the placeholder list).
- `menu:admin` (both platforms) is the one exception to "mirror the command exactly": `/admin`
  itself is a write-only dispatcher over 20+ owner actions with no single read to mirror, so this
  instead surfaces `governance.dashboardOverview` (already built for the web dashboard, already
  owner-gated) as a metrics + per-group-ceiling summary —
  `src/governance/adminOverviewFormat.js` is the one shared wei→ETH formatter both platforms'
  renderers use, so they can't drift on how a null ceiling ("no ceiling") is worded.

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

Always overlapped with Section R (sniper contract-open detection) — both want a poller watching
chain state and firing a notification/action off the same watcher abstraction — so scoped and
written up together under Section R below rather than duplicated here; see Section R's own "Section
P — watch a specific wallet's transactions" write-up.

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

## Section R — Sniper guided config + contract-open auto-detection 🟡

Carried over from Round 1, the largest single item — scoped into phases 2026-08-20 rather than
built all at once (contract-open detection and Section P's tx-watching each need their own
architecture decision, and are real, separate pieces of work from the guided-creation gap).

### Phase 1 — guided sniper-creation flow (copy-mode), both platforms ✅

Before this: Telegram had **no way to create a sniper at all** (only `/updatesniper <id>
<patch-json>` to patch one that already exists, and a read-only `/snipers` list); Discord's only
path was `/sniper create input:<json>`, one free-text option holding a hand-typed JSON blob.
Against the *existing* copy-mode sniper schema only — no new DB migration, no new sniper fields.

- **New shared decision core**: `src/sniper/sniperFlowDecision.js` — pure `{step, data}` functions
  mirroring `mintFlowDecision.js`'s auto-skip shape (skips the wallet-pick step when the user owns
  exactly one), not `watchRuleFlowDecision.js`'s flat field-list walker, since this flow needs
  conditional skipping the same way `mint_guided` does. Also exports `DEFAULTS`, mirroring
  `validateSniper`'s own `??` fallbacks (`maxGasGwei: 200`, `maxValueETH: 0.1`,
  `dailySpendingCapETH: 0.25`) so both platforms' "here's the default" text reads from one source.
- **Correction made mid-scoping**: the flow's second field is a **wallet address to copy from**
  (`targetAddress`), not a contract — copy-mode snipers watch a target wallet and mirror whatever
  it does, they don't target a mint contract at all.
- **Scope, deliberately**: only asks for what `validateSniper` has no default for (`label`,
  `targetAddress`, `chain`, `walletLabel`) plus one combined fee-tolerance-and-caps step
  (`maxGasGwei`/`maxValueETH`/`dailySpendingCapETH` — accept all three defaults in one tap, or set
  your own). Everything else (`valueMode`, `gasBoostPercent`, `cooldownMs`, `maxAttempts`,
  contract allow/deny lists, `sourceConfirmations`) stays default-only in this flow, same scope
  line `mint_guided`'s own gas-tolerance step already draws against the rest of governance config —
  editable later via the existing `/updatesniper`.
- **Telegram** (`src/server.js`, `src/telegram/menus.js`): new `sniper_guided` flow, started from a
  new "➕ Create sniper" button on `sniperMenu` (mirrors how `watch_guided` starts from
  `watchRulesList`'s own Add button, not a slash command). Steps: label → target (free text, both
  inlined in `renderFlowStep` the same way `watch_guided`'s `awaiting_name` already is) → chain (new
  `sniperChainSelect`, a real per-chain button grid reusing `gasMenu`'s `chunk(items, 3)` pattern —
  deliberately *not* the wallet-import `chainPicker`, which collapses to EVM/Solana and would be
  wrong here since the chain determines which chain's watcher/RPC pool ends up watching the target)
  → wallet (existing `walletPicker`, auto-skipped for a single wallet) → tolerance (new
  `sniperTolerancePrompt` accept/customize; customizing walks the three fields one at a time,
  `awaiting_tolerance_gas/_value/_cap`, the same free-text-with-a-default-hint shape
  `watch_guided`'s `awaiting_config` already uses) → confirm (new `sniperConfirmation`) →
  `botCommands.createSniper(...)`.
- **Discord** (`src/discord/discordBot.js`, `src/discord/menus.js`): `sniper:create:start` button →
  one combined modal for label+target (new `sniperDetailsModal` — two fields in one modal, not two
  modals, since a modal can only be opened from a button/select interaction, never chained directly
  off another modal's own submit — the same constraint `watchConfigModal`'s existing comment
  documents) → `chainSelect`/`walletSelect` (existing, reused as-is) → tolerance (new
  `sniperTolerancePrompt` accept/customize button pair; customizing opens `sniperToleranceModal`,
  three optional numeric fields with the default shown as each one's placeholder) → confirm (new
  `sniperConfirmation`) → `commands.createSniper(...)`.
- Verified: `node --check` + `npx eslint --max-warnings=0` on every new/touched file, all clean.
  New tests: `tests/sniperFlowDecision.test.js` (7, pure decision-core unit tests),
  `tests/discordSniperFlow.test.js` (7, full integration coverage — happy path, wallet auto-skip,
  invalid target address, tolerance customize with a blank field falling back to its default,
  negative/non-numeric tolerance rejection, a `ValidationError` from `createSniper` surfacing
  plainly instead of throwing), plus new render-function coverage in `tests/telegramMenus.test.js`
  and `tests/discordMenus.test.js`. Every existing Discord/Telegram menu and flow test still passes
  unchanged (152 Discord-side, 54 Telegram-menu-side). No live Telegram/Discord click-through from
  here (no real bot session) — flagged rather than claimed, same as Section M's own verification
  note; Telegram's guided-flow orchestration in `server.js` has no integration-test harness in this
  repo at all (not even `watch_guided` does — only its render functions and the pure decision core
  are unit-tested), so this is at parity with the existing precedent, not a regression in rigor.

### Phase 2 — contract-open auto-detection, still open ❌

A new `sniper_mode`/`trigger_mode`-style field (needs a name distinct from the existing
`value_mode` field, which already uses the literal string `'copy'` for a different axis — a real
naming trap flagged during scoping) and, for the `contract_open` mode, a poller on
`PublicDrop.startTime` (SeaDrop — reuse `seaDropDiscoveryService.resolve()` +
`seaDropPublicDropResolver.getPublicDrop()`, already used exactly this way in
`schedulerWorker.js`'s own drift-check) or a `paused()`/`saleActive()` getter for a non-SeaDrop
contract (genuinely new code — no existing getter-probe to mirror beyond
`contractValueResolver.js`'s general "probe, treat revert as unknown, never throw" philosophy).
Firing plugs into the same `transactionEngine.submit({triggerSource: 'blockchain', ...})` path
`sniperService.execute()` already uses, so Round 16's dedicated sniper RPC pool, fast-path
timeouts, and Degen's blockchain-simulation-skip all apply automatically with no new plumbing.
Recommended extension point: `server.js`'s existing per-chain `onBlock(chain, blockNumber,
provider)` (the same function `chainWatcher`'s sniper detection already runs through) — one extra
provider call per relevant block per watched contract, gated by the sniper RPC pool, rather than a
second parallel poller.

### Section P — watch a specific wallet's transactions, notification-only — still open ❌

"Watch a specific transaction tied to a wallet address, notify on occurrence/state change" reads,
on closer inspection, as sniper's own copy-detection (matching `tx.from === targetAddress` per
block via the same `onBlock`/`chainWatcher` infra) minus the copy-execution step — occurrence
notified via the existing `notificationService.sendToUser(userId, message)` (the one notification
front door every existing background worker — `schedulerWorker`, `sniperService` — already routes
through), state-change notified by lifting the receipt/confirmation-counting technique from
`transactionEngine.js`'s `inspectChain`/`waitForFinality` (built for the app's own tracked intents,
so needs adapting for an arbitrary externally-supplied wallet/tx, not reused as-is). Shares the
watcher with Phase 2 above, per this section's own original "share one watcher abstraction" note.

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
- ~~**Section O:** confirm the Gas/mode reading above~~ **Went unanswered — built on the stated
  interpretation** ("don't make the user type the command," not "use a different data source"),
  flagged at the time for correction if wrong. Section O has since shipped in full on that reading;
  revisit if it turns out to have been the wrong call.

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

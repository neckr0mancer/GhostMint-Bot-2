# GhostMint-Bot

Node.js/Express/PostgreSQL EVM wallet and NFT-minting bot spanning Telegram, Discord, and a web
dashboard. Wallets, mint execution, gas/spend governance, watch rules, snipers, and scheduled
mints all live under `src/`; the dashboard frontend is under `dashboard/`.

## Where things stand

**Mid-flight right now: the dashboard redesign, on branch `redesign/dashboard`.**
If that is what you are picking up, read [`docs/REDESIGN_HANDOFF.md`](docs/REDESIGN_HANDOFF.md)
FIRST and nothing else — it names the next task, the rules, how to run and verify,
and what test data already exists. It is written so "continue from the last task" is
enough of a brief.



**[`docs/WORKLIST.md`](docs/WORKLIST.md) is the living backlog and status tracker — always read it
first.** It's a chronological log of every feature Round (A, B, C... AA, AB...), what shipped,
what's partial, and what's next. `git log --oneline -20` corroborates recent work; commit messages
in this repo are written to be self-explanatory.

**Just shipped (2026-08-20):** Round 15 (Section AU, pool 1 only) — a dedicated RPC pool for
scheduled/Degen mints' pre-broadcast reads, raised as a follow-up to Round 14's own speed pass
("if we had different rpc's for different actions, would performance be improved?"). Provider-
agnostic and entirely opt-in: a new `{ENVNAME}_FAST_URLS` env var per chain, unconfigured chains
just alias the existing general pool (zero behavior change), configured ones get that URL prepended
ahead of the general pool as an automatic fallback. An Alchemy-auto-derived variant was built first
and set aside at the owner's direction in favor of this generic one — see Round 15 in
`docs/WORKLIST.md` for both, including the preserved Alchemy variant's diff. **Pool 2 (isolating
sniper's continuous polling + wiring a real WebSocket endpoint) is still open** — needs its own
provider/budget decision, deliberately not built speculatively.

Round 14 (Section AT) shipped just before it: scheduler concurrency (the single biggest fix — a
poll-loop guard was serializing every scheduled task behind whichever one claimed first, even
though it waits for full on-chain finality, up to 10 minutes by default), a short-TTL fee-data
cache, a tighter per-call RPC timeout for pre-broadcast reads, and one narrow simulation-skip
exception for the scheduled+Degen combination specifically — the last of these was a real
safety/speed tradeoff, checked with the owner directly rather than assumed.

Round 13 (Sections AL–AS) shipped just before that: a sequential run of smaller fixes (Telegram
single-instance polling lock, seed-phrase wallet import on both platforms, sold-out auto-cancel for
low-balance alarms, a real Telegram Tasks menu, Discord `/mintnow`), then the full three-part
OpenSea Drops build approved as "All three, in that order": phase display on `/info` and the
collection card, OpenSea-backed minting for allowlist/GTD/FCFS stages via OpenSea's own
`POST /drops/{slug}/mint`, and scheduling those OpenSea-backed mints to fire automatically the
moment a phase opens. Also live-verified (not assumed) that OpenSea's API cannot support
pre-checking an arbitrary wallet's eligibility before a phase opens — a hard external limitation,
recorded so it isn't re-investigated later.

**Since Round 14, also shipped (2026-08-20):**
- Wallet create/import on both platforms now offers **EVM / Solana (coming soon)** instead of five
  separate EVM chain buttons — a private key/seed phrase is chain-agnostic within EVM, so the five
  buttons were noise, not a real decision; picking EVM defaults to `ethereum`, matching the
  dashboard's own `DEFAULT_EVM_CHAIN` precedent. Solana is shown, not hidden, so tapping it explains
  it isn't supported yet rather than doing nothing or requiring the picker to change shape later.
- Railway's `SUPPORTED_CHAINS` drift (missing `base`/`arbitrum`/`polygon`, first documented in
  Round 10's item 9) is fixed — the owner corrected it directly, and it's now verified live via
  Railway's own API (see Round 10 item 10 in `docs/WORKLIST.md`) that production is running the
  full five-chain list.
- **This app can now read/write Railway config directly** via a workspace-scoped API token in
  `.env` as `RAILWAY_TOKEN` — see `docs/WORKLIST.md` Round 10 item 10 for the exact GraphQL
  endpoint, auth header shape, and this project's IDs. The Railway CLI itself doesn't accept this
  token for `whoami`/`status`; the raw GraphQL API does.
- **Same access reads production logs directly, including the `Transaction timing (...)` lines
  Round 16 item 6 added** — no dashboard needed. Query `deploymentLogs(deploymentId, filter, limit)`
  against the current deployment ID (fetch it fresh via the `deployments(...)` query in Round 10
  item 10's note, since it changes on every deploy); `filter: "Transaction timing"` narrows straight
  to the timing lines. Live-verified 2026-08-20 — confirmed this returns real log rows, and that
  right after a deploy there's genuinely nothing yet (no scheduled/sniper mint had fired since).
  This is the mechanism for judging Round 16 item 3 (pre-arming) later: once real scheduled/sniper
  mints have happened, read the `prep` component of those lines — if it's consistently large, item 3
  is worth building; if it's already small, item 4 alone was probably enough.

**One open thread, not yet resolved:** a Discord `/info` "no response" report was investigated but
not reproduced or root-caused; diagnostic logging shipped as a safety net, not a confirmed fix. If
it recurs, capture the exact contract/timestamp so the Railway logs for that window can be checked
directly (now straightforward, given the access above).

**Next up: Round 16 (Section AV), scoped 2026-08-20, ready to build.** The owner's own two-tier
plan for sniper execution speed — every decision needed to start is already made (see the section
in `docs/WORKLIST.md` for the full reasoning): Round 15's pool 2 finishes on a **separate Alchemy
app**, account upgraded to **Pay-As-You-Go** (25 req/s free tier risked throttling during
simultaneous multi-user sniper fires at ~200 users across two servers; QuickNode was checked and
priced out, not just assumed worse); pre-arming scheduled mints (~10-15s lead time default);
precise near-launch timers replacing coarse polling; same-tx multi-RPC broadcast for sniper only,
fanning out to the sniper pool's own URLs, not a relay; and sniper treated as its own execution
profile gated on the already-existing `triggerSource === 'blockchain'` signal. Worklist B
(parallelized pre-arm, dynamic fee presets, RPC health scoring, latency dashboards) follows once A
is stable — except the hot-wallet session cache in B, which needs its own explicit sign-off before
building since it's a security tradeoff, not a routine cache.

Other open candidates, lower priority than Round 16: a `/buy` (secondary-market) command, scoped
but not yet built;
Round 2's Sections **O** (button ⇄ command parity), **P** + **R** (transaction watching + sniper
guided config, which share one watcher abstraction), and **S** (Discord guided task-schedule);
Round 3's Sections **T–Z**; and Section **AD Tier 2**, which is researched but unbuilt. The
worklist's own "Suggested order for Round 2" still stands for that batch. Section O has an
unanswered open question logged against it — check that before starting it. Section AF **shape 2**
(GhostMint constructing its own `mintAllowList` calldata from a hand-entered merkle proof) is now
**mostly moot** — Round 13's Section AR already gets the same outcome for any OpenSea-tracked drop
via OpenSea's own `POST /drops/{slug}/mint`, no proof needed on this app's side at all; shape 2
would only still matter for a contract that runs its own allowlist and isn't tracked by OpenSea as
a Drop, where no API exists to ask at all (confirmed, every project's custom allowlist differs).

## Repo state

- **Private.** Only added collaborators can clone/push. If you're picking this up from a different
  GitHub-linked account, it needs collaborator access first — that's a repo-settings action, not
  something to route around.
- `main` is the only branch in active use. Recent history is linear; no long-lived feature
  branches.
- `.env` is real and gitignored — never committed, but present locally with working credentials
  (DB, Etherscan, OpenSea, Alchemy, Discord). `.env.example` documents every variable's purpose.
- Supported chains (`SUPPORTED_CHAINS` in `.env`): `ethereum, base, arbitrum, polygon, robinhood`.
  Sepolia is deliberately *not* in that list — see `src/config/index.js`'s comment on the `sepolia`
  entry in `CHAIN_DEFINITIONS` for why it's kept internally anyway (Live Acceptance Run only).

## Working conventions established in this repo

- **Commit freely once work is verified** (tests pass, syntax checks clean) — **but never push
  without an explicit go-ahead in that turn.** Confirmation doesn't carry over between turns.
- Before claiming a fix works, reproduce the bug live where possible (a real API call, a real
  contract read) rather than reasoning from memory — this codebase's existing bugs were mostly
  found and fixed this way, not by inspection alone.
- Run the specific test files touched, then the fuller suite, before calling something done.
  `smoke.test.js` has real-DB/Discord bootstrap tests that can be slow/flaky in a sandboxed dev
  environment — don't read a `smoke.test.js` timeout alone as a regression without corroborating.
- Shared core logic (`src/mint/mintFlowDecision.js`, `src/social/watchRuleFlowDecision.js`) exists
  specifically so Telegram and Discord can't silently diverge — extend these, don't hand-roll
  platform-specific branching for flow-sequencing decisions.
- If another concurrent session is visibly mid-edit on a file (a system reminder will say so),
  leave that file alone rather than resolving the conflict yourself.

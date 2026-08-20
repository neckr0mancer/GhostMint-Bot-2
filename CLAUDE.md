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

**Just shipped (2026-08-20):** Round 14 (Section AT) — the "speed" pass the owner asked for right
after Round 13's OpenSea build, scoped specifically to scheduled mints and Degen mode: scheduler
concurrency (the single biggest fix — a poll-loop guard was serializing every scheduled task behind
whichever one claimed first, even though it waits for full on-chain finality, up to 10 minutes by
default), a short-TTL fee-data cache, a tighter per-call RPC timeout for pre-broadcast reads, and
one narrow simulation-skip exception for the scheduled+Degen combination specifically — the last of
these was a real safety/speed tradeoff, checked with the owner directly rather than assumed. See
Round 14 in `docs/WORKLIST.md` for the full detail on each of the four changes.

Round 13 (Sections AL–AS) shipped just before it: a sequential run of smaller fixes (Telegram
single-instance polling lock, seed-phrase wallet import on both platforms, sold-out auto-cancel for
low-balance alarms, a real Telegram Tasks menu, Discord `/mintnow`), then the full three-part
OpenSea Drops build approved as "All three, in that order": phase display on `/info` and the
collection card, OpenSea-backed minting for allowlist/GTD/FCFS stages via OpenSea's own
`POST /drops/{slug}/mint`, and scheduling those OpenSea-backed mints to fire automatically the
moment a phase opens. Also live-verified (not assumed) that OpenSea's API cannot support
pre-checking an arbitrary wallet's eligibility before a phase opens — a hard external limitation,
recorded so it isn't re-investigated later.

**Two open threads, not yet resolved:**
1. A Discord `/info` "no response" report was investigated but not reproduced or root-caused;
   diagnostic logging shipped as a safety net, not a confirmed fix. A related report — an OpenSea
   link resolving to "not found on any supported chain" on Discord `/mint` — pointed at the same
   likely cause: Railway's live `SUPPORTED_CHAINS` env var missing `base`/`arbitrum`/`polygon` (a
   drift first documented in Round 10's item 9, 2026-08-17). The owner is checking/fixing that
   directly in the Railway dashboard; not something this session can do without dashboard access.
2. The owner asked for wallet import to offer "EVM/Solana" instead of listing individual EVM
   chains. Not scoped yet — GhostMint is EVM-only today (no Solana wallet or mint support anywhere
   in the codebase), so this could mean either a cosmetic relabel (one "EVM" bucket, chain
   auto-detected the way mint contracts already are) or real Solana support from scratch. Ask which
   before starting.

**Next up: not decided — pick with the user.** The open candidates, all detailed in
`docs/WORKLIST.md`: a `/buy` (secondary-market) command, scoped but not yet built; Section AF
**shape 2** (allowlist/GTD phases via a hand-entered merkle proof — deliberately left unbuilt, needs
`mintAllowList`/`mintSigned` calldata construction that doesn't exist yet, and shouldn't be built
speculatively); Round 2's Sections **O** (button ⇄ command parity), **P** + **R** (transaction
watching + sniper guided config, which share one watcher abstraction), and **S** (Discord guided
task-schedule — also where Section AF's add-a-phase idea would land if it's ever wanted on
Discord); Round 3's Sections **T–Z**; and Section **AD Tier 2**, which is researched but unbuilt.
The worklist's own "Suggested order for Round 2" still stands for that batch. Section O has an
unanswered open question logged against it — check that before starting it.

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

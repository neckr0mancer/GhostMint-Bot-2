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

**Just shipped (2026-08-18):** Round 9 / Section AF shape 1 — manual multi-phase scheduling on
Telegram. A drop's stage schedule genuinely doesn't exist on-chain (SeaDrop's `PublicDrop` is one
mutable struct describing only the live stage), so the shipped answer is one `/schedule` task per
stage: the task success screen now offers "➕ Add phase N", which re-enters the guided flow against
the same contract and forces this phase's own price and time instead of inheriting the live stage's.
The "Set the alarm?" copy note flagged in the same section was fixed at the same time — the
confirmation now says outright that the bot signs and sends the mint itself.

**Next up: not decided — pick with the user.** The open candidates, all detailed in
`docs/WORKLIST.md`: Section AF **shape 2** (allowlist/GTD phases via a hand-entered merkle proof —
deliberately left unbuilt, needs `mintAllowList`/`mintSigned` calldata construction that doesn't
exist yet, and shouldn't be built speculatively); Round 2's Sections **O** (button ⇄ command
parity), **P** + **R** (transaction watching + sniper guided config, which share one watcher
abstraction), and **S** (Discord guided task-schedule — also where Section AF's add-a-phase idea
would land if it's ever wanted on Discord); Round 3's Sections **T–Z**; and Section **AD Tier 2**,
which is researched but unbuilt. The worklist's own "Suggested order for Round 2" still stands for
that batch. Section O has an unanswered open question logged against it — check that before
starting it.

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

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

**Next up:** Round 9 / Section AF — phase-aware scheduled mints (a `/schedule`d mint should be able
to target a drop *phase*, not just a fixed clock time). Full context, research findings, and two
scoped workaround shapes are already written up in `docs/WORKLIST.md` under "Round 9 — phase-aware
scheduled mints" — read that section before starting, it has everything needed to pick this up
cold. A related copy-accuracy note (the Telegram "Set the alarm?" confirmation text undersells
that a scheduled mint actually executes unattended, not just reminds) is flagged in the same
section but belongs to whichever session owns the Telegram copy/tone pass, not this task.

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

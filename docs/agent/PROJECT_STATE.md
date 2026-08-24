# GhostMint — Pinned Project State

*Last verified: 2026-08-24T08:45:00Z — Model 1, branch `main`, commit `2aa05c2`*
*Source: `git status`, `git log --oneline -10`, `git branch --show-current`, and committed docs. No hypotheses.*

## Branch & History

- **Branch:** `main`
- **HEAD:** `2aa05c2` — `fix(mint): add Ink to canonical SeaDrop core for paste detection`
- **Upstream:** `origin/main` at `2aa05c2` — `0/0` ahead/behind after last push at `08:34:55Z` (Ink chain live, 6 chains)
- **Recent commits (last 10):**
  - `2aa05c2` Ink SeaDrop core
  - `5f0d096` Ink chain 57073
  - `334536e` lint: pasted target scope
  - `9ec7b9e` paste: ignore any EOA
  - `4da8600` paste: differentiate wallets vs contracts
  - `ed2b9b0` scheduled pre-arm warming
  - `079e722` scheduled early retry + fast race
  - `09f5b20` worklist checkpoint
  - `0d4b5af` paste: not-found error
  - `7e82499` paste: silent-drop → error

## Open Loops

- **Uncommitted (phantom):** `tests/bumper.test.js`, `tests/launchTriggers.test.js` — `M` in `git status` but `git diff` empty, `hash-object` == `HEAD`, `ls-files --eol` `i/lf w/lf` — stat-cache noise, no content change.
- **No staged changes.** Working tree clean except phantoms.

## Live Deploy (verified via Railway GraphQL at 08:35 UTC)

- **Project:** `radiant-consideration` (`2d0ca629…`), **Service:** `GhostMint-Bot-2` (`5a72c996…`), **Env:** `production` (`0a771389…`)
- **Deploy:** `bb393963-ccc5-471c-a804-b6e943820101` — `SUCCESS` at `2026-08-24T08:34:55Z`
- **Config:** `supportedChains: [ethereum,base,arbitrum,polygon,robinhood,ink]` (6), `SCHEDULE_PREARM_LEAD_MS=12000`, `FAST/SNIPER` pools on all 5 original chains, `Sniper WS` live on 5, `ink: 2` RPCs (no WS yet), `30` active tasks / `109` total tasks / `43` wallets.
- **No failed deploys** after Ink was added; the `08:32:48` `CRASHED` deploy was the window where `SUPPORTED_CHAINS` included `ink` but code did not yet have `CHAIN_DEFINITIONS.ink`.

## Production Truth (last 2 days, via `zephyr.proxy.rlwy.net:19858`)

- **Recent intents:** 1 confirmed `sepolia` `0x3983…` at `2026-08-15` (no recent prod mints in last 48h on `transaction_intents` — most `mint_tasks` are test fixtures `0x0000…44`).
- **Competitive case found:** `robinhood:0x932c…` at `2026-08-23T13:30:48` — 2 failed instantly (`wallet-1-4/5` `This mint has not opened yet (opens 13:30:48)`) vs 2 succeeded 6-8s later (`wallet-1-2/3` via `0x776a…`/`0x49b0…` to SeaDrop core `0x00005EA…`). Same for `ethereum:0x8A8e…` at `16:00:00` (1 failed). Early `SCHEDULE_DRIFT` was permanent; now fixed to transient `STAGE_NOT_OPEN` with block-driven retry (commit `079e722`).

## Verified Facts Only

- Gate is `908/908` green locally (last full `node --test` at `2026-08-24T08:30Z`); lint clean after `URL` import fix.
- `SCHEDULE_PREARM_LEAD_MS=12000` is live in prod; local `.env` has `0` (disabled) — behavior differs.
- Ink chain added but not yet in `.env.example` default `SUPPORTED_CHAINS`.

## Next Check

- Re-verify `git status` + `git log` at next session start; do not rely on chat memory.

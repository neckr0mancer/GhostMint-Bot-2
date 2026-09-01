# GhostMint — Pinned Project State

*Last verified: 2026-08-27T00:30:00Z — Model 1, branch `main`, commit `9051888`*
*Source: `git status`, `git log --oneline -10`, `git branch --show-current`, and committed docs. No hypotheses.*

## Branch & History

- **Branch:** `main`
- **HEAD:** `9051888` — `fix(dashboard): clear 60s raw-key timer on unmount, not on mount (App.jsx:3725)`
- **Upstream:** `origin/main` at `9051888` — `0/0` ahead/behind after push at `00:30Z` (Discord export + money math live)
- **Recent commits (last 10):**
  - `9051888` dashboard 60s timer cleanup
  - `bda1dac` TX-030 bump fee reserved before broadcast
  - `0238e1b` TX-005 daily budget window by finalized_at
  - `d6d82ec` scheduler Unknown→helpful (low-quality-cats 0x55af sold out)
  - `b8a3f56` Discord Wallets → Export wallet
  - `fdeab15` refine scheduled mint safety + dashboard fidelity
  - `9b7eb45` paste: wallet address feedback
  - `1ce2e84` paste: remove silent-drop RPC scan
  - `87c23c2` TX-021/022/023 append-only + CAS
  - `b3de390` TX-021/022/023/029/030 corrections

## Open Loops

- **Uncommitted:** `src/config/index.js` (RAILWAY_TOKEN), `src/railway/railwayLogService.js`, `scripts/fetch-railway-logs.js` — local Railway log helper, not pushed (intentionally local-only, read-only).
- **No staged changes.** Working tree clean otherwise (phantom `tests/bumper.test.js` stat-cache noise remains).

## Live Deploy (verified via Railway CLI `npx @railway/cli logs` at 00:14 UTC 2026-08-27)

- **Project:** `radiant-consideration` (`2d0ca629…`), **Service:** `GhostMint-Bot-2` (`5a72c996…`), **Env:** `production` (`0a771389…`)
- **Deploy:** latest `main` `9051888` — `SUCCESS` (auto-deploy after push)
- **Config:** `supportedChains: [ethereum,base,arbitrum,polygon,robinhood,ink]` (6), `SCHEDULE_PREARM_LEAD_MS=12000`, `FAST/SNIPER` pools on all 5 original chains, `Sniper WS` live on 5, `ink: 2` RPCs (no WS yet). Recent `Low Quality Cats — Public Stage` `0x55afd2187d7c312bf7e4ca7393a139df19f1f096` `0.005 ETH` shown live: `totalSupply 4269/4269` sold out, `Pre-arm re-arm` moved schedule to live window `2026-08-27T00:15:00Z` (0s drift) — no Unknown error after `d6d82ec`.
- **No failed deploys** since `fdeab15`; prior `08:32:48` `CRASHED` was stale Ink window.

## Production Truth (last 2 days, via `npx @railway/cli logs` + direct `ethereum.publicnode.com` probe)

- **Contract inspected:** `0x55afd2187d7c312bf7e4ca7393a139df19f1f096` on `ethereum` — `SeaDrop` canonical `0x00005EA...`, `mintPrice 0.005 ETH`, `totalSupply 4269 == maxSupply 4269` sold out. OpenSea `low-quality-cats` `Public Stage` `0.005` `isMinting:false` confirms. Prior `Unknown error. Nothing was sent` for wallets `0x7BD9...` / `0x879b...` was blank revert `missing revert data` (public RPC returns no selector) — now mapped to helpful `sold out / no reason` warning.
- **Competitive case still:** `robinhood:0x932c…` `2026-08-23` 2 failed / 2 succeeded 6-8s apart — fixed to transient `STAGE_NOT_OPEN` with block-driven retry.

## Verified Facts Only

- **This session (2026-08-27):** `src/scheduler/scheduledFailureFeedback.js` now maps `Unknown error`/`missing revert data` to sold-out-aware helpful messages; `src/transactions/intentRepository.js:258` windows `confirmed/reverted` by `finalized_at` and keeps `unknown` reserved; `src/transactions/bumper.js:98` + `intentRepository.js:119` reserves bumped `estimated_cost_wei` before broadcast; `dashboard/src/App.jsx:3725` `useEffect` now correctly clears 60s timer on unmount; `src/discord/menus.js:553` + `discordBot.js:928` Discord export live. `tests/transactionEngine.test.js` 52/52, `tests/transactionEngine.integration.test.js` `rollingSpendWei` 2/2, `tests/scheduledFailureFeedback.test.js` 5/5, `tests/bumper.test.js` 5/5.
- **Model 2 correction (2026-08-25, exact `1d99936`):** 971 total / 953 pass / 13 fail / 5 skip isolated; safe-config rerun 51/31 pass; `tests/chainGrouping.test.js` failed due to Ink omission — still true, now fixed in `fdeab15`.
- `SCHEDULE_PREARM_LEAD_MS=12000` live in prod; local `.env` has `0` — behavior differs (intentional for local dev).
- Ink chain added but not yet in `.env.example` default `SUPPORTED_CHAINS`.

## Next Check

- Re-verify `git status` + `git log` at next session start; do not rely on chat memory.

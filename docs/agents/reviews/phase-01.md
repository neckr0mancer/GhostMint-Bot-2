# GhostMint — Audit Review, Phase 1 (Baseline + Adversarial Sweep)

*Model 1 — 2026-08-24. Read-only audit + subsequent fixes shipped same day. Branch `main`, base `d31f2df` → head `2aa05c2` at review time.*

## Scope traced end-to-end

- Mint paths: Discord paste/slash → `handleMintPasteMessage`/`createDiscordInteractionHandler` → `startMintGuidedFlow`/`startMintNowFlow` → `botCommands.mint/batchMint/mintViaOpenSea` → `prepareMintCall`/`mintService.prepare` (`mintCall`, `seaDropCall`, `seaDropDiscoveryService`, `seaDropPublicDropResolver`, `proofResolver`) → `mintExecution.executePrepared` → `transactionEngine.submit` (policy → batched reads → estimate → simulate → nonce → sign → broadcast → `waitForFinality`) → reconciliation → notifications.
- Scheduled path: `schedulerWorker` (claim/precise timers/pre-arm) → `server.js executeTask` (chain resolution, OpenSea build, drift preflight, `prepareMintCall`) → same engine path.
- Launch path: `planner`/`stager`/`launcher`/`triggers` → same engine path with `performAll` race.
- Sniper path: `chainWatcher` (WS/HTTP rotation) → `onBlock` → `sniperService.detect/processBlock` → `triggerPipeline` → `executeTriggered` → engine.
- Dashboard: `api.js` routes → `botCommandService`/governance → repositories; auth/CSRF/session.
- Security: `keyEncryption`, `redaction`, `botSecurity` rate limiters, `actionGate`, `telegramSingleInstanceLock`, `gracefulShutdown`.

## Method

Three parallel subagent audits (transaction path; scheduler+launch; Discord/Telegram/security/integrations), then an adversarial re-audit of the fixes themselves (found 5 defects in the first-round fixes: provider/engine code-set mismatch, transient-timeout gap, discovery cache poisoning, SSRF bypasses, lint scope). Production evidence pulled via Railway GraphQL (deploy logs, env config) and direct read-only SQL against the production Postgres proxy (SELECT only; no writes).

## Confirmed findings → shipped fixes (same session)

| Finding | Severity | Fix commit |
|---|---|---|
| Double-mint on double-click (no in-flight guard) | Critical | `5097ae2` |
| Wallet bricked behind `unknown` nonce (ladder skipped `unknown`) | Critical | `da123b0` |
| Gas/simulation transient errors laundered → permanent task failure | Critical | `eb22ede` |
| Definitive broadcast errors → `BROADCAST_UNKNOWN` retry loop (engine + provider set mismatch) | Critical | `9236ba8`/`71c76ab`/`d31f2df` |
| SSRF via scraper sourceUrl (numeric/hex/octal IP, redirects) | Critical | `9236ba8`/`d31f2df` |
| False-final `replaced` + `unknown` never re-bid | Critical | `80a6ff8`/`da123b0` |
| Daily budget under-count | High | `8d56823`/`c08e9e6` |
| Admin health route unreachable (below 404 catch-all) | High | `8d56823` |
| Stager serial balances (~16min for 100 wallets); null gas buffer | High | `69fa168` |
| SeaDrop discovery tier abort + negative-cache poisoning | High | `69fa168`/`d31f2df` |
| `claimNewlyExpired` duplicate history rows; sweep batch abort | High | `69fa168` |
| Scheduled early-window permanent failure (competitive loss, prod-evidenced) | Critical | `079e722`/`ed2b9b0` |
| Paste silent drops; wallet-vs-contract confusion | High | `7e82499`/`0d4b5af`/`4da8600`/`9ec7b9e`/`334536e` |
| Smoke budgets below internal deadlines | Medium | `7bcac88` |
| Ink chain + SeaDrop core missing | Medium | `5f0d096`/`2aa05c2` |

## Open findings (not yet fixed) — full detail in `docs/agent/WORKLIST.md`

- Multi-instance safety: per-process nonce queue + in-flight locks (SEC-003), launch settlement double-fire (TX-017)
- Clock drift app vs DB in all scheduler/launch time predicates (RPC-004)
- `recoverStaleClaims` sequential stall (RPC-005); `claimNewlyExpired` claim-before-write data loss (SEC-011)
- `inspectChain` ignores `bumped_from_tx_hash` (TX-008); 0-priority bump loop (TX-009); preview/submit fee divergence (TX-010)
- Launch: `sent` overwritten on send failure (TX-015); staged never times out (TX-016); block re-arm gap (RPC-009)
- Security: plaintext keys in flowState (SEC-004), export success-path rate limit (SEC-005), import confirmation gates (SEC-006), redaction blanket/phrase gap (SEC-007)
- Integrations: defer-before-auth (UX-003), callback flow-kill (UX-004), pendingConfirmations ownership (UX-005)
- Perf/observability: timing aggregation (BASE-002), performAll winner attribution (BASE-003), load rehearsal (PERF-005)

## Residual risks (cannot verify locally)

- Multi-instance behavior (single-instance deployment today; Railway may scale)
- DNS-rebinding SSRF past validation-time checks
- Real-mainnet competitive latency (needs BASE-002 aggregation + a live drop to measure)

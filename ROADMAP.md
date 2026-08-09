# GhostMint Project Roadmap

This roadmap breaks the remaining work into small, reviewable milestones. It is intentionally documentation-only and does not include code changes.

## Milestone 1: Repository hygiene and local setup

### Why it's needed
- The project needs a predictable local workflow before feature work starts.
- Dependencies, generated data, secrets, and runtime artifacts should be clearly separated from source control.
- New contributors need a short setup path for installing dependencies, configuring environment variables, and starting the server.

### Files that will change
- `.gitignore` — replace the current misnamed ignore file with an actual Git ignore file for `node_modules`, `.env`, `data.json`, logs, and local artifacts.
- `README.md` — add project overview, prerequisites, install/start steps, required environment variables, and basic operating notes.
- `.env.example` — document required and optional variables without secrets.
- `package.json` — add scripts for linting, formatting, tests, and development once those tools are selected.

### How we'll know it's working
- A fresh clone can run `npm install` and `npm start` using `.env.example` as a guide.
- `git status --short` no longer shows generated dependencies or local data files.
- The health endpoint responds locally at `/health` after setup.

## Milestone 2: Configuration and data model hardening

### Why it's needed
- Configuration is currently read directly from environment variables throughout startup, and data persistence uses a single JSON file.
- The app needs clear validation for secrets, RPC URLs, dashboard password, supported chains, and persisted records.
- Safer defaults are needed before handling private keys and automated transactions in production.

### Files that will change
- `index.js` — move configuration validation and DB initialization behind explicit helper functions or modules.
- `src/config.js` or `config.js` — centralize environment loading, defaults, and required variable validation.
- `src/db.js` or `db.js` — encapsulate loading, saving, schema defaults, and write safety for persisted JSON data.
- `data.example.json` — document the expected shape of wallets, tasks, activity, PnL entries, and copy-mint watchers.

### How we'll know it's working
- Starting without required production secrets fails fast with clear messages, while development mode remains easy to run.
- Existing `data.json` files with missing optional arrays are normalized without crashing.
- Invalid chain names, malformed addresses, and malformed task records are rejected before runtime transaction logic.

## Milestone 3: Security baseline for wallet and dashboard access

### Why it's needed
- The app stores encrypted private keys, exposes dashboard APIs, and performs on-chain transactions.
- Dashboard authentication, encryption settings, input validation, and secret handling must be production-ready before adding more automation.
- Unsafe defaults such as placeholder encryption secrets and simple shared dashboard passwords should be eliminated or explicitly development-only.

### Files that will change
- `index.js` — strengthen auth checks, wallet creation validation, request validation, and error responses.
- `src/auth.js` or `auth.js` — isolate dashboard authentication and token/session behavior.
- `src/crypto.js` or `crypto.js` — isolate private-key encryption/decryption and enforce secret requirements.
- `.env.example` — document secure secret requirements and recommended production values.
- `README.md` — add security warnings, backup guidance, and operational requirements.

### How we'll know it's working
- The app refuses to start in production with default `ENCRYPTION_SECRET` or `DASHBOARD_PASSWORD` values.
- Wallet private keys are never returned by API responses or logs.
- Unauthorized API requests consistently return `401` and authorized requests still work.
- Invalid wallet labels, private keys, addresses, and chain values are rejected with clear `400` responses.

## Milestone 4: Split the monolith into focused modules

### Why it's needed
- Most application behavior currently lives in one server file, making it difficult to test and safely change.
- Separating routing, Telegram commands, mint execution, scheduling, persistence, and copy-mint watching will reduce coupling.
- Smaller modules make future test coverage and bug fixes much easier.

### Files that will change
- `index.js` — become the app entrypoint that wires modules together.
- `src/routes/*.js` — move Express API routes into route-specific files.
- `src/telegram.js` — move Telegram bot setup and command handlers.
- `src/mintExecutor.js` — move transaction-building and mint execution.
- `src/scheduler.js` — move scheduled task timer management.
- `src/copyMintWatcher.js` — move watcher lifecycle and polling logic.
- `src/chains.js` — centralize supported chain metadata.

### How we'll know it's working
- `npm start` still starts the same server and Telegram bot behavior.
- Existing API endpoints keep the same response shapes unless intentionally changed.
- Manual smoke checks for `/health`, `/api/login`, `/api/stats`, wallet listing, task listing, and copy-mint listing pass.
- Each module can be imported without starting the HTTP server as a side effect.

## Milestone 5: Automated test foundation

### Why it's needed
- The project controls irreversible blockchain actions, so regressions need to be caught before deployment.
- Core logic should be testable without hitting live RPC providers, Telegram, or real wallets.
- A small test suite will make later refactors safer.

### Files that will change
- `package.json` — add test runner dependencies and scripts.
- `test/` or `__tests__/` — add unit tests for config, DB normalization, auth, validation, and task scheduling.
- `src/*` — adjust modules to support dependency injection for providers, Telegram, and storage.
- `.github/workflows/ci.yml` or equivalent CI config — run tests and lint checks on every pull request if this repository uses GitHub Actions.

### How we'll know it's working
- `npm test` runs locally without requiring live private keys, live Telegram credentials, or real transactions.
- Unit tests cover successful and failing cases for login, wallet validation, task creation, copy-mint watcher creation, and PnL entries.
- CI reports passing tests for pull requests.

## Milestone 6: Transaction safety and mint execution controls

### Why it's needed
- Minting and copy-minting can spend real funds and may fail for many chain-specific reasons.
- The app needs simulation, gas controls, nonce handling, chain validation, and clear failure reporting before users rely on automation.
- Copy-mint mirroring should guard against blindly replaying high-risk transactions.

### Files that will change
- `src/mintExecutor.js` — add transaction simulation, gas/fee handling, nonce strategy, and clearer errors.
- `src/copyMintWatcher.js` — add filters, per-wallet limits, deduplication, and optional dry-run behavior.
- `src/routes/mint.js` and `src/routes/batch.js` — expose safety options and validation errors.
- `README.md` — document safe operating modes and transaction risk.
- `data.example.json` — include any new safety fields for tasks and watchers.

### How we'll know it's working
- Dry-run or simulation mode can validate a mint request without broadcasting a transaction.
- Duplicate watcher triggers do not submit duplicate transactions for the same source transaction.
- Gas limits, max fee settings, quantity, price, and chain IDs are validated before signing.
- Failed transactions produce actionable activity records and Telegram messages without crashing the process.

## Milestone 7: Dashboard frontend completion

### Why it's needed
- The server serves a `public` dashboard, but the repository needs a complete, documented user interface for core workflows.
- Users need safe screens for login, wallet management, manual minting, scheduled minting, batch minting, copy-mint watchers, activity, gas, and PnL.
- The UI should make destructive or fund-spending actions explicit and hard to trigger accidentally.

### Files that will change
- `public/index.html` — add or complete the dashboard structure.
- `public/styles.css` — add responsive layout and status styling.
- `public/app.js` — add API calls, form validation, state refresh, and user feedback.
- `README.md` — add dashboard usage instructions and screenshots if applicable.

### How we'll know it's working
- A user can log in and complete every major workflow from the browser without using raw API calls.
- The dashboard displays clear loading, success, validation, and error states.
- Manual smoke testing confirms wallet CRUD, task CRUD, copy-mint CRUD, activity, gas, PnL, and health status in the UI.
- If UI changes are visible, a screenshot is captured for review.

## Milestone 8: Observability and operational resilience

### Why it's needed
- A 24/7 automation bot needs reliable logging, health checks, restart behavior, and safe error handling.
- Operators need enough visibility to know whether watchers, scheduled tasks, Telegram, RPC providers, and persistence are healthy.
- Production issues should be diagnosable without exposing secrets.

### Files that will change
- `index.js` and `src/*` modules — replace ad hoc logs with structured operational logs.
- `src/health.js` or route module — expand health checks for DB writeability, scheduler state, Telegram status, and RPC availability.
- `railway.json` — adjust deployment settings if needed after runtime behavior is clarified.
- `README.md` — add deployment, monitoring, backup, and restore instructions.

### How we'll know it's working
- `/health` and any readiness endpoints report useful status without exposing secrets.
- Startup logs clearly report enabled chains, restored tasks, restored watchers, and disabled optional integrations.
- Expected transient RPC or Telegram failures are logged and recovered without process crashes.
- Railway deployment starts cleanly and restarts only on real process failures.

## Milestone 9: Production release checklist

### Why it's needed
- Before calling the project complete, the team needs an agreed definition of done.
- Release readiness should include security, documentation, testing, deployment, backups, and rollback plans.
- The final milestone prevents feature-complete code from shipping without operational safeguards.

### Files that will change
- `README.md` — add production runbook, deployment guide, backup/restore process, and known limitations.
- `CHANGELOG.md` — document notable changes and release notes.
- `SECURITY.md` — document responsible usage, secret handling, and vulnerability reporting.
- `package.json` — finalize version and scripts for production checks.

### How we'll know it's working
- A clean clone can be configured, tested, and deployed by following documentation only.
- All required checks pass: install, lint, tests, start, and health check.
- Production secrets are documented but never committed.
- The team can explain rollback, data backup, and wallet recovery procedures before launch.

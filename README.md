# GhostMint Bot

GhostMint is an Express and Telegram service for managing EVM wallets, scheduling NFT mints, submitting manual and batch mints, and watching target wallets for post-confirmation copy-mint activity.

> **Project status:** active prototype. Use disposable test wallets only. The security, persistence, scheduling, and transaction-safety work planned for later milestones is not implemented yet.

## Requirements

- Node.js 24 LTS
- npm 11.7.0
- RPC access for any configured EVM chains
- Optional Telegram bot token and destination chat ID

The supported Node version is recorded in both `.nvmrc` and `.node-version`.

## Local setup

```powershell
git clone https://github.com/neckr0mancer/GhostMint-Bot-2.git
Set-Location GhostMint-Bot-2
npm ci
Copy-Item .env.example .env
npm start
```

Edit `.env` before using wallet or Telegram features. The server listens on port `3000` by default.

Check the service after startup:

```text
GET http://localhost:3000/health
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | No | Runtime environment name. |
| `PORT` | No | HTTP port; defaults to `3000`. |
| `TELEGRAM_BOT_TOKEN` | No | Enables Telegram polling when supplied. |
| `TELEGRAM_CHAT_ID` | With Telegram | Destination chat for bot responses and notifications. |
| `ENCRYPTION_SECRET` | Before wallet use | Encrypts stored wallet private keys. |
| `DASHBOARD_PASSWORD` | Before API use | Protects dashboard API endpoints. |
| `ETH_RPC` | No | Ethereum RPC override. |
| `BASE_RPC` | No | Base RPC override. |
| `ARB_RPC` | No | Arbitrum RPC override. |
| `POLYGON_RPC` | No | Polygon RPC override. |

Milestone 1 preserves the prototype's existing development fallbacks. Fail-closed production configuration belongs to Milestone 2.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the service normally. |
| `npm run dev` | Start with Node's file watcher. |
| `npm run check` | Validate JavaScript syntax. |
| `npm run lint` | Run the baseline ESLint safety rules. |
| `npm test` | Run the Node test suite. |
| `npm run validate` | Run syntax, lint, and tests together. |

## Project structure

```text
.
|-- index.js               Compatibility entrypoint
|-- src/
|   |-- server.js          Current application server
|   |-- config/            Future configuration modules
|   |-- routes/            Future HTTP route modules
|   |-- services/          Future application services
|   |-- storage/           Future persistence adapters
|   `-- workers/           Future scheduler and watcher workers
|-- tests/
|   `-- smoke.test.js      Real process and health-endpoint smoke test
|-- .env.example           Environment-variable template
|-- package.json           Scripts and dependency declarations
|-- package-lock.json      Reproducible dependency graph
`-- railway.json           Railway deployment settings
```

The placeholder source directories establish boundaries for later milestones; no later-milestone refactor has been started.

## Deployment

`railway.json` uses Nixpacks and starts the root compatibility entrypoint with `node index.js`. Configure environment variables in Railway before deployment.

Persistent storage, hardened authentication, durable scheduling, and production wallet custody remain future milestones.

## Validation

Before opening a pull request or deploying, run:

```powershell
npm ci
npm run validate
```

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
| `NODE_ENV` | Yes | Must be `development`, `test`, or `production`. |
| `PORT` | No | HTTP port; defaults to `3000`. |
| `DATA_FILE` | Yes | Absolute path or project-relative path for the current JSON data file. |
| `SUPPORTED_CHAINS` | Yes | Comma-separated supported chain names; `ethereum` must currently be included. |
| `TELEGRAM_BOT_TOKEN` | No | Enables Telegram polling when supplied. |
| `TELEGRAM_CHAT_ID` | With Telegram | Required whenever `TELEGRAM_BOT_TOKEN` is supplied, and vice versa. |
| `ENCRYPTION_SECRET` | Yes | Encrypts stored wallet private keys; subject to the secret-strength policy below. |
| `DASHBOARD_PASSWORD` | Yes | Protects dashboard API endpoints; subject to the secret-strength policy below. |
| `ETH_RPC` | No | Ethereum RPC override. |
| `BASE_RPC` | No | Base RPC override. |
| `ARB_RPC` | No | Arbitrum RPC override. |
| `POLYGON_RPC` | No | Polygon RPC override. |

The application fails closed when a required value is missing or invalid. It never falls back to a built-in password or encryption secret.

### Secret-strength policy

- `ENCRYPTION_SECRET`: at least 32 characters in development/test and 48 in production, with at least 12 unique characters.
- `DASHBOARD_PASSWORD`: at least 16 characters in development/test and 24 in production, with at least 10 unique characters.
- Both values must contain at least three of: lowercase letters, uppercase letters, digits, and symbols.
- Known defaults and placeholder patterns such as `ghostmint`, `change_me`, `replace`, `password`, `default`, and `example` are rejected.
- Leading or trailing whitespace is rejected.

The values in `.env.example` are intentionally development-only. Generate independent random production values rather than reusing them.

### Chain and data configuration

Supported chain names are `ethereum`, `base`, `arbitrum`, and `polygon`. Every configured RPC override must be an HTTP or HTTPS URL without embedded credentials. Public RPC defaults remain available when an override is blank.

`DATA_FILE` controls the existing JSON file location. Relative paths are resolved from the project root; replacing JSON storage with a database remains Milestone 3.

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
|   |-- config/            Validated, fail-closed runtime configuration
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

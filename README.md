# GhostMint Bot

GhostMint is an Express and Telegram service for managing EVM wallets, scheduling NFT mints, submitting manual and batch mints, and watching target wallets for post-confirmation copy-mint activity.

> **Project status:** active prototype. PostgreSQL persistence, versioned envelope encryption, and Telegram-backed multi-user identity are implemented. Transaction validation and durable scheduling still require later milestones. Use disposable test wallets only.

## Requirements

- Node.js 24 LTS
- npm 11.7.0
- PostgreSQL 14 or newer (a transaction-mode PgBouncer URL plus a direct migration URL)
- RPC access for any configured EVM chains
- Optional Telegram bot token and destination chat ID

The supported Node version is recorded in both `.nvmrc` and `.node-version`.

## Local setup

```powershell
git clone https://github.com/neckr0mancer/GhostMint-Bot-2.git
Set-Location GhostMint-Bot-2
npm ci
Copy-Item .env.example .env
npm run db:migrate
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
| `DATABASE_URL` | Production; required to start the app | Pooled PostgreSQL URL used for normal application queries. |
| `DATABASE_URL_UNPOOLED` | Production; required for migrations | Direct PostgreSQL URL used only by `npm run db:migrate`. |
| `DATABASE_POOL_MAX` | No | Application pool size from 1-10; defaults to `5`. |
| `SUPPORTED_CHAINS` | Yes | Comma-separated supported chain names; `ethereum` must currently be included. |
| `TELEGRAM_BOT_TOKEN` | No | Enables Telegram polling when supplied. |
| `ENCRYPTION_SECRET` | Yes | Encrypts stored wallet private keys; subject to the secret-strength policy below. |
| `ENCRYPTION_KEY_VERSION` | No | Positive integer identifying the active master key; defaults to `1`. |
| `ENCRYPTION_OLD_KEYS` | No | JSON object mapping prior key versions to their secrets for decryption during rotation. |
| `ETH_RPC` | No | Ethereum RPC override. |
| `BASE_RPC` | No | Base RPC override. |
| `ARB_RPC` | No | Arbitrum RPC override. |
| `POLYGON_RPC` | No | Polygon RPC override. |

The application fails closed when a required value is missing or invalid. It never falls back to a built-in credential or encryption secret.

### Secret-strength policy

- `ENCRYPTION_SECRET`: at least 32 characters in development/test and 48 in production, with at least 12 unique characters.
- The encryption secret must contain at least three of: lowercase letters, uppercase letters, digits, and symbols.
- Known defaults and placeholder patterns such as `ghostmint`, `change_me`, `replace`, `password`, `default`, and `example` are rejected.
- Leading or trailing whitespace is rejected.

The value in `.env.example` is intentionally development-only. Generate independent random production values rather than reusing it.

### Identity and account linking

Telegram commands authenticate from Telegram's immutable sender ID. The first command from a sender automatically creates an internal UUID user and links that Telegram account. All wallets, tasks, activity, P&L records, snipers, and seen transactions are scoped to that UUID in both application logic and repository SQL.

`/link` creates a cryptographically random code that expires after five minutes and can be consumed once. The linking service supports both `telegram` and `discord`; Discord command handling will call the same service when that bot is implemented. Password-based dashboard authentication has been removed. HTTP `/api` routes return `501` until Milestone 13 supplies a platform-linked dashboard login flow.

### Chain and database configuration

Supported chain names are `ethereum`, `base`, `arbitrum`, and `polygon`. Every configured RPC override must be an HTTP or HTTPS URL without embedded credentials. Public RPC defaults remain available when an override is blank.

Normal queries use `DATABASE_URL` through a `pg` pool capped by `DATABASE_POOL_MAX`. Set this URL to Railway's transaction-mode PgBouncer endpoint (Database → Config → Connection Pooling → Add PgBouncer). Migrations deliberately create a standalone client from `DATABASE_URL_UNPOOLED`; never point the migration variable at PgBouncer transaction mode. The schema is standard PostgreSQL and does not depend on Railway, so Supabase or another provider can be substituted.

Run migrations before starting a new deployment:

```powershell
npm run db:migrate
```

### Encryption-key rotation

Wallet private keys use AES-256-GCM with a unique scrypt salt and nonce per wallet. To rotate the master key:

1. Retain the old secret in `ENCRYPTION_OLD_KEYS`, keyed by its old version.
2. Set a new `ENCRYPTION_SECRET` and increment `ENCRYPTION_KEY_VERSION`.
3. Run `npm run keys:rotate` once, then restart all application instances.
4. Remove an old key only after every wallet row has been rotated and a verified backup exists.

Example shape (never commit real values): `ENCRYPTION_OLD_KEYS={"1":"previous-strong-secret"}`.

### Backup and restore

Use the direct URL for PostgreSQL maintenance; PgBouncer transaction mode is not suitable for schema migration or full backup/restore sessions.

Create a compressed backup:

```powershell
pg_dump --format=custom --no-owner --no-acl --file ghostmint.backup $env:DATABASE_URL_UNPOOLED
```

Restore into an empty target database:

```powershell
pg_restore --clean --if-exists --no-owner --no-acl --dbname $env:DATABASE_URL_UNPOOLED ghostmint.backup
```

Store backups encrypted outside the application host. Test restores regularly and verify the `schema_migrations`, `wallets`, and task/activity tables before declaring a backup usable.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the service normally. |
| `npm run dev` | Start with Node's file watcher. |
| `npm run check` | Validate JavaScript syntax. |
| `npm run lint` | Run the baseline ESLint safety rules. |
| `npm test` | Run the Node test suite. |
| `npm run validate` | Run syntax, lint, and tests together. |
| `npm run db:migrate` | Apply pending migrations over the direct/unpooled connection. |
| `npm run keys:rotate` | Re-encrypt older wallet envelopes with the active key version. |

## Project structure

```text
.
|-- index.js               Compatibility entrypoint
|-- src/
|   |-- server.js          Current application server
|   |-- config/            Validated, fail-closed runtime configuration
|   |-- db/                Pooled connections and direct migration runner
|   |-- identity/          Platform identities and single-use account linking
|   |-- security/          Authenticated key encryption and log redaction
|   |-- routes/            Future HTTP route modules
|   |-- services/          Future application services
|   |-- storage/           PostgreSQL repository adapter
|   `-- workers/           Future scheduler and watcher workers
|-- migrations/            Versioned PostgreSQL schema migrations
|-- scripts/               Migration and key-rotation commands
|-- tests/                 Config, crypto, persistence, and process smoke tests
|-- .env.example           Environment-variable template
|-- package.json           Scripts and dependency declarations
|-- package-lock.json      Reproducible dependency graph
`-- railway.json           Railway deployment settings
```

## Deployment

`railway.json` uses Nixpacks and starts the root compatibility entrypoint with `node index.js`. Configure environment variables, add Railway PgBouncer in transaction mode, and run `npm run db:migrate` with the direct URL before deployment.

Discord bot integration, linked-account dashboard login, transaction validation, durable scheduling, observability, and operational hardening remain future milestones.

## Validation

Before opening a pull request or deploying, run:

```powershell
npm ci
npm run validate
```

# GhostMint Bot

GhostMint is an Express, Telegram, and Discord service for managing EVM wallets, scheduling NFT mints, submitting manual and batch mints, and watching target wallets for post-confirmation copy-mint activity.

> **Project status:** active prototype. PostgreSQL persistence, versioned envelope encryption, multi-user identity, transaction safety, flexible mint calls, durable scheduling, and post-confirmation copy-watcher hardening are implemented. Production operations and later platform/trigger milestones remain incomplete. Use disposable test wallets only.

## Requirements

- Node.js 24 LTS
- npm 11.7.0
- PostgreSQL 14 or newer (a transaction-mode PgBouncer URL plus a direct migration URL)
- RPC access for any configured EVM chains
- Optional Telegram bot token

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
| `RPC_TIMEOUT_MS` | No | Timeout for one RPC attempt; defaults to `10000`. |
| `RPC_RETRIES` | No | Retries per RPC endpoint before failover; defaults to `1`. |
| `SUPPORTED_CHAINS` | Yes | Comma-separated supported chain names; `ethereum` must currently be included. |
| `TELEGRAM_BOT_TOKEN` | No | Enables Telegram polling when supplied. |
| `DISCORD_BOT_TOKEN` | No* | Enables the Discord bot. Must be supplied with both Discord IDs. |
| `DISCORD_APPLICATION_ID` | No* | Discord application snowflake used for slash-command registration. |
| `DISCORD_DEV_GUILD_ID` | No* | Development guild snowflake for immediate command registration. |
| `ENCRYPTION_SECRET` | Yes | Encrypts stored wallet private keys; subject to the secret-strength policy below. |
| `ENCRYPTION_KEY_VERSION` | No | Positive integer identifying the active master key; defaults to `1`. |
| `ENCRYPTION_OLD_KEYS` | No | JSON object mapping prior key versions to their secrets for decryption during rotation. |
| `ETH_RPC` | No | Ethereum RPC override. |
| `BASE_RPC` | No | Base RPC override. |
| `ARB_RPC` | No | Arbitrum RPC override. |
| `POLYGON_RPC` | No | Polygon RPC override. |
| `ETH_RPC_URLS`, `BASE_RPC_URLS`, `ARB_RPC_URLS`, `POLYGON_RPC_URLS` | No | Comma-separated ordered failover lists (1-5 unique URLs); each list overrides its matching single URL. |

The application fails closed when a required value is missing or invalid. It never falls back to a built-in credential or encryption secret.

### Secret-strength policy

- `ENCRYPTION_SECRET`: at least 32 characters in development/test and 48 in production, with at least 12 unique characters.
- The encryption secret must contain at least three of: lowercase letters, uppercase letters, digits, and symbols.
- Known defaults and placeholder patterns such as `ghostmint`, `change_me`, `replace`, `password`, `default`, and `example` are rejected.
- Leading or trailing whitespace is rejected.

The value in `.env.example` is intentionally development-only. Generate independent random production values rather than reusing it.

### Identity and account linking

Telegram commands authenticate from Telegram's immutable sender ID. The first command from a sender automatically creates an internal UUID user and links that Telegram account. All wallets, tasks, activity, P&L records, snipers, and seen transactions are scoped to that UUID in both application logic and repository SQL.

`/link` creates a cryptographically random code that expires after five minutes and can be consumed once. Run `/link` on an existing Telegram identity and then `/link code:<value>` in Discord to attach Discord directly to the same internal user. Link-code consumption occurs before Discord's first-seen auto-creation path, avoiding a duplicate identity. Password-based dashboard authentication has been removed. HTTP `/api` routes return `501` until Milestone 13 supplies a platform-linked dashboard login flow.

### Discord bot

Configure all three Discord variables together. Startup registers guild-scoped slash commands immediately and logs in the bot. `/wallet`, `/mint`, `/batch-mint`, `/task`, `/activity`, `/pnl`, `/gas`, `/sniper`, `/mode`, `/admin`, and `/link` use the same identity, validation, governance, transaction, scheduler, and storage services as Telegram. Replies are ephemeral; destructive and value-bearing commands require an explicit `confirm` option. Sniper output states that copying is post-confirmation and is not mempool front-running.

Wallet generation is the recommended onboarding path on both platforms: use Telegram `/createwallet <label> <chain>` or Discord `/wallet create`. GhostMint generates the key server-side, immediately envelope-encrypts it, stores only the encrypted envelope, and returns only the public funding address.

Private-key import remains available through Telegram `/importwallet <label> <chain> <private-key>` and Discord `/wallet import`, but both commands are explicitly marked **not recommended**. The key necessarily passes through Telegram or Discord infrastructure and may appear in client chat history or notification previews before GhostMint receives and encrypts it. Use imports only when an existing wallet is unavoidable, delete the originating platform message where possible, and prefer the future HTTPS Milestone 13 dashboard import flow when it becomes available.

Transaction and scheduler notifications are delivered independently to every linked platform account. A delivery failure on one platform is logged but cannot change transaction state or suppress delivery to another platform.

### Social watcher adapters

Social watch rules are user-owned PostgreSQL records with a `type`, a `method`, and validated type-specific `config`. Supported types are `twitter_account`, `twitter_keyword`, `discord_channel`, and `discord_keyword`; supported methods are `official_api`, `managed_service`, and `scraper`. Telegram exposes `/watch add|edit|disable|remove|list`; Discord exposes the equivalent `/watch` subcommands through the same shared command service.

Every method adapter implements one operation: `poll(rule) -> { items, cursor }`. Each item has `id`, `text`, `platform`, optional `url`, and `publishedAt`. Adapters own transport authentication, response normalization, rate-limit interpretation, and errors. The core watcher only selects `adapters.get(rule.method)`, extracts addresses, persists deduplicated trigger events, and advances the cursor. A new acquisition method therefore requires one adapter registration; a new source type requires validation plus adapter-side query mapping, without changing polling or trigger logic.

Official API and managed-service credentials are environment-only and must never be placed in rule config. `SOCIAL_OFFICIAL_API_URL`/`SOCIAL_OFFICIAL_API_TOKEN` and `SOCIAL_MANAGED_SERVICE_URL`/`SOCIAL_MANAGED_SERVICE_TOKEN` configure those transports. Scraper rules provide a credential-free HTTP(S) `sourceUrl`. All adapters expect either an array or `{ "items": [...], "cursor": ... }`, where each item includes at least `id` and `text`. Repeated failures use bounded backoff and notify the owning user; one failed rule cannot stop others.

The official and managed-service endpoint variables intentionally point to operator-selected normalized gateways. Their requests receive the rule `type`, credential-free `config`, and `cursor`, so changing providers or moving between direct official APIs and an operator gateway does not alter stored rules or watcher code. The gateway must return the normalized item format above. This avoids coupling the core to X's changing pricing/product shape or to one managed vendor.

Extracted Ethereum addresses are checksum-normalized and recorded as `social-triggered` events. Same-user, same-platform, same-address matches within a five-minute bucket deduplicate across rules. This milestone records and notifies only; Milestone 10c will decide manual/automatic execution and verification policy.

Every adapter request—including scraper requests used during free testing—is persisted in `social_adapter_usage` with its timestamp, rule, method, request type, success state, and any provider-reported `costUsd`/`credits` or corresponding response headers. Owners can run Telegram `/socialusage today|month` or Discord `/social-usage` to see totals by rule and method, provider-reported consumption, projected volume, and comparative estimates.

Pricing assumptions are centralized in `CONFIG.socialPricing`, currently `$0.005` per X read, `$0.015` per X post, and representative managed-service tiers of `$199` and `$499` per month. They are estimates for planning, not billing records; update this single configuration object when provider pricing changes. The report calculates flat-rate break-even request counts under both read and post rates.

### Chain and database configuration

Supported chain names are `ethereum`, `base`, `arbitrum`, and `polygon`. Every configured RPC override must be an HTTP or HTTPS URL without embedded credentials. Public RPC defaults remain available when an override is blank.

RPC calls have bounded timeouts and retry the current endpoint before moving through the configured chain-specific fallback list. Configure private authenticated providers through provider-side network controls or secret-bearing gateway configuration; embedded URL credentials are rejected so they cannot leak through configuration output.

Normal queries use `DATABASE_URL` through a `pg` pool capped by `DATABASE_POOL_MAX`. Set this URL to Railway's transaction-mode PgBouncer endpoint (Database → Config → Connection Pooling → Add PgBouncer). Migrations deliberately create a standalone client from `DATABASE_URL_UNPOOLED`; never point the migration variable at PgBouncer transaction mode. The schema is standard PostgreSQL and does not depend on Railway, so Supabase or another provider can be substituted.

### Request validation limits

All bot and future API inputs use the same domain schemas. Unsupported chains fail explicitly and never fall back to Ethereum. Current safety bounds include quantities of 1–100, prices up to 1,000 ETH, gas limits from 21,000–30,000,000, fee inputs up to 100,000 Gwei, sniper gas boosts up to 500%, and batch requests up to 100 unique wallets. Task times must be valid future timestamps no more than five years ahead.

### Durable scheduled tasks and time zones

Scheduled mints are PostgreSQL rows, not process-local timers. Workers atomically claim due rows with `FOR UPDATE SKIP LOCKED`, write an attempt record, and use a lease so multiple app instances cannot claim the same task. Each task has a stable idempotency key that is also stored on its transaction intent; recovery checks that intent and current chain state before deciding whether to complete, retry, or continue reconciling a task.

Transient RPC and network failures retry up to the task's bounded attempt limit with exponential backoff. Validation and other permanent failures stop immediately. `/canceltask`, `/pausetask`, `/resumetask`, and `/retrytask` update durable, owner-scoped state.

All task timestamps are stored as PostgreSQL `TIMESTAMPTZ` values and displayed by Telegram as ISO-8601 UTC (`Z`). Current inputs must include an explicit offset or `Z`; a client accepting a local wall-clock time must convert it to an offset-bearing ISO timestamp before applying the shared task schema. Relative countdowns are informational only; the UTC due time is authoritative. Valid schedules may be up to five years ahead, a product safety bound independent of JavaScript's timer range.

### Post-confirmation copy snipers

Wallet-copy snipers are explicitly post-confirmation copiers, not mempool front-runners. The watcher records a matching source transaction, waits for the sniper's configured confirmation count, and verifies that the receipt still has the same block hash before submitting a copy. Duplicate block delivery and process restarts reuse the durable `(user, sniper, source transaction)` record, while reorg-dropped transactions are recorded as skipped rather than copied.

Each sniper has independent maximum copied value, maximum gas price, rolling daily copied-value cap, cooldown, maximum attempts, source-confirmation depth, and optional contract allow/deny lists. Denylist entries always block copying. The shared Milestone 7 transaction engine remains responsible for wallet nonce serialization, simulation, signing, balance checks, and broader wallet/target policies.

Existing sniper settings can be patched with `/updatesniper <id> <JSON>`. The merged configuration is fully validated before the database or running watcher is changed; unknown fields, malformed addresses, overlapping allow/deny lists, invalid limits, and non-boolean activation values are rejected.

Future mempool mode should be a separate trigger adapter and explicitly labeled higher-risk. It would require WebSocket/pending-transaction provider support, replacement tracking, uncertain-source-state handling, tighter rate and spend controls, and separate event semantics; it must still feed the existing validation, idempotency, and transaction engine. It is intentionally not implemented as part of the post-confirmation watcher.

### Transaction safety policies

Every manual, scheduled, or copy-mint submission uses the same transaction engine. It serializes work per wallet, checks value, fees, estimated cost, balance, and rolling 24-hour spend, simulates by default, then persists a `submitted` intent and its deterministic signed hash before broadcasting. Durable transitions cover `submitted`, `pending`, `confirmed`, `reverted`, `replaced`, and `unknown`; startup reconciles every non-final intent against chain state. Notification delivery is deliberately outside the state decision path.

Policies are database-backed and editable independently at wallet or target scope, with target values taking precedence. A null override inherits the next level. Defaults are deliberately conservative:

- Maximum transaction value: `0.1` native token; large enough for ordinary public mints while limiting the impact of malformed values. Default rolling daily wallet budget: `0.25` native token.
- Simulation: on. Transaction timeout: 10 minutes.
- Ethereum: 12 confirmations, 200 Gwei ceiling.
- Base: 10 confirmations, 5 Gwei ceiling.
- Arbitrum: 20 confirmations, 5 Gwei ceiling.
- Polygon: 128 confirmations, 500 Gwei ceiling.

The confirmation counts are operational safety thresholds chosen to be conservative relative to each chain's block cadence and ordinary short reorg exposure; they are not claims of protocol-level economic finality. Wallet and target values remain editable through the transaction-policy repository, while the governance rules below constrain their effective result for regular users.

### Owners, seat groups, and modes

Owner status belongs to the internal linked-account user, so it applies across that user's Telegram and future Discord identities. Owners can administer groups, user overrides, simulation enforcement, presets, and other owners. Owner-originated transactions remain subject to balance, simulation, signing, chain-ID, nonce, and persistence checks but are exempt from maximum-value, daily-budget, and gas ceilings.

Regular-user ceiling precedence is individual override, then seat group, then the conservative Milestone 7 default. A stricter wallet/target policy still wins. Simulation-forcing precedence is individual rule, then group rule, then forced-on default; it always overrides both a selected preset and a direct wallet/target setting.

The editable presets are `Ultra Fast`, `Fast`, `Semi-Safe`, and `Safe`. Their stored human-verification setting is preparatory only and cannot bypass anything until Milestone 10c implements the confirmation flow. `Fast` uses the contextual `blockchain_off` simulation mode: blockchain-triggered requests skip simulation when permitted, while other sources simulate.

Admin syntax uses precise wei values for monetary ceilings:

```text
/admin group-set <name> <maxWei> <dailyWei> <gasGwei> <forced|optional>
/admin group-delete <name>
/admin assign <telegram|discord> <platformUserId> <group>
/admin unassign <telegram|discord> <platformUserId>
/admin user-ceilings <platform> <platformUserId> <maxWei> <dailyWei> <gasGwei>
/admin user-ceilings-clear <platform> <platformUserId>
/admin user-simulation <platform> <platformUserId> <forced|optional|inherit>
/admin group-simulation <group> <forced|optional|inherit>
/admin preset-set <preset> <on|off|blockchain_off> <confirmations> <on|bypass>
/admin owner <platform> <platformUserId> <on|off>
/mode <ultra_fast|fast|semi_safe|safe>
```

Admin commands never bootstrap ownership. Before the first deployment, a database administrator must designate the initial trusted linked user directly, for example with a reviewed one-time `UPDATE users SET is_owner=TRUE WHERE user_id=...`. Thereafter, only an existing owner can add or remove owners, and the last owner cannot be removed.

### Flexible mint calls and presets

Flexible minting uses a finite built-in ABI registry. Supported signatures are `mint()`, `mint(uint256)`, `mint(address,uint256)`, `mint(uint256,uint256,bytes)`, `mint(address,uint256,uint256,bytes)`, `mint(uint256,bytes32[])`, `mint(address,uint256,bytes32[])`, `mint(uint256,bytes)`, and `mint(address,uint256,bytes)`. Caller-supplied ABI fragments and arbitrary calldata are rejected.

`/mintcall` accepts one JSON object containing `walletLabel`, `contractAddress`, `methodSignature`, `arguments`, optional `valueWei`, optional `chain`, and optional `proofUrl`. Use `"$wallet"` for a recipient that should resolve to the selected wallet. A proof array or signature can be supplied directly in `arguments`. A JSON proof file can instead be uploaded to Telegram with the `/mintcall <JSON>` command as its caption, omitting the authorization argument from the caption's array.

Automatic authorization lookup accepts public HTTP/HTTPS URLs or `ipfs://` URIs. `{address}` in a URL is replaced with the wallet address; otherwise an `address` query parameter is added. Empty, malformed, inaccessible, credential-bearing, localhost, and private-IP URLs fail closed with an explicit manual-entry-required response. The bot never proceeds with an empty proof or signature.

Before transaction submission the bot sends a decoded preview containing the contract, registered signature, standard, named human-readable arguments, proof/signature presence, and native value. The exact encoded calldata shown by that preview is passed into Milestone 7's simulation and transaction pipeline. Transaction intents persist the signature and decoded preview for auditability.

Reusable presets are user-owned and case-insensitively named:

```text
/mintpreset save {"name":"Drop","walletLabel":"Primary","contractAddress":"0x...","methodSignature":"mint(address,uint256)","arguments":["$wallet",2],"valueWei":"0","chain":"ethereum"}
/mintpreset use {"name":"Drop","walletLabel":"Primary"}
/mintpreset delete Drop
/mintpresets
```

For remote-proof presets, save `proofUrl` and omit the proof/signature argument; authorization is fetched again for the executing wallet on each reuse. Scheduled-task internals and sniper-specific preset consumption remain deferred to Milestones 9 and 10.

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
|   |-- scheduler/         Durable task repository and polling worker
|   `-- workers/           Future blockchain/social watcher workers
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

Linked-account dashboard login, observability, and operational hardening remain future milestones.

## Validation

Before opening a pull request or deploying, run:

```powershell
npm ci
npm run validate
```

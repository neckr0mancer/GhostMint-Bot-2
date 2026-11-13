# GhostMint Railway migration and recovery runbook

This is the repeatable procedure for moving GhostMint to another Railway project or database.
It deliberately contains no credentials, database URLs, platform IDs, or user IDs. Keep those in
Railway variables or a password manager—never in Git, logs, screenshots, or chat.

## What happened in the temporary recovery

The move to the current temporary Railway was a **fresh rebuild**, not a historical database
migration:

1. A new Railway project/environment and Postgres service were created.
2. The GhostMint application service was connected to the GitHub repository.
3. Runtime variables were recreated in Railway and database reference variables were wired.
4. `railway.json` built the dashboard and ran `node scripts/migrate.js && node index.js`, so the
   empty database received the complete schema before the app started.
5. The trusted platform identity was recreated/linked and owner access was restored.
6. Wallets were imported again through the application.
7. Telegram and Discord were smoke-tested; Discord's guild/channel restrictions were corrected.

Because no logical dump from the expired database was restored, old activity, tasks, P&L records,
snipers, watch rules, sessions, notifications, and transaction history did not move. Importing a
wallet restores its address/key access only; it cannot reconstruct GhostMint records or arbitrary
on-chain history. A permanent move must use the full-data procedure below.

## What the subsequent new-account recovery added

The later move from another expired Railway trial used the same fresh-start model and exposed a few
steps that were not explicit above:

1. Production was provisioned with Postgres, PgBouncer, point-in-time recovery, a generated domain,
   an explicit `/health` check, and the explicit start command
   `node scripts/migrate.js && node index.js`.
2. The destination database was proven empty before first boot. Because no encrypted rows were
   restored, production received a new strong `ENCRYPTION_SECRET`; an inaccessible, invalid, or
   short secret from an abandoned empty database was not copied forward.
3. The application was first deployed without bot credentials. All migrations ran through the
   unpooled connection, and the next deployment reported zero pending migrations.
4. Existing bot/provider values were copied manually by variable name. Optional variables that did
   not exist in the source were left absent rather than created as blank placeholders.
5. Startup logs were checked by safe configuration booleans only. Telegram acquired its polling
   lock, Discord authenticated, OpenSea was configured, every enabled chain RPC answered, and
   GoldRush remained configured but ingestion-disabled.
6. The trusted user sent Telegram `/start`, requested a dashboard link, logged in with that link,
   and reimported the wallet. Discord must then be linked to that same internal account before any
   ordinary Discord command is used.
7. A separate `local-test` environment contained disposable Postgres only—never the production app,
   bots, wallets, or automation. Migrations were run twice there and temporary Railway SSH keys were
   revoked and deleted after the rehearsal.

This sequence is the verified fresh-start path. It recreates service and account access; it does
not recover records from an unavailable old database.

## Non-negotiable safety rules

- Keep the old project and database intact until the new deployment passes acceptance and the
  rollback window closes.
- Never run old and new bot/worker fleets against copied active data at the same time. Database
  locks cannot coordinate processes connected to different databases; copied schedules or snipers
  could submit twice.
- Freeze writes and stop the old service before the final dump. Keep it stopped until cutover or
  rollback is chosen.
- Preserve `ENCRYPTION_SECRET`, `ENCRYPTION_KEY_VERSION`, and every required entry in
  `ENCRYPTION_OLD_KEYS` exactly when moving encrypted wallets. Losing an old key version can make
  restored wallets permanently unreadable. Rotate keys only as a separate, verified operation.
- Use direct/unpooled database connections for dumps, restores, and migrations. Normal application
  queries use the pooled URL.
- Do not mint, schedule, approve a trigger, or spend funds during smoke testing unless that exact
  value-moving action has been explicitly authorized.

## 1. Access and tools checklist

Have all of the following before starting:

- Access to the destination Railway workspace in a browser.
- GitHub collaborator access to the GhostMint repository and permission for Railway's GitHub app.
- Access to both source and destination Postgres direct/public URLs, or Railway tunnels.
- DNS access if a custom domain will move.
- Telegram BotFather and Discord Developer Portal access only if a token must be recovered or
  rotated; do not rotate working tokens merely because the database moves.
- Access to RPC, OpenSea, Etherscan, and social-provider accounts used by production.
- Compatible `pg_dump`, `pg_restore`, and `psql` clients.

A Railway workspace token, if used, is a local operator credential only. Never add it to the
application's Railway variables or the repository.

The verified Windows CLI for the later recovery was the clean bundled copy under
`.project-tools/railway-cli-v5.71.0-clean/railway.exe`, with automatic updates disabled for each
operator session:

```powershell
$env:RAILWAY_NO_AUTO_UPDATE = '1'
& .\.project-tools\railway-cli-v5.71.0-clean\railway.exe status
```

Use `railway status` before every operation to verify the linked project, environment, and service.
Do not continue merely because the browser is logged in; browser and CLI sessions can belong to
different Railway accounts.

## 2. Inventory the source before changing it

Record in a private change ticket:

- deployed Git commit SHA and source branch;
- highest applied `schema_migrations.filename`;
- current domain(s), health status, replica count, and deployment region;
- the **names** of all configured variables, not their values;
- whether PgBouncer, volume backups, and point-in-time recovery are enabled;
- counts and latest timestamps for durable tables, especially `users`, `linked_accounts`,
  `wallets`, `mint_tasks`, `mint_task_attempts`, `transaction_intents`, `activity`, `pnl_records`,
  `snipers`, `sniper_seen_transactions`, `social_watch_rules`, `social_trigger_events`,
  `dashboard_sessions`, and `schema_migrations`;
- owner/root-owner counts and wallet encryption-key versions.

Useful read-only checks:

```sql
SELECT MAX(filename) FROM schema_migrations;
SELECT COUNT(*) FROM users WHERE is_owner = TRUE;
SELECT COUNT(*) FROM users WHERE is_root_owner = TRUE;
SELECT encryption_key_version, COUNT(*) FROM wallets GROUP BY 1 ORDER BY 1;
```

Also record every non-final scheduled task, transaction, and sniper. Decide whether it must finish,
be paused/cancelled, or move with the database; never discover active automation after cutover.

## 3. Provision the destination

1. Create the Railway project and production environment.
2. Add a Postgres service.
3. Enable scheduled volume backups and, for a lasting production database, point-in-time recovery.
4. Add PgBouncer from **Postgres → Database → Config → Connection Pooling → Add PgBouncer** and
   choose transaction mode. Confirm it is deployed; standard Railway Postgres starts with direct
   connections only.
5. Add the application service from GitHub and select the intended production branch. Do not start
   bots/workers yet: delay the first deployment or initially omit bot credentials.
6. Configure `/health` as the Railway healthcheck path and listen on Railway's injected `PORT`.

After managed pooling, Railway exposes pooled `DATABASE_URL` and direct
`DATABASE_UNPOOLED_URL` variables. GhostMint intentionally calls the latter
`DATABASE_URL_UNPOOLED`, so application references normally look like:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_URL_UNPOOLED=${{Postgres.DATABASE_UNPOOLED_URL}}
```

Replace `Postgres` with the real service namespace. Use public variants only from a local operator
machine/tunnel, not for application-to-database traffic inside Railway. Keep `DATABASE_POOL_MAX`
small (the app accepts 1–10; 5 is normal) because PgBouncer performs the multiplexing.

Current Railway references:

- [PgBouncer connection pooling](https://docs.railway.com/guides/connection-pooling-pgbouncer)
- [Postgres backup and restore](https://docs.railway.com/guides/postgres-backups-restores)
- [Variables and reference variables](https://docs.railway.com/variables)
- [Deployment healthchecks](https://docs.railway.com/deployments/healthchecks)
- [GitHub autodeploys](https://docs.railway.com/deployments/github-autodeploys)
- [Public domains](https://docs.railway.com/networking/domains/working-with-domains)

## 4. Recreate application variables safely

Use `.env.example` as the canonical **name inventory**, then compare it with `src/config/index.js`.
Copy values through Railway's Variables UI or reference variables; never paste secrets into this
document. Review these groups:

- Runtime: `NODE_ENV=production`, `SUPPORTED_CHAINS`, `DATABASE_POOL_MAX`, RPC timeout/retry and
  transaction-bump settings. `ethereum` must currently remain in `SUPPORTED_CHAINS`.
- Encryption: exact `ENCRYPTION_SECRET`, `ENCRYPTION_KEY_VERSION`, and `ENCRYPTION_OLD_KEYS`.
- Bots: `TELEGRAM_BOT_TOKEN`; both `DISCORD_BOT_TOKEN` and `DISCORD_APPLICATION_ID`.
- Discord restrictions: set `DISCORD_DEV_GUILD_ID` only when intentionally restricting the bot to
  one development guild (it also blocks DMs elsewhere). Set `DISCORD_CHANNEL_IDS` only for an
  intentional channel allowlist. A stale value here caused the previous “bot is not enabled here”
  failure.
- Providers: every configured chain's HTTP URL list, optional WebSocket/fast/sniper lanes,
  `OPENSEA_API_KEY`, optional separate `OPENSEA_READ_API_KEY`, `ETHERSCAN_API_KEY`, and social
  adapter URLs/tokens. Each RPC list has a hard cap of five unique URLs. `OPENSEA_API_KEY` is
  operationally required for the complete OpenSea stage catalog and OpenSea-built gated mints:
  without it, GhostMint can verify only SeaDrop's single on-chain public phase and must not claim
  that no allowlist phases exist. If an instant free-tier key is used, record its expiry and rotate
  it before expiry; prefer a long-lived developer key for a permanent production deployment.
- Scheduler/transaction tuning such as `SCHEDULE_PREARM_LEAD_MS` and `TX_BUMP_*`.

Do **not** deploy cleanup, merge, or live-acceptance confirmation variables. Never set
`GHOSTMINT_DASHBOARD_ONLY=true` in production; startup rejects it.

Do not create blank values for optional entries that were absent in the source. In particular:

- `OPENSEA_READ_API_KEY` is only for a genuinely separate read key. With it absent,
  `OPENSEA_API_KEY` remains the OpenSea key and startup reports `openSeaReadKeySeparate:false`.
- `ETHERSCAN_API_KEY` enables the Etherscan-specific gas source but is not required for application
  startup or ordinary RPC health.
- `SOCIAL_OFFICIAL_API_URL`, `SOCIAL_OFFICIAL_API_TOKEN`,
  `SOCIAL_MANAGED_SERVICE_URL`, `SOCIAL_MANAGED_SERVICE_TOKEN`, and
  `SOCIAL_POLL_INTERVAL_MS` are optional adapters/tuning. Their absence is valid when the configured
  scraper/fallback is the intended source.
- `GOLDRUSH_API_KEY` only proves that the provider is configured. Keep
  `WALLET_HISTORY_GOLDRUSH_ENABLED=false` and `WALLET_HISTORY_WORKER_ENABLED=false` until the
  semantic canary is approved. `WALLET_HISTORY_CHAINS`,
  `WALLET_HISTORY_WORKER_INTERVAL_MS`, and `WALLET_HISTORY_WORKER_LEASE_MS` may stay absent while
  the worker is disabled.
- Missing custom `*_RPC_FAST_URLS`, `*_RPC_SNIPER_URLS`, `*_RPC_WS`, and
  `*_RPC_SNIPER_WS` entries mean those optimized/pending lanes are unavailable; they do not imply
  that the normal chain RPC is down. Confirm this distinction in the startup summary and `/health`.

Never copy Railway-injected `RAILWAY_*` values, `PORT`, local test-database confirmation values,
cleanup confirmations, account-merge inputs, live-acceptance confirmations, or a local
`GHOSTMINT_DEV_API_TARGET` into production. `ALCHEMY_API_KEY` by itself is not consumed by the
current runtime; configure complete RPC URLs instead. Set `DISCORD_DEV_GUILD_ID` or
`DISCORD_CHANNEL_IDS` only when that restriction is deliberately required.

`railway variable list --json` contains raw values. Do not paste or log its output. Use Railway's
redacted UI or a local wrapper that discards every value and prints only sorted variable names.

Railway variable changes are staged and require a deploy. Review the redacted list twice before
applying it.

After the deploy, filter the startup log for `Configuration loaded` and verify the safe summary
contains `"openSeaConfigured":true`. This check exposes only configuration presence, never the
key. Then paste a known multi-stage drop into Schedule and confirm every provider stage and its
exact project-authored label appears; seeing only `Public` means the app is safely using the
incomplete on-chain fallback and the OpenSea variable still is not effective.

## 5. Full historical data move

This section is required for a permanent migration.

### 5.1 Freeze the source

1. Announce a maintenance window.
2. Stop new schedules/snipers and allow or deliberately stop in-flight work.
3. Stop/suspend the old application and confirm no old worker or bot remains.
4. Take a Railway volume backup/PITR checkpoint.

### 5.2 Dump the old direct database

Set a local, temporary operator variable to the source public-unpooled URL, then create a custom
format dump. Do not echo the variable or commit it.

```powershell
pg_dump $env:OLD_DATABASE_PUBLIC_UNPOOLED_URL `
  --format=custom --no-owner --no-acl `
  --file "ghostmint-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')).dump"
```

Record the dump timestamp, size, hash, and encrypted storage location.

### 5.3 Restore into an empty destination

Restore the full dump before running pending migrations. Do not pre-create a competing schema and
overlay another full schema unless deliberately performing a data-only restore.

```powershell
pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error `
  --dbname $env:NEW_DATABASE_PUBLIC_UNPOOLED_URL `
  .\ghostmint-YYYYMMDD-HHMMSS.dump
```

Point local `DATABASE_URL_UNPOOLED` at the destination direct connection and run migrations twice:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\project-npm.ps1 run db:migrate
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\project-npm.ps1 run db:migrate
```

The first run applies only pending files; the second must apply zero. `scripts/migrate.js` uses the
unpooled connection, an advisory lock, one transaction per file, and redacts connection strings.

### 5.4 Disposable database rehearsal

When the production database must remain available, create a separate Railway environment with a
disposable Postgres service only. Do not deploy the GhostMint app or copy bot/provider credentials
into it. Point the integration-test connection at its direct/public URL or a temporary Railway
tunnel, verify the database identity marker, run migrations twice, and run only the tests affected
by the database change.

If Railway SSH/tunnelling requires a temporary key, create a dedicated key rather than reusing a
personal default. When testing is finished:

1. close the tunnel;
2. remove the temporary public key from Railway;
3. delete the exact temporary private and `.pub` files locally; and
4. run `railway ssh keys list` and confirm the key is absent.

A second cleanup command can report that the file no longer exists; that is expected after the
first cleanup succeeds. Never delete a broad `.ssh` directory or an unverified path.

### 5.5 Reconcile data before starting the app

Compare source and destination row counts, latest timestamps, owner/root-owner counts, key-version
counts, highest migration, active task states, and transaction idempotency keys. Perform a
no-value wallet decrypt/address canary through application code; never print or export a key.

## 6. Fresh-start fallback

Use this only when the old database cannot be recovered and explicitly accept that historical
GhostMint data will be lost:

1. Point the new app at an empty Postgres database.
2. Let `node scripts/migrate.js && node index.js` build/start it.
3. Have the first trusted Telegram identity send `/start`, request a dashboard link code, enter it
   on the dashboard, and verify that the resulting dashboard session belongs to the intended
   internal user.
4. In one reviewed database transaction, promote exactly that verified user with both
   `is_owner=TRUE` and `is_root_owner=TRUE`; confirm exactly one intended row changed.
5. Reimport wallets through the encrypted application flow and confirm their public addresses—do
   not reveal or export private keys during acceptance.
6. Link Discord to that same internal identity with `/link` before first using any other Discord
   command, so it does not auto-create a second user.
7. Recreate desired settings/rules and verify every cross-surface record uses the same internal
   account.

This is the procedure used for the temporary recovery. It does not recover activity or wallet
history.

## 7. Deploy and cut over

`railway.json` builds with `npm run dashboard:build` and starts with
`node scripts/migrate.js && node index.js`, so pending migrations run automatically on each start.

1. Disable GitHub autodeploy while staging the move, or ensure no push starts it unexpectedly.
2. Deploy without bot credentials first when practical. Verify migrations, `/health`, the
   dashboard shell, and owner-only health view.
3. Confirm `/health` distinguishes database, RPC, scheduler/preflight, watcher, retention, and
   sniper status. Railway healthchecks gate deployment activation; they are not continuous
   monitoring, so add an external uptime check.
4. Stop the old service before enabling the same Telegram/Discord credentials on the destination.
5. Add bot credentials to the new service and deploy the staged change.
6. Generate a temporary Railway domain for smoke testing. Move custom domain/DNS only after TLS
   and authenticated flows pass.

### One-time schedule-policy migration maintenance window

Migration `065_schedule_change_policies.sql` adds the price/time/config approval envelope. An old
worker does not understand that envelope. Before the first deployment containing migration 065,
stop/drain the old app and confirm no `mint_tasks` row is actively `claimed`; then start the new
release and let it migrate. Accept a short maintenance window—do not let Railway's old and new
deployments overlap while active schedules exist. This prevents an old worker from claiming a task
during the new release's healthcheck window and bypassing the new review policy.

## 8. Acceptance checklist

Complete these without a value-moving final action unless separately authorized:

- `/health` is 200 and every dependency section is healthy.
- Logs show migrations used the unpooled connection; a second run has nothing pending.
- Telegram `/start` and `/link` work.
- Discord `/menu` works in the intended context and DMs match configuration.
- A link code logs into the dashboard; WebSocket live updates connect.
- Owner/root-owner state and linked Telegram/Discord identity are correct.
- Expected wallets, tasks, activity, P&L, snipers, watch rules, presets, and policies are present.
- History and Transactions resolve to a populated, empty, disabled, or retryable-error state; they
  must not remain on a loader after their API request returns. Confirm `/api/history/transactions`
  is successful separately from the rendered state. A disabled wallet-history worker must be shown
  truthfully and must not be mistaken for a recovered/backfilled ledger.
- Wallet rows decrypt to their existing public address without revealing private keys.
- Non-value contract detection, preview, scheduling-plan, pagination, and admin health reads work.
- No duplicate bot instance or scheduler fleet is running.
- An external monitor is configured because Railway's deploy healthcheck is not continuous.

After any service move, update local Vite's API target. `dashboard/vite.config.js` can be overridden
with `GHOSTMINT_DEV_API_TARGET`; a stale target previously caused local login/API 404 failures.

Railway currently warns that `railway.json` Config as Code is deprecated and remains supported only
until 2026-12-01. This warning does not invalidate a healthy deployment, but migration to
`.railway/railway.ts` must be handled as a separate reviewed infrastructure change before that date.

## 9. Rollback

- Before new writes: stop the destination, restore the old domain/variables, and re-enable the old
  app against its untouched database.
- After new writes: do not point users back at a stale old database. Stop writes, restore the
  destination from PITR/backup or forward-fix it; switching back requires an explicit delta merge.
- A Git revert changes code only. Migrations are forward-only; it does not undo schema. For a
  schema rollback, restore a pre-migration snapshot/PITR fork, verify it, and cut over deliberately.
- Record cutover/rollback time, old/new commit SHA, highest migration, dump identity/hash, row
  counts, domain changes, and the person who verified owner access.

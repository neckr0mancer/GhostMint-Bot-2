# GhostMint Project Roadmap

This is the ordered implementation plan for GhostMint. Milestones are intentionally sequenced so automated triggers and bypass modes are built only after transaction, scheduling, and watcher safety rails exist.

## Completed foundation

### Milestone 1 — Repository baseline and local reliability

- Establish predictable install, start, health-check, lint, test, and validation workflows.
- Document local and deployment prerequisites without committing secrets.

### Milestone 2 — Safe configuration

- Centralize environment loading and fail closed on missing, weak, malformed, or unsupported configuration.
- Validate runtime modes, chains, RPC URLs, and secret strength without logging sensitive values.

### Milestone 3 — Durable PostgreSQL storage

- Replace JSON persistence with PostgreSQL migrations and user-independent repository boundaries.
- Use pooled application connections and the direct connection only for migrations.

### Milestone 4 — Private-key security

- Encrypt wallet keys with versioned AES-256-GCM envelopes and unique salts/nonces.
- Support master-key rotation, authenticated tamper detection, and key redaction.

### Milestone 5 — Multi-user platform identity

- Resolve Telegram identities to internal UUID users and scope every resource by owner.
- Support short-lived, single-use, platform-neutral account-link codes for Telegram and Discord identities.

### Milestone 6 — Request validation and domain rules

- Define shared schemas for every active API and bot-command request.
- Validate addresses, supported chains, wallet labels, quantities, prices, gas/fee caps, function/ABI inputs, schedules, sniper settings, and P&L identifiers.
- Replace timestamp-derived identifiers with database-generated IDs or UUIDs.
- Reject invalid or overly distant schedules before they reach timer logic, including the 24.8-day `setTimeout` overflow case.
- Return consistent validation failures across HTTP and bot interfaces.

### Milestone 7 — Transaction engine and spend safety

- Centralize signing and broadcasting behind a transaction service.
- Add simulation, spend caps, gas/fee ceilings, nonce queues, replay protection, and actionable failure classification.
- Ensure no command or automated trigger bypasses the same transaction-safety pipeline.

### Milestone 7a — Roles, ceilings, and editable mode presets

- Add internal-user owner roles, owner-managed seat groups, per-user ceiling overrides, and forced-simulation governance.
- Add editable Ultra Fast, Fast, Semi-Safe, and Safe presets while ensuring ceilings and forced simulation always take precedence.
- Keep preset human-verification choices as stored preparatory configuration for Milestone 10c; do not activate bypass behavior here.

## Remaining implementation

### Milestone 8 — Mint flexibility

- Support validated custom mint functions, ABI definitions, arguments, quantities, values, and chain-specific fee options.
- Keep flexible calldata construction behind the validation and transaction-safety boundaries from Milestones 6 and 7.

### Milestone 9 — Durable scheduler

- Replace process-local long-duration timers with durable claiming, leasing, retry, and recovery behavior.
- Handle schedules beyond Node's timer limit without overflow and prevent duplicate execution across restarts or multiple instances.

### Milestone 10 — Blockchain watcher and sniper hardening

- Add durable deduplication, confirmation depth, reorg handling, target-level limits, and safe retry behavior.
- Route every copy-mint through the same simulation, spend-cap, nonce, and activity-audit pipeline.

### Milestone 10a — Discord bot

- Add Discord command parity for wallets, minting, batch minting, tasks, activity, gas, cancellation, and wallet removal.
- Build on the Milestone 5 platform-neutral identity system.
- Use the existing account-link flow so a Discord account can join an existing user instead of creating a separate identity.

### Milestone 10b — Social watcher

- Monitor configured Twitter/X accounts and Discord announcement channels.
- Detect contract-address patterns with optional keyword filters.
- Feed detected addresses into the existing mint pipeline as a trigger source parallel to the Milestone 10 blockchain watcher.

### Milestone 10c — Per-target trigger and verification configuration

Each tracked contract, copied wallet, or social source receives independent settings:

- Blockchain trigger: `Auto` or `Manual`.
- Social trigger: `Auto` or `Manual`.
- Human verification: `On` or `Bypassed`.

Rules:

- Blockchain-auto does not force verification.
- Social-auto enables human verification by default. A user may explicitly request bypass.
- Enabling bypass always presents a highest-risk warning and requires an explicit `CONFIRM` reply before taking effect.
- The warning includes a per-target-only “don't ask again” option. It never applies globally and is reset when the target is removed/re-added or its configuration is reset.
- Every executed mint records the trigger source and whether verification was on or bypassed at execution time, regardless of whether the warning was displayed for that toggle.

Milestones 10a, 10b, and 10c depend on the safety infrastructure from Milestones 6–10: validation, spend caps, simulation, nonce queues, durable scheduling, deduplication, and reorg handling. They must not be implemented earlier because automated or bypassed execution has no human check between trigger and spend.

### Milestone 11 — Secure Telegram and Discord bot integration

- Apply consistent command authorization, rate limits, audit metadata, safe replies, and ownership checks to both Telegram and Discord.
- Verify linked platform identities before every read, mutation, or transaction request.
- Ensure platform-specific adapters cannot bypass shared validation, transaction, or tenant-isolation services.

### Milestone 12 — Observability and production operations

- Add structured redacted logs, readiness checks, metrics, alerting, graceful shutdown, and dependency health reporting.
- Complete backup/restore drills, deployment runbooks, rollback procedures, and production incident guidance.

### Milestone 13 — Linked-identity web dashboard

- Build the dashboard on the same Telegram/Discord-linked internal identity rather than a shared password.
- Restore browser workflows only after secure linked-account login, authorization, CSRF/session protection, and the earlier transaction safety milestones are complete.

## Production definition of done

### Mandatory pre-Milestone 16 live acceptance TODO

- Before Milestone 16 (production release gate), perform one controlled live testnet acceptance run using a real RPC, a disposable funded testnet wallet, and a deployed test mint contract.
- This is mandatory because Milestone 7 has only been verified with mocked providers and database-backed automated tests. Defer the one-time run until after Milestones 8–10 stabilize mint construction so it does not need to be repeated unnecessarily.
- Do not release to production or use meaningful funds until that live acceptance run passes and its evidence is recorded.

- All validation, lint, unit, integration, migration, and smoke checks pass in CI.
- Every user-owned read and write is tenant-scoped.
- Every transaction path uses simulation, spend limits, fee caps, nonce coordination, and durable audit records.
- Automated triggers cannot bypass configured verification or safety rails silently.
- Deployment, monitoring, backup, restore, rollback, and key-rotation procedures have been exercised successfully.

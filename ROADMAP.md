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

### Milestone 8 — Flexible mint support

- Encode only an audited registry of common ERC-721, ERC-1155, proof-based, and signature-based mint shapes; reject arbitrary ABI and calldata construction.
- Support manual/uploaded authorization data plus fail-closed public HTTP/IPFS proof lookup, reusable user-owned mint presets, decoded previews, and simulation of the exact encoded call.

### Milestone 9 — Durable scheduler

- Replace process-local long-duration timers with database-backed due times, atomic multi-instance claiming, leases, attempt history, and bounded retry behavior.
- Recover expired claims from persisted transaction intents and chain state, enforce task idempotency, and provide owner-scoped cancel, pause, resume, and retry controls.
- Store and display authoritative schedule timestamps in UTC while safely supporting schedules beyond Node's timer limit.

### Milestone 10 — Post-confirmation copy-mint hardening

- Persist source-event state and transition history, deduplicate delivery across instances/restarts, and verify canonical source receipts after configurable confirmations.
- Enforce validated per-sniper value, gas, daily-spend, cooldown, attempt, and contract-list limits through the shared transaction engine.
- Isolate each sniper's failures and label this feature accurately as post-confirmation copying rather than mempool front-running.

## Remaining implementation

### Milestone 10a — Discord bot

- Add Discord command parity for wallets, minting, batch minting, tasks, activity, gas, cancellation, and wallet removal.
- Build on the Milestone 5 platform-neutral identity system.
- Use the existing account-link flow so a Discord account can join an existing user instead of creating a separate identity.

### Milestone 10b-1 — Social watcher framework and initial adapters

- Build a pluggable watch-rule architecture in which every source is a typed record with a `type` and adapter-specific configuration; adding later watch types must not require redesigning the watcher core.
- Initially support `twitter_account`, `twitter_keyword`, `discord_channel`, and `discord_keyword` rules.
- Give every source a user-selected `method` of `official_api`, `managed_service`, or `scraper`; core detection and mint-trigger logic remains independent of the active acquisition method.
- Feed detected contract addresses into the mint pipeline as social trigger sources parallel to the Milestone 10 post-confirmation blockchain watcher.

### Milestone 10b-2 — Additional social adapters (optional, unscheduled)

- Add platform or watch-type adapters beyond the initial Twitter/X and Discord account/keyword set using the Milestone 10b-1 framework.
- This milestone is optional and has no scheduled implementation date.

### Milestone 10c — Per-target trigger and verification configuration

Each tracked contract, copied wallet, or social watch rule receives independent settings. Configuration consumes trigger sources from both the Milestone 10 blockchain watcher and whichever Milestone 10b-1 social watch rules exist:

- Blockchain trigger: `Auto` or `Manual`.
- Social trigger: `Auto` or `Manual`.
- Human verification: `On` or `Bypassed`.

Rules:

- Blockchain-auto does not force verification.
- Social-auto enables human verification by default. A user may explicitly request bypass.
- Enabling bypass always presents a highest-risk warning and requires an explicit `CONFIRM` reply before taking effect.
- The warning includes a per-target-only “don't ask again” option. It never applies globally and is reset when the target is removed/re-added or its configuration is reset.
- Every executed mint records the trigger source and whether verification was on or bypassed at execution time, regardless of whether the warning was displayed for that toggle.

Milestones 10a, 10b-1, 10b-2, and 10c depend on the safety infrastructure from Milestones 6–10: validation, spend caps, simulation, nonce queues, durable scheduling, deduplication, and reorg handling. They must not be implemented earlier because automated or bypassed execution has no human check between trigger and spend.

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

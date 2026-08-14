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

### Milestone 10b-2 — Additional social adapters (optional)

- Add platform or watch-type adapters beyond the initial Twitter/X and Discord account/keyword set using the Milestone 10b-1 framework.
- Implemented: `farcaster_account` and `farcaster_keyword` watch types, reusing the existing `official_api`/`managed_service`/`scraper` acquisition methods unchanged. Added `WATCH_TYPE_PLATFORMS` as the single source of truth mapping a watch-rule type to its platform, so adapters fail closed instead of guessing a platform for an unmapped type.
- Further platforms or watch types beyond Farcaster remain optional and unscheduled.

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

Milestone 13 is divided into these ordered, independently testable build phases:

- **13a — Foundation:** React/Vite SPA scaffold, static hosting from the existing Express deployment, linked-account `/link` code login, server-side sessions and CSRF protection, authenticated per-user WebSocket scaffold, and the responsive base layout.
- **13b — Core operations:** Wallets, manual and batch minting, scheduled tasks, activity, and P&L dashboard workflows.
- **13c — Triggers:** Snipers, social watch rules, target policies, and real-time confirmation approval over the authenticated WebSocket channel.
- **13d — Admin/governance:** Groups, ceilings, editable presets, and owner management.
- **13e — Settings/reporting:** Gas, social API usage statistics, and general settings.

Technology decisions for all Milestone 13 phases:

- Frontend: React with Vite using plain JavaScript.
- Hosting: a static production build served by the existing Express server on the same domain.
- Authentication: the existing Milestone 5 platform-neutral `/link` code flow; no dashboard password system.
- Real-time transport: WebSocket authenticated by the server-side session cookie and scoped to the internal `user_id`.

### Milestone 14 — Live testnet acceptance run tooling

- Add an operator-only, owner-scoped CLI tool that drives one controlled live testnet mint through the unmodified Milestone 7 transaction engine and Milestone 8 mint-construction pipeline (no bypass path): real RPC, a disposable funded testnet wallet already onboarded through the existing encrypted wallet flow, and a deployed test mint contract.
- Add a durable, redacted audit record of each attempted run (chain, contract, wallet, transaction intent linkage, policy ceilings applied, simulation outcome, confirmations, pass/fail) so evidence survives beyond a local file.
- Add a runbook documenting the exact human steps to fund a throwaway wallet, deploy a disposable test mint contract, and execute the tool, since the run itself requires real (testnet) secrets this project must never request, log, or store outside the existing encrypted wallet path.
- This tooling exists because Milestone 7 has only been verified with mocked providers and database-backed automated tests to date. Executing the actual one-time live run against real testnet infrastructure is a manual operational step for the project owner, not something automated in CI, and remains gated on real testnet credentials the owner supplies outside of chat/CLI logs.
- Do not release to production or use meaningful funds until that live acceptance run has actually been executed with this tooling and its evidence recorded as passing.

### Milestone 15 — Conversational bot UX and session integrity

Telegram and Discord today are entirely regex/slash-argument driven with plain-text replies; there is no persistent menu, no button-based navigation, and Telegram never registers its command list with `setMyCommands`, so its `/` autocomplete is unreliable. This milestone makes both bots feel like interactive products rather than a command reference, without touching the underlying validation, transaction, or governance services they already call correctly.

- **15a — Command discovery and a persistent main menu:** Register Telegram's command list via `setMyCommands` so `/` autocomplete is always populated. Add a button-based main menu (Telegram inline keyboard; Discord already has structured slash commands, so this phase adds equivalent embeds/buttons) reachable from `/start` and from a persistent "Menu" affordance, covering Wallets, Mint, Tasks, Snipers, Watch Rules, Activity, Gas, and Settings/Admin entry points. Implemented for Telegram: `setMyCommands` registration plus `src/telegram/menus.js`'s inline-keyboard main menu shown from `/start`/`/help`.
- **15b — Guided multi-step flows with cancel confirmation:** Add a per-user, per-platform in-memory flow-state tracker for multi-step actions (wallet create/import, funding, mint, task create, sniper create, etc.). If the user navigates away mid-flow (taps a different menu button, sends an unrelated command), the bot asks for explicit confirmation before abandoning the in-progress step; on confirmation, the flow state is fully cleared and the user is returned to the main menu. Flow state never bypasses existing validation or the M7 transaction engine — it only sequences the same requests that already exist as slash commands. Implemented for Telegram: `src/telegram/flowState.js` (a per-`(platform, chatId)` tracker) backs guided wallet create/import/balance/remove flows in `src/server.js`, with cancel-confirmation on any divergent button or slash command. Mint/Tasks/Snipers/Watch Rules/Activity/Gas still show a placeholder pointing to the equivalent slash command; guided wizards for those are unscheduled follow-up work.
- **15c — Discord parity:** Apply the same guided-flow and cancel-confirmation behavior to Discord using message components (buttons/select menus), through the same shared command service used by Telegram, per the Milestone 11 tenant-isolation and shared-validation guarantees. Implemented: a new `/menu` slash command plus `src/discord/menus.js` (raw Discord component payloads, mirroring the Telegram menu module) and a button/select-menu/modal router in `src/discord/discordBot.js`, reusing the same `(platform, chatId)`-namespaced flow-state store as Telegram (`src/telegram/flowState.js`, keyed by the Discord user's snowflake id) for wallet create/import/balance/remove and the identical cancel-confirmation behavior. Discord's guided wallet-create/import flow uses a modal for the label and (for import) the private key, and a select menu for the chain, since Discord interactions can't accept free-text follow-up messages the way Telegram can. Mint/Tasks/Snipers/Watch Rules/Activity/Gas placeholders match Telegram's scope.
- **15d — Dashboard link/session bug fix:** Investigate and fix the reported issue where generating a new `/link` code after a prior login/logout does not work as expected. Root cause must be confirmed against reproduction steps before a fix is written; this phase does not change the Milestone 13a session/CSRF model unless the root cause requires it. Investigated: `identityService.createLinkCode`/`consumeLinkCodeForSession` are correct (single-use, atomic, 5-minute TTL, prior unconsumed codes cleared per user) — there was no session/backend defect. The reported symptom was the same root cause as 15a's "`/` sometimes shows no options": Telegram's command list was never registered via `setMyCommands`, so `/link` was often not discoverable. Resolved by 15a's fix plus a "Link another platform" button in the new Settings menu (Telegram and Discord) that generates a link code inline without requiring the user to know the slash command.

This milestone changes presentation and interaction flow only. It must not introduce a second way to submit a transaction, alter spend/gas ceilings, or bypass the Milestone 6 validation schemas or Milestone 7 transaction engine — every button and guided step ultimately calls the same shared command service already used by the existing slash/text commands.

## Production definition of done

- All validation, lint, unit, integration, migration, and smoke checks pass in CI.
- Every user-owned read and write is tenant-scoped.
- Every transaction path uses simulation, spend limits, fee caps, nonce coordination, and durable audit records.
- Automated triggers cannot bypass configured verification or safety rails silently.
- Deployment, monitoring, backup, restore, rollback, and key-rotation procedures have been exercised successfully.

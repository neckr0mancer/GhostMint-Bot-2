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
- **15d — Dashboard link/session bug fix:** Investigate and fix the reported issue where generating a new `/link` code after a prior login/logout does not work as expected. Root cause must be confirmed against reproduction steps before a fix is written; this phase does not change the Milestone 13a session/CSRF model unless the root cause requires it. Investigated: `identityService.createLinkCode`/`consumeLinkCodeForSession` are correct (single-use, atomic, 5-minute TTL, prior unconsumed codes cleared per user) — there was no session/backend defect. The reported symptom was the same root cause as 15a's "`/` sometimes shows no options": Telegram's command list was never registered via `setMyCommands`, so `/link` was often not discoverable. Resolved by 15a's fix plus a "Link another platform" button in the new Settings menu that generates a link code inline without requiring the user to know the slash command.
- **15e — Telegram-only link-code generation:** Explicit product rule: Telegram is the only platform that can generate a link code; Discord and the dashboard may only consume one. Discord's `/link` `code` option is required (there is no bare `/link` on Discord), and its Settings menu button opens a modal to paste a Telegram-generated code rather than generating one. This closes an inconsistency from 15c, which had briefly given Discord's Settings menu the same generate-a-code button as Telegram's. Follow-up gap found in practice: both platforms still auto-create their own account on first contact regardless of this rule (`identityService.resolveOrCreate`), so a user who messages the bot on Discord before ever linking Telegram ends up with two separate accounts, and the Telegram link code then correctly refuses to attach to the already-linked Discord identity. Resolved for the common case where the duplicate account is empty via a new owner-only `merge-account` admin action (`identityService.mergeAccount`, backed by `postgresIdentityRepository.mergeAccount`'s emptiness check across every table that can hold real user data), reachable identically from Telegram, Discord, and the dashboard's Owner access page like any other admin action, plus `scripts/merge-duplicate-account.js` (`npm run merge:duplicate-account`) as a shell-only fallback that calls the same code path. It refuses and changes nothing if the duplicate has any real data, since that needs an actual data merge (not yet built). For bulk test-account cleanup where individual accounts don't need to be preserved, `scripts/clear-non-owner-users.js` (`npm run clear:non-owner-users`) permanently deletes every non-owner account and all attached data (including wallets); unlike merge-account it does not check for real data first, so it is intentionally shell-only with no bot/dashboard exposure, following the same manual/owner-only pattern as `scripts/rotate-keys.js`.

This milestone changes presentation and interaction flow only. It must not introduce a second way to submit a transaction, alter spend/gas ceilings, or bypass the Milestone 6 validation schemas or Milestone 7 transaction engine — every button and guided step ultimately calls the same shared command service already used by the existing slash/text commands.

### Milestone 16 — Account lifecycle and governance-group retention

Owners today can assign or remove a user from a governance group (Standard/VIP-style transaction-ceiling tiers) and grant or revoke owner status, but there is no way to block a misbehaving account from using the bot at all, and no way to keep group membership current automatically as users' standing changes over time. "Group" here means the existing internal governance tier (`seat_groups`, used for spend/gas ceilings) — not the actual Telegram group chat or Discord server the bot runs in, which this milestone does not touch.

- **16a — Account status: ban, suspend, deactivate, reinstate:** Add an `account_status` to every user (`active`, `suspended`, `banned`, `deactivated`), settable only by an owner, with a required reason and an audit trail of who changed it and when. "Deactivate" is a soft delete: it blocks the account from using the bot but keeps every wallet, task, activity record, and P&L entry intact and reversible, since wallets hold real encrypted private keys that must never be casually destroyed. "Ban" is permanent until an owner explicitly lifts it. "Suspend" is temporary: either time-boxed (auto-reinstated once `suspended_until` passes) or indefinite until an owner lifts it early. An owner account can never be banned/suspended/deactivated directly — owner status must be removed first, mirroring the existing last-owner protection on `setOwner`. Enforcement happens once, at `identityService.resolveOrCreate` (the single choke point every Telegram command, Discord command, and dashboard login already funnels through), so no bot surface can be blocked in one place and still reachable from another. Implemented: migration 028 adds `account_status`/`status_reason`/`status_changed_at`/`status_changed_by`/`suspended_until`/`subscription_active`/`good_standing_override` to `users`. `governanceService.js` gained `banUser`/`unbanUser`/`suspendUser`/`unsuspendUser`/`deactivateUser`/`reactivateUser`/`setSubscriptionActive`/`setGoodStandingOverride` (all owner-gated, all throwing `ValidationError` for bad input and blocking any target with `isOwner:true`) and a non-owner-gated `checkAccountStatus(userId)` that auto-reinstates an expired suspension then throws the new `AccountBlockedError` (`status`/`reason`) for anything non-active. Enforcement is wired at all three identity choke points: Telegram (`src/server.js`'s `handleFlowTextMessage`/`withTelegramCallback`/`withTelegramUser`), Discord (`createDiscordInteractionHandler`'s `checkAccountStatus` param, called right after every `identity.resolveOrCreate`), and the dashboard (`src/dashboard/api.js`'s `requireSession` middleware, returning `403` with `{error, code, status}`). New admin actions land in `adminCommandService.js` and therefore work identically from Telegram, Discord, and the dashboard admin panel.
- **16b — Governance-group retention scheduling:** Add an optional `scheduled_removal_at` to a user's group assignment. When it comes due, a background worker evaluates the user against their group's configured retention policy (`retention_period_days` to push the schedule out by, plus any combination of "must have an active subscription flag" and "must have used the bot within N days") and either renews the schedule by the configured period or removes the user from the group (never bans/suspends/deactivates the account itself — only the ceiling-tier assignment). A per-user "good standing" override, settable by an owner, unconditionally renews regardless of the group's configured criteria, for cases that don't fit an automatic rule. Every evaluation — renewed or removed — is written to a durable `group_retention_events` audit row. There is still no real payment/billing integration in this project; "subscription active" is an owner-settable flag an owner can wire up to an external billing process later, not a payment processor. Implemented: migration 028 also adds `retention_period_days`/`require_active_subscription`/`require_recent_activity_days` to `seat_groups` and `scheduled_removal_at`/`retention_renewed_at` to `user_governance`, plus the `group_retention_events` audit table. `src/governance/retentionWorker.js` follows the existing `socialWatchWorker.js` simple-poll pattern (hourly by default): `evaluateRetention` is a pure function combining good-standing override, subscription, and activity-recency (via a `MAX(activity.occurred_at)` correlated subquery, since no dedicated last-activity column exists) with AND semantics; `renewRetention`/`removeFromGroupForRetention` in `postgresGovernanceRepository.js` use optimistic-concurrency transactions (`WHERE ... AND scheduled_removal_at=$N`) so a due item can't be double-processed. Wired into `src/server.js` alongside the other background workers, with health reported through `readinessService`/`gracefulShutdown` the same way `schedulerWorker`/`socialWatchWorker` already are.
- New admin actions, following the existing `adminCommandService` kebab-case/positional-args convention so Telegram, Discord, and the dashboard all get them for free: `ban`, `unban`, `suspend`, `unsuspend`, `deactivate`, `reactivate`, `subscription`, `good-standing`, `group-retention`, `schedule-removal`.
- This milestone only ever changes `account_status` and group *assignment* (`user_governance.group_id`/`scheduled_removal_at`). It must never touch a wallet's encrypted key material, delete a row outright, or bypass the Milestone 7 transaction engine, the Milestone 6 validation schemas, or the existing owner-count invariant.

## Production definition of done

- All validation, lint, unit, integration, migration, and smoke checks pass in CI.
- Every user-owned read and write is tenant-scoped.
- Every transaction path uses simulation, spend limits, fee caps, nonce coordination, and durable audit records.
- Automated triggers cannot bypass configured verification or safety rails silently.
- Deployment, monitoring, backup, restore, rollback, and key-rotation procedures have been exercised successfully.
- A `passed` row exists in `live_acceptance_runs` (Milestone 14's Sepolia live acceptance run, `docs/LIVE_ACCEPTANCE_RUNBOOK.md`) with its `run_id`, chain, contract address, and transaction hash recorded in the release notes. Not yet confirmed complete as of Milestone 16 — the project owner must run `npm run acceptance:run` end to end and record the result here.

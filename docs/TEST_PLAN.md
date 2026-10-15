# GhostMint manual test plan

This plan covers the behavior an automated suite cannot prove: actually using the bot as a human
would across Telegram, Discord, and the dashboard. A release still requires the full guarded
`validate` command to pass against a marked disposable database, plus the human checks below.

Check items off as you go (`- [ ]` → `- [x]`). If something fails, note the exact
command/click sequence and the observed vs. expected result before moving on --
that reproduction detail is what makes a bug fixable.

## Automated PostgreSQL safety gate

Normal `.env` database credentials never enable integration or smoke tests. Database-backed
tests require a separately provisioned disposable database and these process variables:

- `NODE_ENV=test`
- `GHOSTMINT_TEST_DATABASE_URL`
- `GHOSTMINT_TEST_DATABASE_URL_UNPOOLED`
- `GHOSTMINT_TEST_DATABASE_ID=<a new version-4 UUID>`
- `GHOSTMINT_TEST_DATABASE_CONFIRM=RUN_DISPOSABLE_DB_TESTS`

Before setting them, mark that disposable database manually. Replace both placeholders only after
confirming the database is not used by any deployment:

```sql
COMMENT ON DATABASE "<disposable_database_name>"
IS 'ghostmint-disposable:<the same UUID>';
```

The test guard reads this marker through both URLs before any migration or write and rejects a
missing marker, different databases, partial configuration, production mode, or an obvious reuse
of the application database target. Never mark a production or shared database as disposable.
The full `validate` release gate intentionally fails when this proof is absent. Ordinary focused
unit tests remain database-free and should be preferred when the changed code does not depend on
PostgreSQL behavior.

## Before you start

- [ ] A Telegram account linked to your owner user (existing from earlier sessions).
- [ ] A Discord account you can use to test cross-platform linking, ideally *not*
      already linked to the same user (so the link flow itself gets exercised).
- [ ] At least one EVM testnet wallet with a small amount of test ETH (Sepolia is
      already configured from the M14 acceptance run -- reuse that funded wallet).
- [ ] The dashboard reachable at `http://localhost:3000/dashboard/` (or wherever
      you're running it) with a fresh browser session (no stale cookies).
- [ ] `SUPPORTED_CHAINS`/`SEPOLIA_RPC` still set from the M14 run if you want to keep
      testing against Sepolia; revert them per the runbook once you're fully done
      (`docs/LIVE_ACCEPTANCE_RUNBOOK.md`), not before.

Keep an eye on the running server's log output during all of this -- most of what
you're listening for (a caught error, a skipped sniper, a rejected task) shows up
there even when the UI just shows a generic failure.

---

## Priority: verify today's fixes first

These are the freshest, least-battle-tested changes from this session. If anything
in the plan below is going to surprise you, it's most likely here.

- [ ] **Banned account stops automations, not just new commands.** As owner: create
      a second (non-owner) test wallet + a scheduled task a few minutes out for a
      *different* test account, then ban that account (`/admin ban telegram
      <platformUserId> testing`). Confirm: (a) the banned account can no longer run
      *any* command and sees a clear "account is banned" message, not a generic
      failure; (b) when the scheduled task's time arrives, it fails in the
      dashboard's Tasks page with a reason mentioning the ban, and no transaction
      ever appears in Activity for it. Repeat informally for an *active* sniper if
      you have one to spare (deactivate the account, confirm the sniper stops
      copying on the next few blocks rather than continuing to fire).
- [ ] **Discord outage doesn't take down the whole bot.** Temporarily set
      `DISCORD_BOT_TOKEN` to garbage and restart. Confirm `/health` still reports
      `ok`/`degraded` (not connection-refused), Telegram still responds, and the
      dashboard still loads. Restore the real token and restart again afterward.
- [ ] **RPC failover actually engages.** If you have a spare free-tier RPC key,
      set `ETH_RPC_URLS=https://deliberately-bad-url,<your real ethereum RPC>` and
      restart. Confirm the sniper watcher still starts on Ethereum (check the
      startup log for "Sniper watcher started on Ethereum") instead of silently
      failing because the first URL was bad.
- [ ] **Admin confirm-symmetry.** In the dashboard's admin panel, try Unban,
      Unsuspend, and Reactivate on a test account *without* checking/typing the
      confirmation -- each should now be refused the same way Ban/Suspend/Deactivate
      already are, not applied silently.
- [ ] **Group names reject spaces with a clear message.** In the dashboard's Groups
      admin section, try creating a group named `VIP Members`. Expect an immediate,
      specific error ("must not contain spaces"), not a confusing ceiling-related
      one, and not a group silently created with the wrong values. A hyphenated
      name (`VIP-Members`) should work normally.

---

## M3-M4: Wallets

- [ ] Create a wallet through Telegram/Discord. Confirm the response never includes the private
      key or recovery phrase, only the public address.
- [ ] Create a wallet through the dashboard. Confirm its one-time recovery phrase is initially
      hidden, Copy works without revealing it, Reveal requires the warning, closing warns before
      discarding it, and neither a reload nor `GET /api/wallets` can retrieve it again. Confirm the
      creation response never includes the raw private key.
- [ ] Import a wallet by private key. Confirm same -- key never echoed back.
- [ ] Import a wallet by seed phrase. Confirm the derived address matches what an
      independent wallet tool (e.g. MetaMask, imported temporarily) derives from
      the same phrase, then discard that phrase/wallet.
- [ ] Export every wallet in an account consecutively with the correct security password; confirm
      there is no successful-export count ceiling. Then enter the wrong password repeatedly,
      confirm only those guesses become `429`, and confirm the correct password still works.
- [ ] Try importing a duplicate label -- expect a clear "label already used" error,
      case-insensitively (`MyWallet` vs `mywallet`).
- [ ] Check balance (`/wallets` or dashboard) for a real funded wallet -- confirm
      it matches what a block explorer shows.
- [ ] Remove a wallet. Confirm it disappears from `/wallets` and the dashboard
      immediately (no refresh needed on the dashboard, thanks to the WebSocket).

## M5-M6: Identity and linking

- [ ] Generate a link code on Telegram (`/link`), consume it on Discord
      (`/link code:<code>`). Confirm both platforms now resolve to the same
      account (same wallets/tasks visible from either).
- [ ] Try consuming an already-used code again -- expect a clear "invalid or
      expired" error, not a crash.
- [ ] Let a code sit past 5 minutes, then try consuming it -- same expected error.
- [ ] Log into the dashboard using a fresh Telegram-generated code. Confirm the
      session works and matches the same account.
- [ ] Confirm Discord *cannot* generate a link code (no such option in its
      Settings menu or `/link` without `code:`) -- only Telegram can.

## M7-M7a: Transaction safety and governance

- [ ] As owner, set a low ceiling on a test (non-owner) account via the admin
      panel, then have that account try to mint above it -- expect a clear
      `VALUE_CEILING_EXCEEDED`-style rejection before anything is broadcast.
- [ ] Confirm the owner account itself is exempt from ceilings (same mint amount
      that was rejected above should succeed for the owner).
- [ ] Toggle a mode preset (Ultra Fast / Fast / Semi-Safe / Safe) and confirm the
      dashboard's target-policy view reflects the new confirmation-count and
      simulation behavior for a target using that preset.
- [ ] Force simulation on for a test account, then attempt a mint that would fail
      simulation (e.g. a bad contract address) -- confirm it's blocked pre-broadcast
      with a clear reason, not a wasted real transaction.

## M8: Minting

- [ ] Manual mint via a supported shape (`mint()`, or another registered signature)
      against a real testnet contract. Confirm the preview shown before confirming
      matches what actually gets submitted.
- [ ] Batch mint across 2+ wallets in one command/dashboard action -- confirm each
      wallet gets its own transaction and its own activity entry.
- [ ] Save a mint preset, then mint from it later -- confirm it reproduces the
      same call correctly.
- [ ] Try an unsupported/custom function name or a raw ABI -- confirm it's
      rejected ("not one of the supported mint signatures"), not silently
      accepted.
- [ ] If you have an allowlist-gated test contract available, exercise the
      automatic proof-fetch path and the manual-proof-upload fallback.

## M9: Scheduler

- [ ] Schedule a mint a few minutes out. Confirm it fires at the scheduled time
      (check Activity / the tx hash on a block explorer).
- [ ] Pause a scheduled task, confirm it does *not* fire while paused, then resume
      it and confirm it does fire on the next due check.
- [ ] Cancel a scheduled task -- confirm it never fires and shows as cancelled.
- [ ] Try scheduling something in the past, and something absurdly far in the
      future (past the multi-year cap) -- both should be rejected clearly at
      creation time.
- [ ] After a task fails (e.g. point it at a bad contract), use Retry -- confirm
      it's attempted again rather than staying permanently failed.
- [ ] **Deferred until the post-UI archive work:** verify expired and cancelled
      schedules remain in the main Schedule list for the chosen retention period
      (proposed: 30 days), then appear exactly once in the eventual History
      destination in correct chronological order without losing attempt records.
- [ ] **Deferred until the post-UI archive work:** verify an expired schedule can
      be archived, and a cancelled schedule offers Retry and Archive. A retry
      whose original time is now in the past must require a valid future time;
      it must never fire immediately merely because the old time elapsed.
- [ ] **Deferred preview parity:** on Mint now, verify unresolved contract/method/
      chain/quantity/price/gas fields render as unknown rather than numeric zero,
      while total debits may remain zero. Repeat the decoded receipt-preview
      check for Schedule and Batch once those previews are implemented.

## M10-M10c: Snipers, social watch, triggers

- [ ] Create a sniper targeting a wallet address you can trigger yourself (e.g.
      your own second test wallet performing a mint-shaped call) with blockchain
      trigger set to Auto. Confirm the sniper copies the call once your target
      transaction confirms.
- [ ] Same, but with blockchain trigger set to Manual -- confirm a pending
      confirmation appears (dashboard bell / `/confirmtrigger`) instead of firing
      immediately, and that confirming it via `CONFIRM` executes while `REJECT`
      does not.
- [ ] Create a social watch rule (whichever adapter/method you have credentials
      for, or the scraper method against a public source) and confirm a matching
      post/message produces a detected trigger.
- [ ] Try enabling social-trigger bypass (skip human verification) -- confirm the
      highest-risk warning appears and it does *not* take effect until you reply
      exactly `CONFIRM`.
- [ ] Set "don't ask again" during a bypass confirmation, then trigger the same
      target again -- confirm it does *not* re-prompt. Remove and re-add the
      target (or use Reset) and confirm the don't-ask-again flag is cleared.
- [ ] Deactivate a sniper (not delete) -- confirm it stops evaluating new blocks
      for that target immediately, and the dashboard reflects `active: false`.
- [ ] **Deferred until the post-UI sniper lifecycle work:** safely create or
      simulate a failed sniper and verify its card offers Edit, Retry, Archive;
      verify a paused sniper offers Edit, Resume, Archive. Exercise every action
      and confirm Archive preserves history instead of hard-deleting the record.

## M11: Bot security

- [ ] Confirm Telegram commands are refused outside a private 1:1 chat (try from
      a group if you have a test group available).
- [ ] Trigger the rate limiter (repeat the same sensitive command rapidly) --
      confirm you get a clear rate-limit message, not a crash, and that it
      resolves itself after the window passes.
- [ ] Confirm one user's wallet/task labels are never visible to or removable by
      another non-owner user (try referencing another user's label by guessing
      it).

## M12: Observability

- [ ] Hit `/health` directly -- confirm it reports `database`, `rpc` (per chain),
      `scheduler`, `socialWatcher`, `retentionWorker`, and `sniperWatchers`
      sections, all `up` under normal conditions.
- [ ] Stop the database briefly (or point `DATABASE_URL` at something unreachable
      and restart) -- confirm `/health` reports `degraded` with `database: down`
      rather than the process crashing outright.
- [ ] Send SIGINT/SIGTERM (Ctrl+C in the terminal running it) to a running dev
      instance -- confirm the "Graceful shutdown started/complete" log lines
      appear and the process exits cleanly, not hanging.

## M13: Dashboard

- [ ] Full page walkthrough: Wallets, Mint, Tasks, Snipers, Watch Rules, Activity,
      P&L, Gas, Settings, Account, Admin (owner only). Confirm each loads without
      console errors and reflects real data.
- [ ] Search on Wallets, Tasks, Activity, P&L, Snipers, Watch Rules -- confirm
      results match substring matches across all your data, not just the current
      page.
- [ ] Right-click (or long-press on mobile) a row where quick-actions exist --
      confirm the context menu shows relevant actions and each one works.
- [ ] Switch themes (light/dark and at least one alternate) -- confirm no
      unreadable text/contrast issues in either.
- [ ] Resize to a mobile width -- confirm the hamburger nav appears and every page
      is usable (no horizontal scroll, no cut-off controls).
- [ ] Log out, confirm the session cookie is cleared and protected pages redirect
      to login. Log back in with a fresh link code.
- [ ] "Log out everywhere" from Account settings -- confirm a second open session
      (different browser/incognito) is also invalidated.
- [ ] From Account → Linked platforms, generate a code, then press Refresh. Confirm the expiry
      countdown restarts and the first unused code is rejected while the refreshed code works.
- [ ] Change default chain in Settings -- confirm it's actually used as the
      default on the next mint/wallet-creation flow.
- [ ] View Gas and Social API usage panels -- confirm the numbers look plausible
      against what you know you've actually used.

## M14: Live acceptance run

- [x] Already executed and passed this session -- run `1bf295ae-4603-4289-993a-9679337d8f32`,
      chain `sepolia`, tx `0x00255a5ca8461c67b6e83c3b36910626af8c83ebf33de45e851579d55a00d389`.
      Record this in your release notes per `ROADMAP.md`'s "Production definition
      of done" -- that's the last item in that checklist.

## M15: Bot UX (guided flows and menus)

- [ ] `/start` on Telegram -- confirm the main menu appears with working buttons
      for Wallets, Mint, Tasks, Snipers, Watch Rules, Activity, Gas, Settings.
- [ ] Start a guided wallet-create flow, then send an unrelated command mid-flow
      -- confirm you're asked to confirm abandoning it, and that choosing "keep
      going" resumes exactly where you left off.
- [ ] Same guided flow on Discord (buttons/select menus/modals instead of Telegram
      text prompts) -- confirm parity.
- [ ] Confirm Telegram's `/` autocomplete shows the registered command list.

## M16: Account lifecycle and retention

(Covered in "verify today's fixes first" above for the automation-enforcement
angle. This section is the general M16 surface.)

- [ ] Ban, unban, suspend (both a fixed number of days and indefinite), unsuspend,
      deactivate, and reactivate a test account from each surface you use
      (dashboard at minimum) -- confirm each requires a reason and the correct
      ones require explicit confirmation.
- [ ] Confirm a suspended account with a time-boxed suspension automatically
      becomes active again once `suspended_until` passes (no owner action
      needed) -- `checkAccountStatus` self-heals this on the account's next
      command.
- [ ] Confirm an owner account cannot be banned/suspended/deactivated directly --
      expect a clear "remove owner status first" error.
- [ ] Set a group's retention policy (e.g. require activity within 30 days), then
      check `group_retention_events` (or the admin UI if it's surfaced there)
      after the retention worker's next tick to confirm it evaluated correctly.
- [x] Review a split account from Admin -> Owners -- confirm the read-only plan
      names the exact duplicate and retained internal IDs, reports every owned
      domain and blocker, and does not change either platform mapping, row count,
      session, audit record, or live dashboard state.
- [x] As a non-root owner, review a collision-free split account and confirm the
      plan is visible but the execute control is absent. The generic
      `/api/admin/merge-account` action must reject the request and move nothing.
- [x] As a root owner, review a disposable split account containing non-conflicting
      wallet/activity history. Open the dedicated merge overlay and confirm focus
      enters it, Escape and Cancel restore focus, every underlying field/action is
      locked while it is open or submitting, and execution stays disabled until
      the exact `MERGE <source UUID> INTO <target UUID>` phrase is entered.
  - [x] Rendered acceptance passed against marked disposable PostgreSQL rows in both
        themes at 1440/1024/768/375, including focus restoration, inert background,
        scroll lock, confirmation gating, targeted session teardown, and refresh.
- [x] Change one reviewed source row before executing. Expect a safe stale-plan
      response and a refreshed review; neither account, identity, session, owned
      row, nor merge-event count may change.
- [x] Execute the unchanged collision-free plan in the marked disposable/staging
      environment. Confirm all reviewed rows and both identities belong to the
      retained account, the duplicate user is gone, both accounts' active browser
      sessions end with the merge reason/evidence ID, unrelated users stay logged
      in, and Telegram/Discord now read the same retained data.
- [x] Verify one immutable `account_merge_events` row contains the actor/source/
      target snapshots, exact plan digest, moved/revoked counts, and committed
      outcome. Repeat the identical request after an uncertain response: it must
      return the same event ID with replay status and must not repeat runtime
      teardown or insert a second event.
- [ ] Repeat with every blocked class available (active schedule/sniper/social
      rule, non-final transaction, wallet/label/preset/policy collision, source
      preference/governance evidence). Each must remain review-only and leave both
      accounts untouched. Collision resolution is not part of Phase 1E.

## M17: Address-backed wallet history

- [x] Focused unit/API checks: provider pages reject numeric blockchain quantities, implicit
      completeness, duplicate hashes/locators, mismatched chain/provider data, and cleanup ranges
      outside provider-proven history. Saved cursors resume in the same generation, failures cannot
      overwrite a newer generation, an unqualified request covers every supported EVM chain, and
      an unconfigured chain returns an explicit `unsupported` state. History routes are
      authenticated, tenant-scoped, paginated, no-store, and CSRF-protected for sync writes.
- [x] Inactive GoldRush adapter contract checks cover exact chain slugs, bearer-key trimming,
      strict cursors and pagination, nullable undocumented calldata/nonce, wallet-involved ERC
      movement filtering, malformed/custom-log isolation, sanitized auth/rate-limit errors, and
      retry timing. The adapter deliberately makes no completeness or reorg-cleanup claim from page
      exhaustion or `chain_tip_height`, does not request undocumented paginated trace options, and
      remains disabled by default until approved credentials and per-chain live contracts are verified.
- [x] Provider-independent worker checks cover one page per lease, overlapping-tick coalescing,
      safe error logging, start/stop/health, explicit retry deadlines, permanent configuration
      failures awaiting manual retry, and stale-owner refusal before a provider call. Migration 073
      and repository checks require `FOR UPDATE SKIP LOCKED`, recoverable lease expiry, and exact
      ownership guards. The worker stays behind its default-off runtime gate, so these checks do not
      enable syncing.
- [x] On a separately marked disposable PostgreSQL database, apply migration 073 and run
      `tests/walletHistory.integration.test.js`. Verify overlapping pages upsert rather than
      duplicate, exact intent/broadcast hashes classify as GhostMint, only complete post-boundary
      unmatched rows classify as External, older/incomplete rows remain Source unknown, and user
      deletion cascades the imported ledger and broadcast-hash evidence. Also verify final-page
      reorg cleanup commits atomically with its generation, every row from a provider-proven
      complete multi-page generation is finalized as provider-complete, a stale generation cannot
      overwrite or orphan newer rows, two workers cannot own the same page, an expired lease is
      recoverable, a stale owner cannot write or release the replacement claim, and an offset past
      the last row still returns the correct total.
  - Passed on 2026-10-13 using only the marked disposable database environment. The prior refusal
    was traced to the ordinary local `.env` also pointing at that same test target; no second test
    database was needed. The fixture now uses per-run transaction hashes, removes wallets before
    users to respect the production foreign key, and left zero synthetic wallets, intents,
    subjects, or transactions after the run. The guard remains mandatory: never mark a shared/live
    application database disposable.
- [ ] Configure an approved history adapter for every currently supported EVM chain and prove
      restartable cursor progression, rate-limit retry, overlap, receipt finality, and reorg
      correction. A provider must explicitly declare coverage; page exhaustion alone is not proof
      of complete history or provenance. Wire the existing bounded lease worker only after approved
      credentials and per-chain live response contracts are available. The production worker flag
      remains off, so `runSyncPage` is not called there.
  - The GoldRush key, adapter, and worker now have separate default-off runtime gates. A key by
    itself makes no request. Enabling the adapter requires an explicit supported-chain subset;
    enabling the lease worker additionally requires the adapter and is refused in dashboard-only
    mode. Readiness and graceful shutdown cover the worker, but the production flags remain off
    until the remaining canary acceptance is complete.
- [ ] Decide and document wallet-removal retention separately from full account deletion. Test
      remove/reimport in the same account, import into another account, and delete/recreate account;
      old first-party origin must become Source unknown wherever the required evidence was erased.
- [x] Local read surfaces use the same normalized ledger: Wallet Details separates on-chain
      Transactions from operational App activity, while History adds a server-aggregated
      Transactions tab without changing the default Activity tab. The aggregate endpoint is
      authenticated, tenant-scoped, `no-store`, snapshot-paginated, wallet-enriched, deterministic
      for duplicate imported addresses, and exposes truthful per-wallet/per-network coverage. UI
      filters cover wallet, network, source, outcome, activity type, address, and transaction hash;
      stale rows are withheld while a new filter/page path loads; there is no misleading
      account-wide refresh control. Focused display/repository/service/command/API tests, targeted
      lint, and the production Dashboard build pass.
- [x] Re-run the new account-ledger PostgreSQL assertion against both saved endpoints for the
      explicitly marked disposable database. On 2026-10-14 the first run exposed an ambiguous SQL
      join in the aggregate ledger; the query now joins the subject and sync rows explicitly. The
      guard verifies the pooled and unpooled markers sequentially to avoid exhausting the trial
      proxy with simultaneous connections, while still requiring both to identify the same marked
      database. The focused guard/repository/integration run passed 12/12 and never fell back to the
      application/production database.
- [ ] Render Wallet Activity and global History from the same server ledger at
      390/768/1024/1440 in both themes, covering loading/progress, partial, unsupported, error,
      empty, and populated states without blocking unrelated wallet actions. Then verify the same
      read contract after deployment while the adapter and worker remain off; provider-enabled
      populated acceptance belongs to the later guarded canary.

---

## After this pass

- Anything that failed: capture the exact repro steps, expected vs. actual, and
  whatever the server log showed at that moment -- that's enough to hand back
  for a fix.
- Once you're satisfied, revert the temporary `SUPPORTED_CHAINS`/`SEPOLIA_RPC`/
  `LIVE_ACCEPTANCE_*` values in `.env` per the acceptance runbook, since they were
  only meant to be set for that one run and for this testing pass.

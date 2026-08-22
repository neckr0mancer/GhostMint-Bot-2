# GhostMint Dashboard — Data Contract

**Version:** 1 (2026-08-17). Companion to `REDESIGN_BRIEF.md` and `REDESIGN_PROMPT.md`.
**Prototype:** `docs/ghostmint-redesign-v3.html`

Every visible element in the prototype, mapped to the endpoint and field that
feeds it. Written because the brief specifies what things *look like* and never
said where a single number comes from — which is the one gap that would have
stalled the build at Phase 3.

Everything below was read directly out of `src/dashboard/api.js`,
`src/commands/botCommandService.js` and the repositories they call. Nothing is
inferred from the prototype.

---

## 1. How to read this

Every binding carries one of four statuses:

| Status | Meaning | What the builder does |
|---|---|---|
| **SERVER** | The field exists on a routed endpoint, exactly as named | Bind directly |
| **DERIVED** | Computable client-side from data already fetched | Compute it; the formula is given |
| **MISSING** | No data source exists anywhere | **Do not invent an endpoint.** See §5 for the decision on each |
| **GATED** | Exists, but the caller may not be authorised | Render the permission state, don't assume access |

**The rule for Claude Code:** if an element is MISSING and §5 has not been
resolved, build the element in its empty/unavailable state and report it. Never
add a route to make a tile work — that is a `src/**` change and out of scope.

---

## 2. Endpoint inventory

Every route the dashboard can call, and what it returns. Routes are as mounted in
`mountDashboardRoutes` (`src/dashboard/api.js:250–308`).

### Session and profile

| Route | Returns |
|---|---|
| `POST /api/auth/login` | `204`, sets session + CSRF cookies. `401` on bad code, `429` rate limited |
| `POST /api/auth/login-password` | `204`. `401` generic "Invalid username or password" for every failure mode |
| `POST /api/auth/logout` / `logout-all` | `204` |
| `GET /api/profile` | `{userId, isOwner, isRootOwner, linkedAccounts[], supportedChains[], theme, displayName, defaultChain, securityPasswordSet, username, currentMode, advancedModesAllowed}` |
| `PUT /api/profile/theme` \| `display-name` \| `default-chain` \| `mode` | the single updated field |
| `PUT /api/auth/security-password` | `{securityPasswordSet:true}`. `401` if current password wrong, `429` rate limited |
| `PUT /api/auth/username` | `{username}`. `409` if taken, `400` if no security password set |
| `POST /api/auth/link-code` | `{code, expiresAt}` |

`currentMode` is the full preset object or `null`:
`{key, displayName, simulationMode, confirmationCount, humanVerification, gasPriceMultiplier, isDefault}`

### Wallets

| Route | Returns |
|---|---|
| `GET /api/wallets` | `[{label, address, chain, balances[], minted}]` — `publicWallet()` strips the key envelope |
| `POST /api/wallets/create` | `201` `{label, address, chain, balances:[], minted:0, recoveryPhrase}` — the phrase exists only in this `Cache-Control: no-store` creation response, is never persisted, and cannot be fetched again |
| `POST /api/wallets/import` | `201` `{label, address, chain, balances:[], minted:0}` — never echoes the supplied private key or phrase |
| `POST /api/wallets/batch-import` | `201` `{results:[{index, status:'success'\|'failed', label?, address?, error?}]}` — owner only |
| `DELETE /api/wallets/:label` | `204`. Requires `{confirmation:"CONFIRM"}` |
| `POST /api/wallets/:label/export` | `{keystore}` — encrypted V3 backup. Requires `confirmation` + `securityPassword`; correct-password exports have no wallet-count ceiling, while repeated incorrect passwords are throttled |
| `POST /api/wallets/:label/export/raw` | `{privateKey}` — explicit raw-key escape hatch. Requires authenticated user scope, CSRF, `confirmation` + verified `securityPassword`; `Cache-Control: no-store`. Correct-password exports have no wallet-count ceiling, while repeated incorrect passwords are throttled. The dashboard keeps the value only in memory for 60 seconds, does not render it by default, and requires a separate warning confirmation before Reveal |

**`balances` is one entry per *supported chain*, not per wallet chain:**
`[{chain, balance:"1.234"|null, symbol}]`. `balance: null` means that chain's RPC
failed — distinct from `"0.0"`, which means genuinely zero. Source:
`botCommandService.walletBalance()` lines 230–244.

### Minting

| Route | Returns |
|---|---|
| `GET /api/mints/detect?contractAddress=&quantity=` | see below |
| `POST /api/mints/preview` | `{previewToken, expiresInSeconds:300, items:[{wallet, preview, simulation}]}` |
| `POST /api/mints/confirm` | `202` `{results:[{label, status:'success'\|'failed', result?, error?}]}` |
| `GET /api/mint-presets` | `[{name, methodSignature, contractAddress, …}]` |

`detect` returns:
`{chain, isSeaDrop, methodSignature, seaDropAddress, arguments[], valueWei|null, priceKnown, maxSupply|null, maxPerWallet|null, startTime|null, endTime|null, collection|null, soldOut, displayPrice|null}`

- `valueWei` is `null`, never `0`, when the price can't be read
- `startTime`/`endTime` are unix **seconds**, SeaDrop only
- `displayPrice` is `{eth, usd|null, source:'mint'|'floor'}` — **display only, never
  the amount a transaction sends**
- `collection` is OpenSea metadata or `null` (currently always `null` — no API key)

`simulation` is `{simulationEnabled, simulationPerformed, simulationPassed, gasLimit, estimatedCostWei, feePerGasWei}`.

### Tasks, activity, P&L

| Route | Returns |
|---|---|
| `GET /api/tasks?page=&pageSize=&search=` | `{page, pageSize, offset, total, totalPages, items[]}` |
| `POST /api/tasks` | `201` task object |
| `POST /api/tasks/:id/control` | `{…task}`. `action` of `cancel` requires confirmation |
| `GET /api/activity?page=&pageSize=&search=` | `{page, pageSize, offset, total, totalPages, items[]}` |
| `GET /api/pnl` | **plain array, no pagination, no filter, no params** |
| `POST /api/pnl` / `PUT /api/pnl/:id` / `DELETE /api/pnl/:id` | record / record / `204` |

Task item: `{id, userId, name, walletLabel, contract, fn, qty, price, gas, mintTime, status, createdAt, nextAttemptAt, attemptCount, maxAttempts, transactionIntentId, idempotencyKey}`.
`mintTime` is epoch **milliseconds**. `status` ∈ `scheduled|claimed|retry|paused|cancelled|succeeded|failed`.

Activity item: `{id, userId, status, title, walletLabel, txHash, explorer, time, actualNetworkCostWei, triggerSource, verificationState}`.
`status` ∈ `success|fail`. `time` is epoch ms.

P&L record: `{id, userId, nm, cost, sale, gas, net, t}` — all ETH as **Numbers**, `t` epoch ms.

### Automation

| Route | Returns |
|---|---|
| `GET /api/snipers` | `{items:[…], events:[…]}` |
| `POST/PUT/DELETE /api/snipers[/:id]` | sniper / sniper / `204` |
| `GET /api/watch-rules` | `{items:[…], events:[…]}` |
| `POST/PUT/DELETE /api/watch-rules[/:id]`, `POST …/:id/disable` | rule / rule / `204` / rule |
| `GET /api/targets/:id?type=sniper\|social_rule` | `{targetType, targetId, label, chain, policy, governance}` |
| `PUT /api/targets/:id` | saved policy |
| `POST /api/targets/:id/bypass` | `{challengeId, warning, requiresConfirmation:true}` **or** the saved policy if already acknowledged |
| `POST /api/targets/bypass/confirm` | saved policy. Requires `confirmation:"CONFIRM"` exactly |
| `GET /api/confirmations` | pending trigger-confirmation requests |
| `POST /api/confirmations/:id` | `{action, result}` |

Sniper: `{id, userId, label, targetAddress, chain, walletLabel, valueMode, fixedValueETH, maxValueETH, gasBoostPercent, maxGasGwei, dailySpendingCapETH, cooldownMs, maxAttempts, contractAllowlist[], contractDenylist[], sourceConfirmations, active, hits, fails, lastFiredAt, createdAt}`

Policy: `{userId, targetType, targetId, blockchainTrigger:'auto'|'manual', socialTrigger, humanVerification:'on'|'bypassed', dontAskAgain, walletLabel, mintPresetName, modePresetKey}`

### Settings and admin

| Route | Returns | Note |
|---|---|---|
| `GET /api/gas/:chain` | `{chain, chainId, safeGasPriceGwei, gasPriceGwei, maxFeePerGasGwei, source}` | `503` `MISSING_API_KEY` with no `ETHERSCAN_API_KEY` |
| `GET /api/social-usage?period=` | usage summary | **owner only** — see §6 |
| `GET /api/mode-presets` | `[{key, displayName, simulationMode, confirmationCount, humanVerification, gasPriceMultiplier, isDefault}]` | |
| `GET /api/admin` | `{groups[], users[], presets[], metrics{}}` | owner only |
| `GET /api/admin/effective?platform=&platformUserId=&chain=` | resolved governance | owner only |
| `GET /api/admin/security-audit` | recent `bot_security_audit` rows | owner only |
| `GET /api/admin/users/:userId/wallets\|activity\|tasks\|pnl` | that user's data | owner only |
| `POST /api/admin/:action` | `{message}` | owner only |

`metrics` is exactly:
`{totalUsers, activeUsers, activeAnyPlatform24h, linkedAccounts, groups, owners, rootOwners}`
(`postgresGovernanceRepository.getAdminOverviewMetrics`, lines 262–281). **There is
no volume figure and no mint count.**

### Exists in `botCommandService` but is NOT routed to the dashboard

These are reachable from Telegram/Discord only. Do not bind to them:
`stats`, `tasks` (unpaged), `activity` (unpaged), `triggerAudit`,
`pendingTransactions`, `transactionsPage`, `targetPolicy`, `resetTargetPolicy`,
`applyTargetPreset` *(routed as `/api/targets/:id/preset`)*, `sniperEvents`
*(folded into `/api/snipers`)*, `watchEvents` *(folded into `/api/watch-rules`)*.

### Live updates

`useLoad(url, deps, eventName)` refetches on a WebSocket message. Emitted event
types: `wallets.changed`, `tasks.changed`, `activity.changed`, `pnl.changed`,
`snipers.changed`, `watchrules.changed`, `identity.changed`, `admin.changed`,
`confirmation.pending`, `confirmation.resolved`. Nothing else is emitted.

---

## 3. Page bindings — Home

| Element in prototype | Source | Status |
|---|---|---|
| Greeting name | `GET /api/profile` → `displayName` | SERVER |
| **Portfolio · `4.182 ETH`** | sum over `/api/wallets` → `balances[]` | **DERIVED — with a caveat, see §5.3** |
| Portfolio `▲ 0.34 · 7d` delta | — | **MISSING (§5.4)** |
| Portfolio sparkline | — | **MISSING (§5.4)** |
| **Net P&L · 30d** | `GET /api/pnl` → filter `t >= now-30d`, sum `net` | **DERIVED (§5.5)** |
| P&L `23 mints` | `/api/pnl` → count in window | DERIVED |
| P&L sparkline | `/api/pnl` → daily buckets of `net` | DERIVED |
| **Daily budget `0.084 / 0.25`** | — | **MISSING (§5.1)** |
| Daily budget meter | — | MISSING (§5.1) |
| **Success rate `91%`** | `/api/activity` → `items.filter(status==='success').length / items.length` | **DERIVED — page-scoped only (§5.6)** |
| Success rate `21 of 23 confirmed` | same | DERIVED, same caveat |
| Celebrate panel content | `/api/activity` → newest `status==='success'` item | DERIVED |
| **Celebrate `🔥 6 in a row` streak** | — | **MISSING (§5.7)** |
| P&L chart bars | `/api/pnl` → daily buckets, `net` per day | DERIVED |
| P&L `30d / 90d / All` control | client-side filter of the same array | DERIVED |
| Recent activity rows | `/api/activity?page=1&pageSize=8` → `items[]` | SERVER |
| Activity row title / wallet / time | `title`, `walletLabel`, `time` | SERVER |
| Activity row chain dot | — | **MISSING — `activity` has no chain column (§5.8)** |
| Activity row value `−0.080` | `actualNetworkCostWei` | SERVER — but this is **gas only**, not mint value (§5.8) |
| Countdown ring `42:11` | `/api/tasks` → earliest future `mintTime` | DERIVED |
| Countdown target + wallet + price | task `name`, `walletLabel`, `price` | SERVER |
| Watch-rule failure alert | `/api/watch-rules` → `items.filter(consecutiveFailures > 0)` | SERVER |
| Wallets summary rows | `/api/wallets` → `label`, `address` | SERVER |
| Wallet row balance | `balances[]` — see §5.3 | DERIVED |

## 4. Page bindings — everything else

### Mint

| Element | Source | Status |
|---|---|---|
| Contract address input | user input → `GET /api/mints/detect` | SERVER |
| "Detected Azuki Elementals · SeaDrop · open · 0.08 ETH · max 3/wallet" | `detect` → `collection.name`, `isSeaDrop`, `soldOut`, `displayPrice.eth`, `maxPerWallet` | SERVER — `collection` is `null` without an OpenSea key |
| Wallet select | `/api/wallets` → `label` + `balances` | SERVER |
| Quantity max | `detect` → `maxPerWallet` (`null` → fall back to the schema cap of 100) | SERVER |
| Price per mint | `detect` → `valueWei` / quantity, or user override | SERVER |
| **Transaction preview table** | `POST /api/mints/preview` → `items[0].preview` + `.simulation` | SERVER |
| Preview → Contract / Method | `preview.contractAddress`, `preview.signature` | SERVER |
| Preview → Chain · confirmations | `detect.chain` + `/api/mode-presets` → `confirmationCount` | DERIVED |
| Preview → Mint price | `preview` value | SERVER |
| Preview → Est. gas | `simulation.estimatedCostWei − valueWei` | DERIVED |
| Preview → Simulation "Passed" | `simulation.simulationPassed` / `simulationPerformed` | SERVER |
| Preview → Total debit | `simulation.estimatedCostWei` | SERVER |
| **"Daily budget after this mint"** | — | **MISSING (§5.1)** |
| Confirm button | `POST /api/mints/confirm` with `previewToken` + `confirmation:"CONFIRM"` | SERVER |
| Schedule sub-tab | `POST /api/tasks`, list from `GET /api/tasks` | SERVER |
| Batch sub-tab | `preview` with `walletLabels[]`, then `confirm` → `results[]` | SERVER |
| Presets sub-tab | `GET /api/mint-presets` | SERVER |

**The preview token is load-bearing and the prototype did not show it.** `preview`
issues a token valid for 300 seconds; `confirm` consumes it once. An expired or
reused token returns a `400` on `previewToken`. The UI must show the countdown
and re-preview on expiry.

### Automation

| Element | Source | Status |
|---|---|---|
| Trigger cards | `/api/snipers` → `items[]`, `/api/watch-rules` → `items[]` | SERVER |
| Sniper status pill | `active`, plus `events[]` for recent failures | SERVER |
| Watch rule "4 consecutive failures" | `/api/watch-rules` → `items[].consecutiveFailures` | SERVER |
| "0.140 / 0.200" daily cap used | `dailySpendingCapETH` is the ceiling — **the used figure is MISSING (§5.1)** | PARTIAL |
| Inline policy ledger | `GET /api/targets/:id?type=` → `policy` | SERVER |
| Policy edit | `PUT /api/targets/:id` | SERVER |
| Bypass challenge | `POST /api/targets/:id/bypass` → `{challengeId, warning}` then `POST /api/targets/bypass/confirm` with `confirmation:"CONFIRM"` | SERVER |
| Post-confirmation disclosure | static copy | n/a |

### Wallets

| Element | Source | Status |
|---|---|---|
| Wallet cards | `/api/wallets` | SERVER |
| Balance | `balances[]` — §5.3 | DERIVED |
| Address | `address` | SERVER |
| Performance ledger (Minted / Cost / Gas / Net) | `minted` is SERVER; Cost / Gas / Net come from `/api/pnl` **and cannot be attributed to a wallet** — §5.9 | **PARTIAL** |
| Send sub-tab | no dashboard route — §5.10 | **MISSING** |
| Export sub-tab | `POST /api/wallets/:label/export` | SERVER |

### History

| Sub-tab | Source | Status |
|---|---|---|
| Activity | `GET /api/activity` | SERVER |
| **Audit evidence** | `triggerAudit` exists in `botCommandService` but **is not routed** | **MISSING (§5.11)** |
| **Security log** | only `GET /api/admin/security-audit`, **owner only** | **GATED (§6.1)** |

### Admin

| Element | Source | Status |
|---|---|---|
| Users tile `38` | `/api/admin` → `metrics.totalUsers` | SERVER |
| Groups tile `3` | `metrics.groups` | SERVER |
| **Volume · 24h `12.4 ETH · 61 mints`** | — | **MISSING (§5.2)** |
| Owners tile `2 · 1 root` | `metrics.owners`, `metrics.rootOwners` | SERVER |
| Users list | `/api/admin` → `users[]` | SERVER |
| Group ceilings ledger | `/api/admin` → `groups[]` | SERVER |
| Effective lookup | `/api/admin/effective` | SERVER |
| Mode presets | `/api/mode-presets` | SERVER |
| Audit log | `/api/admin/security-audit` | SERVER |
| **System health** | `/api/admin/health` — **unreachable, always 404** | **BROKEN (brief §9.2-O5)** |
| Batch import | `POST /api/wallets/batch-import` | SERVER |

### Account and Settings

| Element | Source | Status |
|---|---|---|
| Display name / username / default chain | `/api/profile` + the `PUT` routes | SERVER |
| Linked platforms | `/api/profile` → `linkedAccounts[]` | SERVER |
| Security ledger | `/api/profile` → `securityPasswordSet`, `username` | SERVER |
| Active sessions count / expiry / last key export | — | **MISSING (§5.12)** |
| Account status | `/api/profile` does **not** return it; a blocked user gets `403` at `requireSession` instead | DERIVED (always "Active" if the page loaded) |
| Theme picker | `PUT /api/profile/theme` | SERVER |
| **Transaction mode cards** | `/api/mode-presets` + `profile.currentMode` + `profile.advancedModesAllowed` | SERVER — fully supported, no change needed |
| Transaction mode effect ledger | `/api/mode-presets` → the selected preset's fields | SERVER |
| Gas panel | `GET /api/gas/:chain` | SERVER — `503` without an API key |
| Notification routing table | static copy | n/a |
| **API usage** | `GET /api/social-usage` — **owner only** | **GATED (§6.2)** |

---

## 5. The gaps, and what to do about each

Twelve items have no data source. Each has a recommendation. **None of them
should be closed by inventing an endpoint during the redesign.**

### 5.1 Rolling daily spend — the biggest one

Feeds: Home's "Daily budget" tile and meter, Mint's "Daily budget after this
mint", Automation's "Daily cap used 0.140 / 0.200".

`intentRepository.rollingSpendWei(userId, walletId, since)` exists but is called
only inside `transactionEngine`. No route exposes it. The *ceiling* is reachable
for owners via `/api/admin/effective`; a regular user has no route for either the
ceiling or the amount used.

> **Recommendation: cut the "used" figure from the redesign and keep the ceiling.**
> Render "Daily budget · 0.25 ETH ceiling" with no meter. Log a WORKLIST item for
> a `GET /api/profile/limits` returning `{maxTransactionValueWei, dailySpendingBudgetWei, spentTodayWei, gasCeilingGwei}`, and restore the meter once it exists.
>
> Note before building that endpoint: **`rollingSpendWei` currently under-counts**
> — it sums `COALESCE(actual_network_cost_wei, estimated_cost_wei)`, and the
> actual column holds gas only, so a confirmed transaction's mint value drops out
> of the total. Surfacing that number in the UI before fixing it would display a
> figure that is wrong in the user's favour. Tracked as `PROJECT_REVIEW` §1.1.

### 5.2 Admin 24-hour volume and mint count

`getAdminOverviewMetrics` returns counts of users, owners, groups and linked
accounts only.

> **Recommendation: replace the tile.** Use `metrics.activeAnyPlatform24h`
> ("Active · 24h") which does exist and is arguably more useful on an admin
> overview than an ETH figure. Log the volume tile as a WORKLIST item.

### 5.3 Portfolio total — a currency-mixing problem, not a missing one

`/api/wallets` gives `balances[]` with **one entry per supported chain** — all
six, including Polygon, whose symbol is `MATIC`. Summing them produces a number
that adds ETH to MATIC.

> **Recommendation: total per symbol, display the ETH total as the headline.**
> `Σ balances.filter(b => b.symbol === 'ETH').balance`, with a secondary line for
> any non-ETH holdings. Skip `balance === null` entries (RPC failure) rather than
> treating them as zero, and say so: "2 chains unavailable".

**Verified against production 2026-08-17** (dev proxy → `ghostmint-bot-2-production`,
signed in as a root owner). The six-chain claim above is `src/config`'s *maximum*,
not what this deployment runs. Live, `GET /api/profile` returns
`supportedChains: ["ethereum","sepolia","robinhood"]` — **three chains, and all
three carry `symbol: "ETH"`.** No Polygon, so **no MATIC, so no currency mixing
in production today.**

This does **not** change the recommendation. Keep the `symbol === 'ETH'` filter:
it is driven by config, a chain can be added by an env change without touching the
dashboard, and a filter that is currently a no-op is the correct defensive shape.
What it does change is the emphasis — **the `balance === null` case is the one that
actually bites here, not the mixing.** The live wallet returns
`ethereum=null, sepolia=null, robinhood="0.0"`: two of three chains are failing at
the RPC and the headline ETH total is derived from a single chain. Build and verify
the "N chains unavailable" line as a first-class state, not an edge case — on this
deployment it is the *normal* render.

### 5.4 Portfolio 7-day delta and sparkline

No historical balance data exists anywhere — no snapshot table, no time series.
Not derivable.

> **Recommendation: cut both.** Replace the sparkline with the per-symbol
> breakdown from §5.3, which is real. The brief's §3.4 rule ("no card may contain
> a single number and nothing else") is satisfied by the breakdown.

### 5.5 P&L window — derivable, but the numbers will be negative

`/api/pnl` returns everything with no filter, so a 30/90/All control is a
client-side filter on `t`. That part is fine.

The problem is what it shows. `autoRecordPnl` (`server.js:321`) writes every
confirmed mint with `sale: 0`, so `net = −(cost + gas)`. **Every auto-recorded
row is a loss.** The prototype's green `+0.617` and mostly-green chart cannot
occur unless the user manually edits `sale` on each record.

> **Recommendation: build it honestly and expect red.** The chart is correct as
> designed; the data is what's incomplete. Add a one-line note under the chart:
> "Sale proceeds are entered manually — a mint with no recorded sale shows as a
> loss." Log the OpenSea sales-detection work already described in
> `docs/WORKLIST.md` "Still open" #3 as the real fix.

### 5.6 Success rate is page-scoped, not global

`stats()` exists in `botCommandService` and is **not routed**. Deriving from
`/api/activity` only sees the fetched page.

> **Recommendation: label it accurately** — "Last 20 mints" rather than an
> unqualified "Success rate", fetching `pageSize=20` for the tile. Alternatively
> use `total` from the activity response as the denominator and count successes
> per page, but that's wrong maths. Label it.

### 5.7 The "🔥 6 in a row" streak

No streak is stored or computed anywhere.

> **Recommendation: derive a real one or cut it.** A consecutive-success count
> over `/api/activity?pageSize=50` is honest and cheap: count from newest until
> the first non-`success`. If the count is under 2, hide the chip entirely rather
> than showing "1 in a row".

### 5.8 Activity rows have no chain and no mint value

The `activity` table has no `chain` column and no value column. It has
`explorer` (the block-explorer base URL) and `actual_network_cost_wei`, which is
**gas only**. The prototype's `−0.080` next to "Azuki Elementals" reads as the
mint price; it is not.

> **Recommendation:** derive the chain dot from `explorer` (etherscan → Ethereum,
> basescan → Base, and so on — a small lookup), and label the figure as gas:
> `Gas 0.004140`. Do not display it as though it were the mint cost.

### 5.9 Per-wallet performance cannot be computed

`pnl_records` has no `wallet_id` or `wallet_label` column. The wallet card's
Performance ledger (Cost / Gas / Net per wallet) has nothing to join on. Only
`minted` is real, and it lives on the wallet row.

> **Recommendation: show `minted` only, and move Cost/Gas/Net to the
> account-level Performance sub-tab** where `/api/pnl` genuinely applies. A
> per-wallet split needs a schema change; log it.
>
> This partly undermines brief §2's rationale for merging P&L into Wallets ("P&L
> is per-wallet performance"). The merge still holds — Performance becomes an
> account-level sub-tab of Wallets — but the per-card ledger in the prototype
> cannot be built as drawn.

### 5.10 Send has no dashboard route

`botCommandService.send` exists and is wired to Telegram and Discord.
`mountDashboardRoutes` has no send route.

> **Recommendation: cut the Send sub-tab from the Wallets page for now,** or
> render it as an explanatory panel pointing at Telegram. Adding the route is a
> `src/**` change, out of scope, and it is a value-moving path that deserves its
> own review rather than being slipped into a restyle.

### 5.11 History → Audit evidence is not routed

`triggerAudit` (the `trigger_execution_audit` table) is reachable from
`/triggeraudit` on Telegram and `/trigger-audit` on Discord. No dashboard route.

> **Recommendation: keep the tab, render the unavailable state,** with copy
> naming where it *is* available: "Trigger audit is currently available from
> Telegram (`/triggeraudit`) and Discord. A dashboard view is planned." Log the
> route as a WORKLIST item. This is the one place where showing a deliberately
> empty tab is better than hiding it, because the audit trail's existence is a
> safety property users should know about.

### 5.12 Session count, session expiry, last key export

Account → Security shows "Active sessions 2", "Session expiry 7 days absolute",
"Last key export never". Only the middle one is knowable client-side (it's a
constant, `SESSION_MAX_LIFETIME_MS`). `dashboard_sessions` is never listed by any
route, and key exports are written to `bot_security_audit`, which is owner-only.

> **Recommendation:** keep "Session expiry · 7 days absolute" (a real constant),
> drop the other two rows, and keep the "Log out everywhere" action — which works
> without needing a count.

---

## 5.13 Batch operations — exactly two exist

Worth stating explicitly, because "batch" sounds like a general capability and it
is not. The API supports **two** batch surfaces and no others:

| Batch surface | Route | Shape | Who |
|---|---|---|---|
| **Batch mint** | `POST /api/mints/preview` with `walletLabels[]`, then `POST /api/mints/confirm` | `202 {results:[{label, status, result\|error}]}` | any user |
| **Batch wallet import** | `POST /api/wallets/batch-import` | `201 {results:[{index, status, label?, address?, error?}]}` | **owner only** |

Both return a **per-entry result array**, and partial failure is the normal case —
`importWalletsBatch` catches per key, and `confirmMint` catches per wallet, both
deliberately, so one bad entry never sinks the rest. Any UI that collapses either
into a single success toast is wrong.

**There is no other bulk endpoint.** No bulk send, no bulk wallet delete, no bulk
task cancel, no bulk sniper toggle, no bulk P&L delete. A multi-select UI over
any of those would need new routes and is out of scope.

> **Discoverability note.** In prototype v3 both surfaces existed but neither was
> findable — batch mint was the third sub-tab on Mint with no cross-link, and
> batch import was a spec placeholder. Both are now real panels, cross-linked
> from the single-wallet mint form, and indexed in the command palette under
> Actions. Keep all three entry points; a batch feature nobody finds is the same
> as not having one.

---

## 6. Permission mismatches found while writing this

Three places where the prototype shows something to a user who cannot fetch it.
These are not cosmetic — they produce a `403` on page load.

### 6.1 History → Security log

`bot_security_audit` is only exposed at `/api/admin/security-audit`, behind
`governance.requireOwner`. The prototype gives every user a Security log tab.

> **Fix: make the tab owner-only.** Hide it for non-owners rather than rendering
> a permission error — a regular user has no reason to know the tab exists.

### 6.2 Settings → API usage — already correct in the shipped code

`socialUsageService.summary()` calls `await governance.requireOwner(callerUserId)`
on its **first line** (`src/social/usageService.js:14`). The route
`/api/social-usage` is mounted with `requireSession` only, so a non-owner reaching
the service would get an `AuthorizationError` → `403`.

**The current dashboard already guards this correctly:** `App.jsx:359` renders it
as `{profile.isOwner && <ApiUsagePanel/>}`. The mismatch was in the *prototype*,
which showed the tab to everyone.

> **Fix: keep the existing `profile.isOwner &&` guard.** Do not remove it during
> the restyle, and do not "fix" the service — the owner gate is deliberate, since
> it reports spend across every user's watch rules.

### 6.3 Admin → System health

`/api/admin/health` is registered after the `/api` 404 catch-all in
`server.js:2253`, so it always returns "API route not found". Already recorded as
brief §9.2-O5.

> **Fix: out of scope.** Build the panel, render its error state, report it.

---

## 7. Response states — what to build for every binding

The prototype showed happy path and empty. Four states exist per fetch, and the
brief now requires all four. `useLoad` gives `{data, error, reload}` where `data`
is `null` until the first response resolves.

| State | Condition | Render |
|---|---|---|
| **Loading** | `data === null && !error` | `<Skeleton/>` — card variant for cards, `variant="lines"` for lists. Never a spinner, never an empty state |
| **Empty** | `data !== null` and the collection is genuinely empty | `<Empty/>` per brief §3.7, naming the next permitted action |
| **Error** | `error` is set | `<Notice error={…}/>` with the message and a Retry that calls `reload()` |
| **Populated** | data present | as drawn |

### Error shapes to handle

| HTTP | Body | Where it comes from | Render |
|---|---|---|---|
| `400` | `{issues:[{field, message}]}` | any validation failure | Inline, against the named field. `api()` already joins these into `error.message` |
| `400` | `{error, code}` | `TransactionSafetyError` — `VALUE_CEILING_EXCEEDED`, `INSUFFICIENT_BALANCE`, `DAILY_BUDGET_EXCEEDED`, `GAS_CEILING_EXCEEDED`, `SIMULATION_FAILED`, `WRONG_CHAIN`, `BROADCAST_UNKNOWN` | A `Notice` on the confirm surface, never a toast alone — this is money |
| `401` | `{error}` | session expired | Redirect to login, preserving the intended route |
| `403` | `{error:'Owner access required'}` | non-owner hitting an admin route | The existing `AdminDenied` |
| `403` | `{error, code:'ACCOUNT_BLOCKED', status}` | banned / suspended / deactivated | Full-page block naming the status and reason. Not dismissible |
| `403` | `{error:'Invalid CSRF token'}` | stale CSRF cookie | Reload prompt |
| `409` | `{error}` | username taken | Inline on the username field |
| `429` | `{error}` + `Retry-After` header | login, repeated incorrect export passwords, security password | Countdown using the header. Export remains enabled because a correct password bypasses the failed-guess bucket |
| `503` | `{error, code}` | gas lookup unavailable | Inline "unavailable", not an error banner — this is expected without a key |
| `500` | `{error:'Request failed safely'}` | anything unhandled | Generic `Notice` + Retry |

`api()` in `shared.jsx` already throws an `Error` carrying `.status` and `.code`,
with `issues` pre-joined into `.message`. Branch on `.code` first, then `.status`.

### 7.1 Full-page states — three that replace the page, not a card

These are reached *before* any data is fetched, so none has a loading or empty
variant. All three are drawn in the prototype's **Auth states** page (More sheet,
or ⌘K → "auth states").

| State | Origin | Render |
|---|---|---|
| **`403 ACCOUNT_BLOCKED`** | `requireSession` on **every** route, for `banned` / `suspended` / `deactivated` | Full-page panel naming the status, the owner's stated reason, and the auto-lift date for a time-boxed suspension. A ledger stating what is and is not affected — crucially that **wallets and keys are untouched**. Not dismissible, not a toast, not a banner over a working page |
| **`403 Owner access required`** | any `/api/admin/*` route for a non-owner | The existing `AdminDenied`, unchanged. The rail's Admin item **stays visible** — hiding it makes a legitimate owner think the app broke after a permission change |
| **`401 Authentication required`** | session expired — 8h idle or the 7-day absolute cap | Sign-in panel that **preserves the intended route**, so a user mid-task returns where they were. `403 Invalid CSRF token` reuses this panel with "Reload the page" |

Note the deliberate asymmetry: an owner-gated **route** shows a denial panel,
but an owner-gated **sub-tab** (History → Security log, Settings → API usage) is
hidden entirely. A regular user has no reason to learn those tabs exist; a
regular user navigating to `/dashboard/admin` needs to be told why they can't.

### 7.2 Surfaces that are never genuinely empty

Account, Settings → Appearance and Settings → Transaction mode always have data
for a signed-in user. They still have a **loading** and an **error** state, but no
empty state — the prototype marks these `.od` ("data arrived") rather than `.of`.

Gas is a third case: it has no empty state either, because it either resolves or
returns `503 MISSING_API_KEY`. That 503 is an **inline unavailable note, not a red
error banner** — it is the expected state without a key, and minting is unaffected
since fees come from the RPC provider at transaction time, not from this panel.

### In-flight

Every mutating form disables its fieldset while its request is outstanding
(brief §5, `Form`'s `busy` prop). The confirm-and-mint button additionally shows
the pending state until `/api/mints/confirm` resolves — it returns `202` with a
`results[]` array, so a batch can come back partly failed, and the per-wallet
outcome list must render rather than a single success toast.

---

## 8. Summary for the builder

- **12 elements are MISSING.** §5 gives a recommendation for each; nine are "cut
  or relabel", three are "log for later".
- **3 are permission mismatches** (§6) that would 403 on load.
- **1 is a live bug** — `/api/admin/health` (§6.3).
- Everything else in the prototype binds to a real field, listed above.
- Four response states per binding, not one (§7).

Nothing here requires a `src/**` change to build the redesign. It requires
building the honest version of six tiles instead of the aspirational one.

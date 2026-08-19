# Continue from here — GhostMint dashboard redesign

**If you are picking this up cold, read only this file first.** It says where the
work stopped, what to do next, and how to run and verify. Everything else is
reference you can reach from here.

Last updated: 2026-08-19, after the Schedule tab's action row was corrected.

---

## 1. The next task

**Build the account menu (`.acct-pop`) and the two-tab bell (`.bell-pop`).**

They are the last two shell-chrome items. Both are fully specified — markup, copy,
class names, order — in `REDESIGN_FIDELITY_BACKLOG.md` §2 and §3. Do not re-derive
them from the prototype's HTML; the backlog already did that. Do open the prototype
anyway to check sizes and states (RULE 1c below).

After those: backlog §1.7 (four states on the remaining pages: Automation, Wallets,
History, Account, Settings, Admin) and §1.8 (responsive + light/dark sweep).

## 2. The four rules, in one line each

Full text and the reasoning behind each: `REDESIGN_PROMPT.md`, "Standing
instructions". The reasoning matters more than the rule — read it once.

1. **Nothing that is not in the prototype.** No invented variants, no legacy control
   kept because it works, no accent glow on active states.
2. **"Exactly" covers every axis** — text, size, border width, radius, padding, gap,
   weight, wide/tablet/phone, light AND dark, and all four states.
3. **Re-read `docs/prototype-pages/<page>.html` immediately before editing that
   page.** Every drift so far has been an invention, not a misreading.
4. **Document the reasoning, not just the instruction.**

Plus: **all four states, every time** — populated, loading, empty, error, live in
both directions. The prototype marks its own states inline: `.of` `.ol` `.oe` `.ox`.
Grep a prototype page for `oe` and `ox` to enumerate what a screen owes.

## 3. How to run and verify

Node 18 is the default `node` and Vite needs 20+. Pin Node 24 on PATH first:

```
export PATH="/c/Users/General/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node --run lint
node --run dashboard:build
node --test --test-concurrency=1 $(ls tests/*.test.js | grep -v integration | grep -v smoke)
```

**Baseline is 477 pass / 0 fail.** Anything less is a regression. `dashboard.test.js`
and `dashboardAdmin.test.js` occasionally fail on an ephemeral-port fetch flake —
re-run the file alone before believing it.

Dev server: `.claude/launch.json` has `dashboard-dev` on port 5173. It **proxies to
production**, so the data is real and writes are real. `/api/profile/limits` 404s
locally because it is not deployed yet — that is expected, not a bug.

### Verifying UI — do BOTH, never one

A screenshot alone has twice nearly produced a false report here, and has never once
caught the real bug. Take the screenshot, and also read computed values and compare
them to `prototype.css`. Four bugs this session were invisible in diffs and
screenshots: `button`, `td`, `.pager`, `.card p`. See backlog §9 for the pattern —
**an inherited value always loses to a rule targeting the element directly.**

## 4. Test data — you may create it

The owner has authorised creating placeholder wallets, schedules, presets and
batches to exercise populated / empty / loading / error states.

Currently on the account: wallet **`test-placeholder`** (0.000 ETH), and **22
schedules** — `test-schedule-1..22` (12, still `scheduled`) and `test-pager-*`
(10, all `cancelled`). The 22 exist to give the pager three pages; keep them if you
need to exercise pagination, they cost nothing.

**Two things worth knowing before you make more:**

- **There is no delete.** Cancel sets `status='cancelled'` and the row stays in the
  list forever (schedulerRepository.js:137). Nothing in the dashboard removes a
  schedule, so test rows are permanent. Make them deliberately.
- **A scheduled mint fires unattended.** The `test-schedule-*` rows have mint times
  within days of 2026-08-19 and are still live. They point at a wallet holding
  0.000 ETH so they will fail rather than spend, but set new ones years out
  (`2030-…`; the schema allows up to 5) rather than relying on that.

Creating one through the form takes two submits: the server rejects Azuki
(`0xED5AF388653567Af2F388E6224dC7C4b3241C544`) for a missing price, the `.fielderr`
price field appears, and the second submit carries it. That is backlog §14's
documented deviation, working as designed.

Create through the app's own forms rather than `fetch`, for two reasons: the CSRF
token is not readable from JS, and going through the form exercises the real path.

**Do NOT broadcast a real mint.** Simulation (`/api/mints/preview`) is read-only and
safe; `/api/mints/confirm` spends real money and is irreversible.

## 5. Where things stand

Done, measured against the prototype: shell chrome (rail + top bar) · buttons app-wide
(`.b` family) · sub-tabs and seg controls · the `.notice` error panel · Home's
`FirstRun` and tile copy · the Mint page, all four tabs · the pager, app-wide,
now verified across three real pages rather than one.

**Known gap, deliberately left:** the Scheduled card's "N pending" chip counts only
the page in view. Backlog §11.4 has the measurements and why the fix is server-side.

Not done: account menu, bell, and every page other than Home and Mint.

`REDESIGN_FIDELITY_BACKLOG.md` §1 is the status table; §8 records what was actually
seen rendered, with honest blanks where it was not.

## 6. Map of the documents

| File | What it is |
|---|---|
| **this file** | where to start |
| `REDESIGN_FIDELITY_BACKLOG.md` | the checklist: every item, its prototype element, decisions taken, what is verified |
| `REDESIGN_PROMPT.md` | the standing rules and their reasoning |
| `REDESIGN_DATA_CONTRACT.md` | where every number comes from. **Binding** — it wins over the prototype on which value a tile shows |
| `REDESIGN_BRIEF.md` | the original spec. Superseded by the prototype on anything visual |
| `prototype-pages/*.html` | the prototype, split per page. **This is the design source** |
| `ghostmint-redesign-v3.html` | the whole prototype, with working state and viewport toggles |

## 7. Open questions for the owner

Listed in backlog §7 and §14. None block the next task.

- The method registry on Presets is a hardcoded list, as it is in the prototype.
  Bind it if a route ever exposes the server's real signature table.
- Schedule reveals a price field only after the server rejects for a missing price.
  The prototype has no such field; this covers a case the design does not.

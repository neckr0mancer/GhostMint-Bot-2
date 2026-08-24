# GhostMint — Handoffs (append-only, newest first)

---

## 2026-08-24 — Model 1 — Agent-memory bootstrap + full adversarial audit (no new production code in this unit)

- **Branch:** `main`
- **Starting commit:** `2aa05c2` (`fix(mint): add Ink to canonical SeaDrop core for paste detection`)
- **Final commit:** *(this commit — docs/agent memory files only)*
- **Scope:** Create shared-memory system (`agents.md`, `AGENTS.md` §11, `docs/agent/*`, `docs/agents/reviews/phase-01.md`); record the completed 8-pass adversarial audit and its already-shipped fixes as a committed worklist with stable IDs; run the finishing gate. **No production code changed in this unit** per instruction ("Do not implement fixes yet").

**Changed files (this commit):**
- `AGENTS.md` (modified) — appended §11 shared-memory rules; original contract preserved byte-for-byte (311 lines → 338)
- `docs/agent/PROJECT_STATE.md` (new) — pinned branch/HEAD/deploy/prod-evidence state
- `docs/agent/WORKLIST.md` (new) — 9-phase, ID'd worklist (SEC/TX/RPC/MINT/UX/PERF/INNOV/REG/BASE) with statuses
- `docs/agent/DECISIONS.md` (new) — 10 dated architectural decisions with evidence
- `docs/agent/HANDOFFS.md` (new) — this file
- `docs/agents/reviews/phase-01.md` (new) — phase-1 audit review (findings → fixes → open items)

**Incident recorded (caught in self-scrutiny before commit):** Windows filesystems are case-insensitive, so the requested separate `agents.md` entry point **is the same file as `AGENTS.md`** — an initial write to `agents.md` overwrote the implementation contract. Caught via staged-diff inspection (303 unexpected deletions), restored from `git show HEAD:AGENTS.md` via node (PowerShell pipeline mangled newlines on first attempt), verified: original 311 lines intact + §11 appended, diff vs HEAD shows additions only, zero deletions. **Lesson for all models: on this machine there is no separate `agents.md`; `AGENTS.md` §11 IS the memory entry point.**

**Commands run & results:**
- `git status` / `git branch --show-current` / `git log --oneline -10` — clean except phantom `M` on `tests/bumper.test.js` + `tests/launchTriggers.test.js` (verified: `git diff` empty, blob hashes == HEAD, `i/lf w/lf`) — **left untouched, not staged**
- `node --run lint` — **OK** (0 problems)
- `node --run dashboard:build` — **OK** (1.86s; pre-existing >500kB chunk warning only)
- `node --test --test-concurrency=1 tests/smoke.test.js` — **3/3 pass** (health 14.5s, discord-failure 15.7s, banned-account 19.7s)
- Full suite reference: **908/908 pass** earlier today on this same code base (`2026-08-24T08:30Z`)

**Results:** Audit complete; 15 confirmed defects fixed and pushed across `d31f2df..2aa05c2` (see `phase-01.md` table); 20+ open findings recorded in the worklist with IDs, severities, file:line and acceptance notes.

**Unresolved risks:** multi-instance nonce/lock safety (SEC-003, TX-017); app-vs-DB clock drift (RPC-004); DNS-rebinding SSRF residual; no latency aggregation yet to prove competitive wins numerically (BASE-002).

**Exact next action:** Implement `INNOV-001` (`scheduledValidity.js` pure oracle + per-block recheck loop) with deterministic tests `REG-002` (T+1/T+3/T+7, RPC disconnect, duplicate block, restart) — per owner-approved direction ("trigger first… apply parts to sniper and repository, particularly the scheduled mint execution path"). Before that, resolve owner decision on `INNOV-002` (ACO deletion order vs live squads).

---

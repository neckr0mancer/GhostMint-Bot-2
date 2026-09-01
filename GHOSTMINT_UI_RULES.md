# GhostMint UI Rules

## Purpose and authority

This document is the interaction and UI source of truth for `dashboard/src`. It
was derived from a rule-by-rule review of an unrelated inventory-app UI rules
document against GhostMint's actual dashboard code (2026-08-16): every rule
below either codifies a pattern the dashboard already follows so it doesn't
regress, or closes a verified gap the review found. Rules specific to a
different product's domain (item completeness states, workspace/category
search scoping, a Syne/Inter type system, a blue/cyan color identity) were
deliberately left out — see "Explicitly out of scope" at the end.

New dashboard/admin work must follow these rules. When a rule and existing
code disagree, fix the code unless the rule's rationale no longer applies —
in which case update this document in the same change.

## Shared dialogs, prompts, and toasts

- Browser-native `alert`, `confirm`, and `prompt` are prohibited. Use
  `confirmDialog`/`promptDialog` from `shared.jsx` (rendered by the single
  `<ConfirmHost/>` per shell) for every user-facing decision, and `notify()`
  (rendered by `<ToastHost/>`) for every non-blocking outcome.
- Destructive and consequential confirmations must name the exact affected
  record, not a generic noun. `Remove wallet ${label}?` is the standard;
  `"Delete this P&L record?"`, `"Cancel this scheduled task?"`, and
  `"Remove this post-confirmation copy sniper?"` are violations wherever the
  record's name/label is already in scope — pass it into the message.
- Toasts are transient, session-only feedback. The notification bell's
  "Recent notifications" log is a capped, non-persisted scratchpad of what
  toasts already said — it must never be promoted into a durable, read/unread
  Inbox. The bell's "Pending confirmations" section is the one place that
  gets a durable, server-backed, actionable list.
- A confirm/prompt dialog's Escape key and scrim click must resolve to the
  safe outcome (Cancel), never to silently confirming a mutation.

## Search

- Every list page's search field is one component family: a labeled
  `.page-search` input, `type="search"`, no `autoFocus`, consistent
  placeholder style (`"Label, address, chain…"`-shaped), and page-specific
  empty-result copy (`"No wallets match this search."`).
- Add a themed in-input clear (×) control to that shared pattern instead of
  relying on the browser's native `type="search"` clear affordance, which is
  unstyled in Chrome, absent by default in Firefox, and inconsistent in
  Safari. The clear control must show only when the field has text, clear
  the query only, and keep focus in the input.
- Search operates over data the API has already scoped to the caller's
  linked identity. Never fetch broader data client-side and filter it down
  for display — the server-side scope is the authorization boundary.

## Buttons and touch targets

- Every interactive control is at least 44×44px on mobile. Set
  `--tap-min: 44px` as the shared default across themes (not `auto`); only
  widen it per theme (Quiet Ledger's 48px), never drop it.
- `.small` buttons (card Edit/Remove/Disable, the Tasks table's
  cancel/pause/resume/retry row) must not fall under 44px tap height on
  mobile widths, even though they stay visually compact on desktop.
- Disabled buttons use lower contrast plus disabled cursor/semantics, never
  opacity alone.
- Buttons use a pointer cursor on pointer devices and a visible
  `:focus-visible` outline (already global — keep it that way).

## Forms and validation

- Labels are always visible (`Field`/`Select` wrap every control in a real
  `<label>`); placeholders are supplementary only, never a label
  replacement.
- Every mutating form (create/update/delete submit handlers) must lock
  itself while its request is in flight: disable the submit button
  (`disabled={busy}` or equivalent) at minimum, and prefer disabling the
  whole fieldset, restoring interaction only on success or a recoverable
  failure. `Login`'s `busy` state and `GasPanel`'s `loading` state are the
  existing idiom — apply it to every `Form` submit handler, not just those
  two components.
- A recorded numeric zero renders as `0`, never as a blank or "Unavailable"
  placeholder. Use nullish coalescing (`??`), not truthiness checks, when a
  legitimate value can be zero (wallet balances, P&L net, etc.).
- Two-column field rows (`.field-row`) collapse to one column under 640px;
  keep new multi-field rows on this same breakpoint instead of inventing a
  new one.
- Conditional forms react immediately to the governing choice (e.g. the
  wallet-import method toggle swapping the private-key/seed-phrase field) —
  no stale hidden requirement left over from a prior choice.

## Motion and reduced motion

- Motion stays brief and functional (roughly 150–250ms for transitions).
- Wrap ambient/decorative animations — `pulseDot`, `shimmer`, `spin`, Neon
  Arcade's `confettiBurst` — in `@media (prefers-reduced-motion: reduce)`
  overrides that drop them to a static state. Short functional transitions
  (toast slide-in, sheet open) may shorten instead of disappearing entirely.

## Mobile chrome and safe areas

- Fixed/sticky mobile surfaces — `.mobile-bottombar`, `.rail-mobile-header`,
  `.more-sheet` — must reserve space for device safe areas via
  `env(safe-area-inset-bottom)` / `env(safe-area-inset-top)` rather than a
  bare fixed padding value, so controls never sit under a notch or home
  indicator.
- A bottom sheet's visible drag handle must always have a working tap
  target as its baseline interaction (already true for `MoreSheet` and
  `AdminMoreSheet`). A real swipe-down gesture on top of that tap target is
  encouraged but optional for navigation sheets; it becomes mandatory only
  if GhostMint later adds a create/edit bottom sheet, which must never rely
  on swipe as the only way out.

## Loading and empty states

- List/page loading renders `<Skeleton/>` (card or `variant="lines"`) while
  data is `null` — never a blank pane and never a full-page spinner for a
  partial-page load.
- In-place form work must not shift the layout. Contract detection, simulation, validation, and
  similar progress belongs inside the initiating input/button or over an already-reserved result
  surface; never insert a temporary loader block that pushes surrounding fields or actions down.
- A consequential submission locks every control and exit belonging to that operation, including
  Submit, Back, Cancel, Close, tab changes, and duplicate action paths. Mark the participating
  form or region `aria-busy`, keep its geometry stable, and release the lock from `finally` so each
  control returns to the enabled/disabled state it had before the request. This does not authorize
  blocking unrelated page sections during ordinary lookups, list refreshes, or background loads.
- Empty states use `<Empty text="…"/>` with copy that explains what's empty
  and names the next permitted action (e.g. "No wallets yet. Create the
  recommended server-side wallet below."), not a bare "No results."
- Status is always communicated with text plus color/shape together via
  `StatusPill` — never color alone.

## Navigation and layout persistence

- A standing layout preference (the icon-rail's expanded/collapsed state)
  persists in `localStorage` and survives reload; open/closed session state
  for overlay navigation (the hamburger drawer, the More sheet) does not
  persist and always starts closed on a fresh load. Keep this split when
  adding new layout preferences — decide per preference which bucket it
  belongs in rather than persisting everything by default.
- An incidental viewport/resize event must never dismiss an already-open
  unpinned nav surface; only an explicit close action may do that.

## History and audit surfaces

- Operational, mutable feeds (the Activity page) and durable, immutable
  audit evidence (`trigger_execution_audit`, `bot_security_audit`) are
  conceptually separate, matching how Telegram/Discord already expose the
  latter via `/triggeraudit` / `/trigger-audit`. When the dashboard grows a
  read-only History/audit page, it must be additive to Activity, not a
  reskin of it — Activity keeps its filtering/paging role, History is
  append-only evidence.

## Explicitly out of scope

The following do not apply to GhostMint and must not be imported wholesale
from unrelated UI-rule documents written for other products:

- A specific typeface pairing (e.g. Syne + Inter) or a specific accent
  color/gradient system. GhostMint owns its own token-driven five-theme
  system (`themes.css`); a new theme must follow that token structure, not
  a different product's literal color values.
- Item completeness states (Incomplete/Partial/Complete) and
  package/subunit quantity math — there is no draft-record concept in
  GhostMint's domain.
- Workspace/Category/Project search scoping — GhostMint's authorization
  boundary is the linked identity itself, already enforced server-side.
- Business-language simplification away from domain terms. Gas, gwei, wei,
  calldata, nonce, and contract address are correct vocabulary for
  GhostMint's audience, not jargon to hide.

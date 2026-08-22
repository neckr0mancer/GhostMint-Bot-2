# RPC pool infrastructure — wired live (2026-08-22)

Recorded by the ox-alpha session during the one-week competitiveness push
(see [`COMPETITIVE_ANALYSIS.md`](./COMPETITIVE_ANALYSIS.md)). This is the ground truth for
which provider app serves which pool, what was verified, and what remains an owner-side action.
Merge the durable facts into `docs/WORKLIST.md` when convenient (kept out of it here to avoid
colliding with a concurrent session's uncommitted WORKLIST edits).

## Alchemy apps ↔ pools (three-way isolation now physically real)

| App | Key prefix | Serves | Networks | Verified |
|---|---|---|---|---|
| `ghostmint-wraith` | `alch_h9Tl…` | **Sniper pool** (`{CHAIN}_RPC_SNIPER_URLS/_WS`, pre-existing) | all 5 mainnets incl. Robinhood (4663) | HTTP `eth_blockNumber` + WSS handshake on all 5 |
| `ghostmint-specter` | `alch_Uyjv…` | **Scheduled/Degen fast pool** (`{CHAIN}_RPC_FAST_URLS`) | all 5 mainnets — Polygon added today via Admin API | HTTP on all 5 |
| unnamed general key | `alch__JXq…` | **General pool** primary on ETH/ARB/RBNH only (app not provisioned for BASE/POLY) | ETH, ARB, RBNH | HTTP on those 3 |

- Admin API used to patch specter: `PUT https://admin-api.alchemy.com/v1/apps/{id}/networks`
  with the full `{networkAllowlist:[…]}` (GET the app first and echo its own network IDs —
  invented IDs 400). `PATCH /apps/{id}` is metadata-only; `/networks` sub-endpoint is the real one.
- Billing tier (Pay-As-You-Go) is **not verifiable** through this access key (Usage API is
  beta/permission-gated). Owner says they will pay; burst behavior at ~50 simultaneous fires
  should be re-checked after the upgrade.

## Railway variables written 2026-08-22 (11 total)

General failover lists (new): `ETH_RPC_URLS`, `BASE_RPC_URLS`, `ARB_RPC_URLS`,
`POLYGON_RPC_URLS`, `ROBINHOOD_RPC_URLS`.
Fast pool (new): `{CHAIN}_RPC_FAST_URLS` ×5 = specter URLs (config auto-appends the general list).
Sniper pool: pre-existing wraith URLs + WS — left untouched, live-verified instead.
Also pre-existing: `RPC_TIMEOUT_MS=20000`, `RPC_RETRIES=3`.

Verification chain, in order: every candidate URL answered a live `eth_blockNumber` before being
included (llamarpc/1rpc/base variants that failed were excluded); all five sniper WSS endpoints
handshook; the exact production values were fetched back from Railway and parsed through the real
`src/config` loader printing resolved pools per chain; deployment `e3174b55` redeployed `SUCCESS`
04:46Z with clean boot logs ("Configuration loaded", workers up, zero error lines).

Public fallbacks currently in the general lists: publicnode (ETH/POLY), cloudflare-eth,
drpc.org (ETH/BASE/ARB/POLY), official chain endpoints. Llama RPC was dead across the board
during testing; 1rpc.io alive only for Polygon.

## Owner decisions recorded same day

1. Broadcast-racing extended to scheduled mints (reverses Round 16 item 5's sniper-only scope).
2. Bump aggressiveness + simulation policy for pre-armed fires: analysis doc §5 defaults approved.
3. Live-fire test funds available on Robinhood Chain (owner holds cheap ETH there).

## Known follow-ups from this work

- `ghostmint-specter` still carries testnet/BNB/Hoodi networks it doesn't need — trim when bored;
  harmless.
- The general-pool key covers only 3 of 5 chains; BASE/POLY general pools are public-endpoint-led.
  Fine as fallback depth, but a second paid provider for those two chains would harden them.
- `.env.example` gained the previously-undocumented `_FAST_URLS` / `_SNIPER_*` var names (same commit).

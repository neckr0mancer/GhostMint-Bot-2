# Milestone 14 — live testnet acceptance runbook

## Why this exists

The Milestone 7 transaction engine (simulation, spend caps, gas ceilings, nonce
queueing, replay protection) has only ever been exercised against mocked RPC
providers and database-backed automated tests. Before GhostMint is trusted
with real funds (Milestone 16, production release gate), it must be proven
against a real chain at least once, using the exact same code path a
production mint would use — no shortcuts, no mocks, no bypass.

`scripts/live-acceptance-run.js` drives that one real mint through the
unmodified `mintService` → `mintExecutionService` → `transactionEngine`
pipeline and records the outcome in the `live_acceptance_runs` table. This is
a manual tool for the project owner to run by hand. It is never invoked by
CI, the scheduler, or any bot command, and it refuses to target anything
other than a chain explicitly marked as a testnet in `src/config/index.js`
(currently only `sepolia`).

## Prerequisites

1. **A disposable test mint contract on Sepolia.** Deploy any small ERC-721
   contract with a public, payable `mint()` function taking no arguments —
   for example a minimal OpenZeppelin `ERC721` with:

   ```solidity
   function mint() external payable {
     _mint(msg.sender, nextTokenId++);
   }
   ```

   Remix (remix.ethereum.org) connected to a Sepolia wallet is the fastest
   way to deploy this. Record the deployed contract address.

2. **A throwaway wallet funded with Sepolia test ETH.** Use a wallet you
   create specifically for this run — never an operational wallet. Fund it
   from a public Sepolia faucet (a few cents worth of test ETH is enough for
   one mint).

3. **Add that wallet through GhostMint's normal encrypted wallet flow** —
   the Telegram/Discord `/wallet add` (or dashboard equivalent) command, on
   the account that will act as the run's operator. This ensures the key is
   encrypted at rest through the Milestone 4 envelope, exactly as any real
   wallet would be. **Never** paste the raw private key into an `.env` file,
   a script argument, a log line, or this chat — the acceptance-run tooling
   only ever references the wallet by its database `walletId`.

4. **The operator's internal `user_id` must be a governance owner.** Use the
   existing owner-management flow (Milestone 7a/13d) to confirm the operator
   account is an owner; the tool refuses to run otherwise.

## Configuration

Temporarily set, in the environment the script will run in (not committed,
not shared):

```
SUPPORTED_CHAINS=ethereum,sepolia        # ethereum stays required as default; sepolia added for this run
SEPOLIA_RPC=<a real Sepolia RPC URL>     # or SEPOLIA_RPC_URLS for failover endpoints
LIVE_ACCEPTANCE_CONFIRM=RUN
LIVE_ACCEPTANCE_OPERATOR_USER_ID=<the owner's internal user_id>
LIVE_ACCEPTANCE_CHAIN=sepolia
LIVE_ACCEPTANCE_WALLET_ID=<the wallet's numeric id from `/wallets` or the dashboard>
LIVE_ACCEPTANCE_CONTRACT_ADDRESS=<the deployed test contract address>
LIVE_ACCEPTANCE_METHOD_SIGNATURE=mint()
LIVE_ACCEPTANCE_VALUE_WEI=0
```

Revert `SUPPORTED_CHAINS` and clear the `LIVE_ACCEPTANCE_*` values once the
run is complete; they should not remain set in a deployed environment.

## Running it

```
npm run acceptance:run
```

(or `powershell.exe -File .\scripts\project-npm.ps1 run acceptance:run` per
the project's Windows npm launcher.)

The script will:

1. Refuse immediately if `LIVE_ACCEPTANCE_CONFIRM` is not exactly `RUN`.
2. Refuse if the operator is not a governance owner.
3. Refuse if the target chain is not marked as a testnet.
4. Refuse if the wallet does not exist for that operator, or is not
   configured for the requested chain.
5. Call `mintService.prepare` and `mintExecutionService.preview` (forced
   simulation) — identical to what a dashboard or bot confirmation screen
   would show before any real mint.
6. Call `mintExecutionService.executePrepared`, which submits through the
   real `transactionEngine`: policy ceilings, gas ceiling, daily spend
   budget, nonce reservation, signing, broadcast, and confirmation polling
   all run exactly as they would in production.
7. Persist a row to `live_acceptance_runs` — pass or fail — with the
   transaction intent id, policy snapshot, simulation flag, and a redacted
   evidence payload (never the wallet's private key).
8. Print a redacted human-readable summary, including the transaction hash
   and block-explorer link on success.

## What "pass" means

The run recorded in `live_acceptance_runs.outcome = 'passed'` requires the
transaction to reach `confirmed` state on chain within the configured
confirmation count, with `simulation_performed = true`. Anything else
(reverted, replaced, unknown/timed out, or refused before broadcast) is
recorded as `failed` with a classified `failure_code` and `failure_reason`.

## Before Milestone 16

Do not release to production or move meaningful funds until a `passed` row
exists for this run. Record the `run_id`, chain, contract address, and
transaction hash in the release notes as the evidence for the mandatory
live acceptance requirement in `ROADMAP.md`.

## What this tool deliberately does not do

- It does not accept a raw private key anywhere — only an existing,
  already-encrypted wallet.
- It does not run in CI or on any schedule; it is a manual, one-time gate.
- It does not add a bypass path to the transaction engine; every safety
  rail (ceilings, forced preview/simulation, nonce queueing) applies exactly
  as it would to any other mint.

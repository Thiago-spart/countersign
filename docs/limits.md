# Limits

What Countersign does not protect against, and the edges of what it does. Numbers are the contract defaults and were measured in the local sandbox.

## Countersign protects only funds in the vault

The agent's environment must hold only the vault's function-call key. Anything else it holds bypasses Countersign entirely.

- A general wallet MCP server such as near-mcp, given an owner key or any full-access key, exposes `tokens_send_near`, `account_add_access_key`, `account_delete_account` and `account_export_account`. With those the model can send funds directly, add itself a full-access key, delete the account or export the key. None of these go through the vault.
- near-mcp tools default `networkId` to `mainnet`.
- The owner key is never written to a file the agent reads. `countersign setup` doesn't write it to `.env`. `countersign sandbox up` writes `.env.sandbox` (agent side only) and `.env.sandbox.owner` (owner key, mode 0600). Owner commands take `--owner-env`. The MCP server refuses to start when `COUNTERSIGN_OWNER_KEY` is in its environment or env file.
- Funds the agent holds anywhere else (another account, another key) are not covered.

## The agent's function-call key

The agent's key is a function-call access key on the vault account: receiver = the vault, methods = `pay`, `request_approval`, `report`, allowance 1 NEAR.

It can:
- call `pay` (subject to the vault's limits and the registry check below), `request_approval` (queues a payment for the owner) and `report` (files a registry report as the vault).

It can't:
- transfer NEAR directly. The protocol refuses with `RequiresFullAccess` (attack A6).
- call any other vault method (`approve`, `withdraw`, `set_limits`, `trust`, ...). The protocol refuses with `MethodNameMismatch` (A6).
- attach a deposit, so it can't call the owner methods that require 1 yoctoNEAR even if they were in its method list (`DepositWithFunctionCall`, A6).
- add or delete keys, deploy code, or delete the account.

Gas and the allowance:
- Each call's prepaid gas is debited from the 1 NEAR allowance. 60 `pay` calls used about 0.038 NEAR in the sandbox; a network that charged the full prepaid gas would use about 0.3 NEAR for the same 60.
- The SDK attaches 50 TGas to `pay` and `report`. The vault refuses `pay` below 40 TGas and `report` below 35 TGas with "not enough gas", before reserving anything.
- When the allowance runs out, the network rejects the agent's transactions before the contract runs. Nothing is reserved or sent. The vault account has no full-access key after setup, so nobody can add a fresh key to it: the owner withdraws the funds (`withdraw`) and sets up a new vault. `countersign status` warns below 20% of 1 NEAR.
- The agent signs as the vault, so the vault account prepays the gas from its own balance. It needs about 0.06 NEAR free above its storage stake, or the network rejects the agent's transaction before the contract runs (nothing is reserved). `countersign status` warns below 0.06 NEAR free.

## What the vault enforces (the onchain floor)

These hold even if the agent skips the SDK and calls the vault directly (attacks A4, A5):

- per transaction 1 NEAR, per UTC day 5 NEAR (payments, approved payments and the 0.01 NEAR report deposits all count);
- a payee with 2 or more registry reports goes to Pending (`registry_flagged`); a rebuttal doesn't change that;
- an untrusted payee above 0.1 NEAR goes to Pending (`unknown payee`);
- pending queue at most 50 entries; at most 5 agent reports per UTC day;
- pause stops `pay`, `request_approval`, `approve` and `report`.

What it doesn't enforce:
- Splitting. An agent can pay an unknown payee 0.1 NEAR at a time until the daily cap: 50 payments, 5 NEAR (A5). The daily cap is the bound.
- Payee quality below the thresholds. A payee with 0 or 1 reports, under 0.1 NEAR, is paid. The SDK's scoring (age, activity, look-alike, code change) runs off-chain and is skipped by an agent that calls the vault directly.
- A compromised agent can fill the pending queue (50 entries; with 280-byte memos and reasons that is roughly 0.4 NEAR of storage, paid by the vault) and use its 5 daily reports against any account. The owner can `deny` entries to clear the queue.
- A reservation is released only on the same UTC day. A payment whose callback lands after midnight UTC keeps counting against the previous day, which no longer matters.

## The registry

- **No sybil resistance on-chain.** Anyone can report any account once per reporter account, for a 0.01 NEAR deposit (refunded except the storage). Two cheap accounts are enough to send every Countersign payment to a given payee into Pending. That fails safe (a human approves), but it is a griefing vector against honest payees.
- **Reporter credibility is off-chain only.** The SDK weights each report by the reporter's age and activity (`min(1, age_days/30) × (tx ≥ 10 ? 1 : 0.5)`, 25 points per report, halved when the target rebutted, capped at 75). The vault counts raw reports.
- **Rebuttals.** A target can attach one rebuttal. It halves the SDK's registry points; it doesn't move a payment out of Pending on-chain.
- **Withdrawals.** A reporter can withdraw its report. Reports filed through a vault can't be withdrawn: the vault has no method for it.
- **Testnet only.** The registry is deployed on testnet. On mainnet no registry is configured, so `check --network mainnet` reads no reports; the registry signal then shows `no registry reports` and scores 0.
- `first_seen` / `last_seen` in a summary are not recomputed after a partial withdrawal, and `get_reports` order changes after a withdrawal. Storage is refunded by the bytes released, so the last reporter to withdraw may get back storage another reporter paid for. See `SECURITY.md`.

## Sandbox mode uses fixture data

In the local sandbox (`pnpm attacks`, `countersign sandbox up`), account age, transaction count and contract deploy times come from `fixtures/sandbox.json` (synthetic data; times relative to when the data source is built, e.g. `-2h`). An account not listed there doesn't exist. Registry reports are read live from the sandbox registry contract. A long-running sandbox MCP server ages fixture accounts in real time; restarting it resets them.

On testnet and mainnet, existence comes from RPC (`view_account`) and age, activity and deploys come from NearBlocks. An account RPC finds but NearBlocks hasn't indexed counts as under 1 day old (+30). If any network-backed signal is unknown (NearBlocks down, rate-limited), the verdict is at least `warn`.

## Payments and networks

- NEAR only. No fungible tokens (USDC, USDT, ...) or NFTs in v1.
- Mainnet is read-only. `check` works on mainnet; `safeTransfer`, `report` and `setup` refuse before building or signing anything.
- `setup` supports testnet only. The vault needs at least 3 NEAR: its code storage stake is about 1.95 NEAR. Running the attack suite against a testnet vault (`pnpm attacks --network testnet`) needs at least 7 NEAR in it: A5 drains up to the 5 NEAR daily cap. On a shared vault A5 expects `floor((daily − spent today) / 0.1)` payments, and a run that crosses midnight UTC reports INCONCLUSIVE for A5.

## Scoring

The verdict is a deterministic score from `policy.json`: under 30 allow, 30 to 69 warn, 70 or more block. A missing account is block (100). It catches the patterns it has signals for (look-alike names, fresh accounts, low activity, recent code changes, registry reports). It doesn't read invoices or judge intent, and a well-aged account with no reports scores as allow even if it is malicious. Look-alike detection compares against the trusted list and past payees only, and flags near-misses such as `alice` vs `alicia` (warn, never block on its own).

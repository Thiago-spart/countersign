# Security

## Reporting a vulnerability

Open an issue on this repository. The contracts are deployed on testnet only; nothing holds mainnet funds.

## Scope

- `contracts/vault`: one vault per agent. Holds the agent's NEAR. The agent reaches it only through a function-call key on the vault account (`pay`, `request_approval`, `report`); the owner is a separate account.
- `contracts/registry`: a shared, ownerless list of reports about accounts. No admin, owner or upgrade methods.

The off-chain scorer (`packages/core`) and SDK are not covered by this audit; their tests are in `packages/*/test` and the end-to-end attack suite in `attacks/`.

## Audit (2026-11-03)

Method: the `near-contract-audit` checklist (its 14 detectors in `.claude/skills/near-contract-audit/references/`), applied by hand to every public method and callback, followed by a manual review of business logic, access control, economic attacks and cross-contract calls. No automated NEAR static analyzer was run. The auditor is the same AI coding agent (Claude Code) that wrote most of the code; treat this as a self-review, not an independent audit.

Result: **no High or Medium findings.** Three Low findings were fixed with tests, and two Info items were hardened after the final review (I-2, I-10). The remaining Low and Info items are accepted and listed below.

### Detector checklist

| Severity | Detector | Result |
|---|---|---|
| High | non-private-callback | Pass. `on_registry_summary`, `on_transfer_done`, `on_report_done` are `#[private]`; `new` is `#[init] #[private]`. Because the agent signs as the vault, `#[private]` alone doesn't keep the agent out; see I-10. |
| High | reentrancy | Pass. `pay` and `report` reserve against the daily cap before the cross-contract call; callbacks release the reservation on every non-paid branch. `approve` removes the pending entry and reserves before transferring. `on_registry_summary` re-checks the balance before transferring. |
| High | incorrect-argument-or-return-types | Pass. Amounts are `NearToken` (JSON string), ids and timestamps `U64`. Native `u32` only for counts (`reports`, `registry_pending_threshold`), `u32` pagination, and `u64` day numbers (~20,000) in private callback args. |
| High | unsaved-changes | Pass. `near_sdk::store` collections are written back at the end of each call. Where storage is measured mid-call, the registry flushes the nested map and outer maps first. |
| High | owner-check | Pass. Every owner method calls `require_owner`; every agent method calls `require_self` (predecessor = the vault). Sandbox tests call each with a stranger. |
| High | yocto-attach | Pass. `approve`, `unpause`, `set_limits`, `trust`, `untrust`, `withdraw` require exactly 1 yoctoNEAR. `pause` and `deny` only tighten controls and are deposit-free on purpose (no friction in an emergency). |
| High | storage-collision | Pass. `BorshStorageKey` enums; the registry's per-target maps use `sha256(target)` in the prefix. |
| High | required-initialization-macro | Pass. Vault `new` is `#[init]` (a second init fails; tested). The registry has no init: it uses `Default` and has no owner to set. |
| Medium | gas-griefing | Pass. No state-changing method loops over a collection. The pending queue is capped at 50; `get_reports` pages are capped at 100. `get_trusted` returns the whole owner-managed set (view only; see I-6). |
| Medium | insecure-random | Not applicable. No randomness. |
| Medium | prepaid-gas | Pass. Callbacks get static gas (25 / 10 / 10 TGas). `pay` requires ≥ 40 TGas and `report` ≥ 35 TGas before reserving, so a callback can't run out of gas and strand a reservation. If static gas can't be attached, the whole call fails atomically. |
| Low | cover-storage-cost | Pass. The registry measures storage after flushing and keeps that much of the deposit (min 0.01 NEAR), refunding the rest. The vault pays for its own pending-queue storage; `enqueue` rejects with "insufficient balance" when it can't. |
| Low | unsafe-math | Pass. `overflow-checks = true` in the release profile; saturating or checked arithmetic throughout (`limits::reserve` uses `checked_add`). |
| Low | float-math | Pass. No floats in the contracts. |

### Findings

| ID | Sev. | Contract | Finding | Resolution |
|---|---|---|---|---|
| L-1 | Low | vault | `pay` and `request_approval` accepted `amount = 0`: a zero transfer (or a zero pending entry) the agent could repeat to spend the vault's gas and spam events. The SDK already refused it. | **Fixed** (commit "fix(vault): reject zero amounts, validate limits, refuse self-owned vault"). Both return `Rejected("amount must be positive")` and emit `payment_rejected`. Test: `vault/src/lib.rs` `zero_amount_is_rejected`. |
| L-2 | Low | vault | `new` and `set_limits` accepted any limits, e.g. `registry_pending_threshold = 0` (every payment queued as "registry_flagged"), `per_tx > daily`, `unknown_payee_max > per_tx`. Owner-only, but an easy mistake. | **Fixed** (commit "fix(vault): reject zero amounts, validate limits, refuse self-owned vault"). Both panic with "invalid limits: ..." unless `unknown_payee_max <= per_tx <= daily` and `registry_pending_threshold >= 1`. Tests: `new_rejects_invalid_limits`, `set_limits_rejects_inconsistent_limits`. |
| L-3 | Low | vault | `new` accepted `owner_id` = the vault itself. Setup deletes the vault's full-access key, so such a vault could never be withdrawn from or unpaused (funds stuck). | **Fixed** (commit "fix(vault): reject zero amounts, validate limits, refuse self-owned vault"). `new` panics with "owner must be a separate account". Test: `new_rejects_vault_as_owner`. |
| L-4 | Low | registry | No sybil resistance. Any two accounts can report a payee (0.01 NEAR deposit each, mostly refunded), which sends every vault payment to it into Pending. Fails safe (a human decides) but lets anyone grief an honest payee. | Accepted (design). Reporter credibility is weighted off-chain by the SDK only. Documented in `docs/limits.md`. |
| L-5 | Low | vault | A compromised agent can fill the pending queue (50 entries, roughly 0.4 NEAR of storage the vault pays) and file 5 reports per UTC day as the vault. | Accepted. Both are capped; the owner can `deny` entries and `pause`. |
| L-6 | Low | registry | Storage cross-subsidy: refunds are by bytes released, so the last reporter to withdraw from a target gets back the inner-map and summary storage the first reporter paid for. The registry never refunds more than it collected in total. | Accepted. |
| L-7 | Low | vault | The vault trusts whatever contract is at `registry_id`. Anyone holding a full-access key on the registry account could redeploy it to return 0 reports, turning off the registry check (per-tx, daily and unknown-payee limits still hold). | Open, deployment. The registry has no upgrade method; the deployed registry account should have no full-access key. Checkable with near-mcp `account_list_access_keys` (set `networkId` to `testnet`) or near-cli-rs `near account list-keys <id> network-config testnet now`. |
| I-1 | Info | both | NEP-330 `contract_source_metadata` returned the template placeholder `https://github.com/<xxx>/<xxx>`. | **Fixed** (commit "fix(contracts): real repository URL in NEP-330 source metadata"). |
| I-2 | Info | vault | `on_transfer_done` and `on_report_done` used `#[callback_result] Result<(), PromiseError>`. near-sdk accepts empty data but panics on non-empty data that isn't JSON `null`, and on a call with no promise result. Reachable only through a replaced registry (L-7) or a direct call; the effect would be 0.01 NEAR left reserved for the day. | **Fixed** (final-review fix wave): all three callbacks read the promise result by hand and never panic; only a failed promise counts as failed. See I-10. |
| I-3 | Info | registry | `first_seen` / `last_seen` in `Summary` are not recomputed after a partial withdrawal (only cleared when no reports remain). The vault uses only `reports`. | Accepted; documented on the type. |
| I-4 | Info | registry | `get_reports` order is insertion order until a withdrawal swaps the last entry into the removed slot. | Accepted; documented on the method. |
| I-5 | Info | vault | `approve` doesn't re-check `per_tx`, the registry or the balance; the owner decides. If the vault can't afford the payment, the runtime fails the whole `approve` receipt (`LackBalanceForState`), so the payment stays pending and nothing is reserved. | Accepted. Test: `vault/tests/owner.rs` `approve_unaffordable_payment_rolls_back`. |
| I-6 | Info | vault | `get_trusted` returns the whole trusted set. It is owner-managed and a view, so the only effect of a huge set is a view that runs out of gas. | Accepted. |
| I-7 | Info | vault | Reports filed through a vault can't be withdrawn: the vault has no `withdraw_report` forwarder (and the agent key couldn't call the registry directly). | Accepted. |
| I-8 | Info | registry | A refund to a reporter account deleted before the refund lands bounces back to the registry and stays there. | Accepted. |
| I-9 | Info | both | `cargo near build non-reproducible-wasm` embedded the builder's cargo registry path (`$HOME/.cargo/registry/...`, including the local username) in panic strings. | **Fixed**: `scripts/build-contracts.sh` remaps the cargo home to `/cargo` and the repo root to `/countersign` (`--remap-path-prefix`). The wasm still records the rustc commit. Clean builds from two checkouts at different paths on one machine are byte-identical; a match across machines is not verified, so CI rebuilds and tests from source instead of diffing `contracts/res`. |
| I-10 | Info | vault | The agent signs **as the vault**, so `#[private]` (predecessor = the vault) doesn't tell the agent apart from the vault's own `.then` callbacks. What keeps the agent out of `on_registry_summary` / `on_transfer_done` / `on_report_done` is the function-call key's method list (`pay`, `request_approval`, `report`); the protocol refuses anything else with `MethodNameMismatch` (attack A6). | **Defence in depth added** (final-review fix wave): a callback invoked without exactly one promise result (i.e. directly, not by `.then`) returns `Rejected` / `Failed("not called as a callback")` / `false` without releasing any reservation, sending anything or emitting an event. Test: `vault/src/pay.rs` `callbacks_without_a_promise_result_change_nothing`. `countersign setup` also verifies after its batch that the vault's only key is the agent's function-call key with receiver = the vault, exactly those 3 methods and a 1 NEAR allowance (`packages/cli/test/setup-keys.test.ts`). |

### Fixed during development (before this audit)

Found in code review while the contracts were written; each has tests in `contracts/*/src` (unit) or `contracts/*/tests` (sandbox).

| Issue | Tests · commit subject |
|---|---|
| Callbacks could panic on a malformed registry response (`#[callback_result]` on `get_summary`), stranding the daily reservation. Now read by hand with a size cap; malformed → `Rejected("registry unavailable")`. | `malformed_summary_rejects_and_releases`, `registry_unavailable_rejects_and_releases` · "fix(vault): balance-aware pay callbacks, tolerant summary parse, gas floors" |
| A payment the vault couldn't afford panicked in the callback and stranded the reservation. `pay` and `on_registry_summary` now reject with "insufficient balance". | `pay_insufficient_balance_rejected` · same commit |
| No minimum prepaid gas: a low-gas `pay` / `report` could leave a callback out of gas. Now 40 / 35 TGas floors. `report` also rejects while paused. | `pay_below_min_gas_fails_without_reserving`, `report_rejected_while_paused` · same commit |
| Owner methods that loosen controls or move funds didn't require 1 yoctoNEAR, so a function-call key on the owner account could call them. | `sensitive_owner_methods_require_one_yocto` · "fix(vault): 1-yocto owner gate, storage-aware withdraw, stricter tests" |
| `withdraw` could try to send the storage stake and fail with `LackBalanceForState`. Now limited to the balance above the stake. | `withdraw_keeps_storage_stake` · same commit |
| NEP-297 events used a generic standard name. Now `standard: "countersign"`, `version: "1.0.0"`. Report storage was slimmed (reporter not stored twice) so the worst-case first report fits the 0.01 NEAR forward. | `report_storage_is_measured_and_fully_released_on_withdraw`, `worst_case_first_report_fits_min_deposit` · "fix(registry): countersign event standard, slimmer report storage, test wrapper" |

## Off-chain safety properties (SDK, CLI, MCP)

These are enforced in TypeScript and covered by `pnpm test` and `pnpm attacks`:

- Mainnet is read-only: `safeTransfer`, `report`, every vault signing method and `setup` refuse on mainnet before building or signing. Besides the configured network, they check the RPC node's `chain_id` once before the first signature: `mainnet` is always refused, and a mismatch (a `testnet` config on a non-`testnet` node, or a `sandbox` config on a `testnet` node) throws `NetworkMismatchError`.
- `countersign check --network <n>` with an env file for another network drops that file's RPC URL, registry, vault and keys, so the named network's defaults apply.
- Keys never appear in errors or receipts (`redactSecrets` / `redactError`).
- The MCP server refuses to start when `COUNTERSIGN_OWNER_KEY` is in its environment, and exposes only 3 tools (no owner actions).
- `setup` deletes the vault's full-access key in the same batch that deploys the code, initializes it and adds the agent key, then verifies that exactly one function-call key is left.

See `docs/limits.md` for what Countersign does not protect against.

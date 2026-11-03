# Countersign v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a counterparty firewall for AI agents that pay on NEAR. It has a TS scorer and SDK, a Rust vault reached only through a function-call key, a shared Rust report registry, an MCP server, a CLI, and a 7-scenario attack suite that runs in a local sandbox.

**Architecture:** `packages/core` scores a receiver from pluggable data sources (NearBlocks/RPC/registry, or fixtures in the sandbox) against `policy.json`. `packages/sdk` turns the verdict into a vault call, signed with the agent's function-call key. `contracts/vault` enforces caps, pause, trusted payees and the registry check onchain, and keeps a pending queue that only the owner can approve. `contracts/registry` stores open reports with storage deposits. The CLI, MCP server and attack runner are thin layers over the SDK.

**Tech Stack:** Rust + near-sdk 5.x + cargo-near (contracts, from `cargo near new`), near-sandbox + near-api crates (Rust integration tests). Node ≥22, TypeScript, pnpm workspaces, near-api-js 7.x, near-sandbox (npm) 0.3.x, @modelcontextprotocol/sdk 1.x, zod 4, commander, vitest.

**Tracking:** GitHub epic #1. **Task N is issue #(N+2)** (Task 0 = #2 … Task 13 = #15), with blockers set as GitHub dependencies. The issues are the to-do list; this file is the source of each task's content.

**Spec:** `docs/superpowers/specs/2026-11-03-countersign-design.md`. Read it before starting. Section numbers below (§) refer to it.

## Global Constraints

- Mainnet is **read-only**. The SDK throws `MainnetSigningDisabledError` before signing anything when `network === "mainnet"`.
- No secrets in git. Keys come from `.env` (gitignored); only `.env.example` is committed. Never print private keys.
- Dates and times in UTC. NEAR timestamps are nanoseconds (`u64` in Rust; the `string` in NearBlocks JSON is parsed to `bigint` in TS).
- Amounts: yoctoNEAR as `U128`/`NearToken` (string in JSON) on chain and `bigint` in TS. Human input in the CLI/MCP is decimal NEAR (e.g. `"0.1"`), converted with `nearToYocto`.
- Vault defaults (§5.1): `per_tx` = 1 NEAR, `daily` = 5 NEAR, `unknown_payee_max` = 0.1 NEAR, `registry_pending_threshold` = 2, pending queue max = 50, max agent reports per day = 5, report deposit = 0.01 NEAR.
- Agent function-call key: receiver = the vault account, methods = `["pay", "request_approval", "report"]`, allowance = 0.25 NEAR.
- Registry: no owner or admin method. `note` ≤ 280 bytes, `category ∈ {scam, phishing, drainer, impersonation, other}`, minimum deposit 0.01 NEAR.
- Verdict thresholds: score < 30 is `allow`, 30–69 is `warn`, ≥ 70 is `block`. Each `unknown` signal adds +10. Score = min(100, Σ points).
- Events are NEP-297 with `standard: "countersign"`, `version: "1.0.0"`.
- Networks: `sandbox` | `testnet` | `mainnet`. Testnet RPC is `https://test.rpc.fastnear.com`, mainnet RPC is `https://free.rpc.fastnear.com`. NearBlocks is `https://api-testnet.nearblocks.io/v1` and `https://api.nearblocks.io/v1`.
- Contract callbacks are `#[private]` and **never panic**. Use `require!` and not `assert!`. Use saturating or checked arithmetic.
- Workspace packages are named `@countersign/<name>` and are `"private": true`. Publishing to npm is out of scope for v1.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Each task's commands run from the repo root unless the task says otherwise.
- near-mcp (dev tooling in `.mcp.json`) defaults every tool's `networkId` to **mainnet**. Always pass `networkId: "testnet"` explicitly, and treat its write tools (send, create account, add/delete key, delete/export account, swap) as needing the human's OK.

## Review Focus

1. **The receiver doesn't exist** (a typo, or an implicit account with no balance). Expect the SDK to return `block` with the reason "account does not exist", and if the vault is called directly, a failed transfer releases the daily reservation and emits `payment_failed`. Tests: Task 3 `pay_to_missing_account_releases_reservation` and Task 6 `missing account blocks`.
2. **Short trusted names cause false look-alike matches** (`bob` vs `rob`). Expect the distance check to apply only when the trusted label has ≥5 characters (an exact homoglyph-normalized match still counts at any length). Test: Task 5 `short labels do not fuzzy-match`.
3. **Bad amount input from an LLM** (`"0"`, `"-1"`, `"abc"`, `"0.1234567890123456789012345"` with more than 24 decimal places, `"1e3"`). Expect a validation error before any check or signing. Tests: Task 7 `parseNearAmount rejects…` and Task 9 `safe_transfer rejects bad amount`.
4. **Daily cap at the UTC day boundary.** A reservation made before midnight and released after it must not underflow or credit the new day. Expect the release to apply only if the day is unchanged, and to use saturating arithmetic. Test: Task 3 `release_after_day_rollover_is_noop`.
5. **NearBlocks rate-limited (HTTP 429) or down for the whole check.** Expect every affected signal (`age`, `activity`, `code_change`, `registry`) to be `unknown`, giving at least 40 points (`warn`) and never `allow`. `lookalike` and `first_contact` use local data and can't fail. Test: Task 6 `all sources failing yields warn`.

---

### Task 0: Toolchain, monorepo scaffold and sandbox smoke test

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.env.example`, `.nvmrc` (`22`)
- Create: `contracts/` via `cargo near new` (twice, see Step 2), plus `contracts/Cargo.toml` as a Cargo workspace
- Create: `scripts/smoke-sandbox.ts`
- Modify: `.gitignore` (add `!contracts/res/*.wasm`)

**Interfaces:**
- Produces: root scripts `pnpm build:contracts` (runs `cargo near build non-reproducible-wasm` in each contract and copies the wasm to `contracts/res/{registry,vault}.wasm`), `pnpm test` (vitest across packages), `pnpm test:contracts` (`cargo test` in `contracts/`), `pnpm attacks`, `pnpm typecheck`.

- [ ] **Step 1: Install the toolchain (ask the human first: these run remote install scripts)**

Run: `mise use -g rust@stable` (or rustup), then `rustup target add wasm32-unknown-unknown`, the cargo-near installer, the near-cli-rs installer (commands in `.claude/skills/near-smart-contracts/SKILL.md`), and `corepack enable pnpm`.
Expected: `cargo near --version`, `near --version` and `pnpm --version` all print versions.

- [ ] **Step 2: Generate the contracts with the official template**

Run: `cd contracts && cargo near new registry && cargo near new vault`. Then delete any nested `.git` the template creates, and create a `contracts/Cargo.toml` workspace with `members = ["registry", "vault"]`, moving each crate's `[profile.release]` into the workspace.
Expected: `cargo test` in `contracts/` passes the template tests.

- [ ] **Step 3: Scaffold the pnpm workspace**

`pnpm-workspace.yaml` lists `packages/*` and `attacks`. The root `package.json` has the scripts from Interfaces, `"type": "module"`, and `"engines": {"node": ">=22"}`. Packages use TS project references with `tsconfig.base.json` (`strict`, `module: "NodeNext"`, `target: "ES2023"`). Run with `tsx` and don't build JS for v1.

- [ ] **Step 4: Write the sandbox smoke script `scripts/smoke-sandbox.ts`**

It starts `Sandbox.start({})` from `near-sandbox`, connects a near-api-js `JsonRpcProvider` to `sandbox.rpcUrl`, creates `alice.<root>` with 10 NEAR using the root account key (find the root account ID and key in the near-sandbox package's exports or examples, and record them in a comment), prints Alice's balance, and calls `tearDown()`.
Run: `pnpm tsx scripts/smoke-sandbox.ts`
Expected: prints `alice.<root> 10 NEAR` and exits 0.

- [ ] **Step 5: Write `.env.example`** with `COUNTERSIGN_NETWORK`, `COUNTERSIGN_REGISTRY_ID`, `COUNTERSIGN_VAULT_ID`, `COUNTERSIGN_AGENT_KEY`, `COUNTERSIGN_OWNER_ID`, `COUNTERSIGN_OWNER_KEY` and `NEARBLOCKS_API_KEY` (optional). Values are empty, with a comment on each.

- [ ] **Step 6: Commit** with the message `chore: scaffold monorepo, contracts and sandbox smoke test`.

---

### Task 1: Registry contract

**Files:**
- Modify: `contracts/registry/src/lib.rs`
- Create: `contracts/registry/src/types.rs`, `contracts/registry/src/events.rs`
- Test: `contracts/registry/tests/registry.rs`

**Interfaces:**
- Produces (JSON method names and shapes, used by Tasks 3 and 6):
  - `report(target: AccountId, category: Category, tx_hash: Option<String>, note: String)`, `#[payable]`
  - `withdraw_report(target: AccountId)`
  - `rebut(note: String)`, `#[payable]`
  - `get_summary(target: AccountId) -> Summary { reports: u32, first_seen: Option<U64>, last_seen: Option<U64>, rebutted: bool }`
  - `get_reports(target: AccountId, from_index: u32, limit: u32) -> Vec<Report>`
  - `get_rebuttal(target: AccountId) -> Option<Rebuttal>`
  - `Category` serializes as `"scam" | "phishing" | "drainer" | "impersonation" | "other"`
  - `Report { reporter: AccountId, category: Category, tx_hash: Option<String>, note: String, created_at: U64 }`, `Rebuttal { note: String, created_at: U64 }`
  - Events: `report_added {target, reporter, category}`, `report_withdrawn {target, reporter}`, `rebuttal_added {target}`

- [ ] **Step 1: Write the failing integration tests in `tests/registry.rs`** (sandbox + near-api, following `.claude/skills/near-smart-contracts/rules/testing-integration-tests.md`):
  - `report_requires_min_deposit`: deposit 0.009 NEAR fails; 0.01 NEAR succeeds.
  - `report_refunds_excess`: deposit 1 NEAR; the reporter's balance drops by < 0.02 NEAR (gas + storage).
  - `one_report_per_reporter_per_target`: a second `report` from the same reporter for the same target fails.
  - `cannot_report_self`: `report(target = predecessor)` fails.
  - `note_too_long_rejected`: a 281-byte note fails.
  - `summary_counts_and_timestamps`: after 3 reporters, `get_summary` gives `{reports: 3, rebutted: false}`, with `first_seen ≤ last_seen`.
  - `withdraw_refunds_and_decrements`: after `withdraw_report`, `reports` is 2 and the storage refund arrives.
  - `rebut_only_by_target`: `rebut` sets the summary's `rebutted: true` for the predecessor's own account only, and a second `rebut` replaces the first.
  - `get_reports_paginates`: `from_index: 1, limit: 1` returns the second report.
  - `no_admin_methods`: the contract ABI or method list contains no `owner`, `set_*`, `delete_*` or `migrate` methods (assert against the wasm's exported functions, the same list near-mcp's `contract_view_functions` shows. `__contract_abi` and `contract_source_metadata` may appear when cargo-near embeds the ABI and NEP-330 metadata; they're allowed).

- [ ] **Step 2: Run the tests to see them fail.** `cd contracts && cargo test -p registry` → FAIL (methods not found).

- [ ] **Step 3: Implement the registry in `lib.rs`.** State is `reports: LookupMap<AccountId, IterableMap<AccountId, Report>>` keyed by target then reporter (use nested-collection storage keys derived from the target), `summaries: LookupMap<AccountId, Summary>` and `rebuttals: LookupMap<AccountId, Rebuttal>`. Measure storage before and after, charge `bytes × storage_byte_cost`, require deposit ≥ max(0.01 NEAR, cost), and refund the excess (see the `security-storage-checks` rule). `withdraw_report` refunds the storage that was released.

- [ ] **Step 4: Run the tests.** `cargo test -p registry` → PASS.

- [ ] **Step 5: Commit** with `feat(registry): open report registry with deposits and rebuttals`.

---

### Task 2: Vault contract (state, owner methods, request_approval, approve/deny)

**Files:**
- Modify: `contracts/vault/src/lib.rs`
- Create: `contracts/vault/src/types.rs`, `contracts/vault/src/events.rs`, `contracts/vault/src/limits.rs`
- Test: unit tests in `contracts/vault/src/limits.rs`, plus `contracts/vault/tests/owner.rs`

**Interfaces:**
- Produces (used by Tasks 3, 7 and 8):
  - `new(owner_id: AccountId, registry_id: AccountId, limits: Option<Limits>)`
  - `Limits { per_tx: NearToken, daily: NearToken, unknown_payee_max: NearToken, registry_pending_threshold: u32 }`
  - `PayOutcome`, serde-tagged `#[serde(tag = "status", rename_all = "snake_case")]`: `Paid { receiver, amount }`, `Pending { id: U64, reason: String }`, `Rejected { reason: String }`, `Failed { reason: String }`
  - `PendingPayment { id: U64, receiver, amount: NearToken, memo: String, reason: String, created_at: U64 }`
  - `request_approval(receiver: AccountId, amount: NearToken, memo: String, reason: String) -> PayOutcome`
  - `approve(id: U64) -> PromiseOrValue<PayOutcome>` and `deny(id: U64)`
  - `pause()`, `unpause()`, `set_limits(limits: Limits)`, `trust(account_id)`, `untrust(account_id)`, `withdraw(amount: NearToken)`
  - Views: `get_limits() -> Limits`, `get_pending() -> Vec<PendingPayment>`, `get_spent_today() -> NearToken`, `is_trusted(account_id) -> bool`, `is_paused() -> bool`
  - Internal helpers in `limits.rs` (pure, unit-tested): `day_of(ns: u64) -> u64` (= ns / 86_400_000_000_000), `fn reserve(spent: &mut Spent, now_ns: u64, amount: u128, daily: u128) -> Result<(), &'static str>`, and `fn release(spent: &mut Spent, reserved_day: u64, amount: u128)`
  - Message strings (exact, asserted in tests): `"paused"`, `"over per-tx cap"`, `"over daily cap"`, `"pending queue full"`, `"unknown payee"`, `"registry_flagged"`, `"registry unavailable"`, `"transfer failed"`

- [ ] **Step 1: Write the failing unit tests in `limits.rs`:**
  - `reserve_within_daily_ok`: daily 5 NEAR, reserve 2 then 3 → Ok, spent = 5.
  - `reserve_over_daily_err`: spent 5, reserve 1 yocto → `Err("over daily cap")`.
  - `reserve_resets_on_new_day`: spent 5 on day d; reserve 1 NEAR on day d+1 → Ok, spent = 1.
  - `release_same_day_subtracts`, and `release_after_day_rollover_is_noop`: reserve on day d, release on day d+1 → spent for the new day is unchanged. Use saturating arithmetic, and spent never goes below 0.

- [ ] **Step 2: Write the failing integration tests in `tests/owner.rs`:**
  - `init_sets_defaults`: `get_limits` equals the Global Constraints defaults.
  - `owner_methods_reject_non_owner`: `pause`, `set_limits`, `trust`, `withdraw`, `approve` and `deny` called by a stranger all fail.
  - `request_approval_requires_self_predecessor`: called from another account → fails; called from the vault account itself → `Pending`.
  - `request_approval_respects_per_tx_and_pause`: 1.5 NEAR → `Rejected("over per-tx cap")`; when paused → `Rejected("paused")`.
  - `pending_queue_caps_at_50`: the 51st `request_approval` → `Rejected("pending queue full")`.
  - `approve_pays_and_counts_daily`: approve 1 NEAR → receiver +1 NEAR, `get_spent_today` = 1 NEAR, pending is empty, and the events `payment_approved` + `payment_paid` are logged.
  - `approve_rechecks_daily_cap`: spent 4.5, approve 1 NEAR → `Rejected("over daily cap")` and the payment stays pending.
  - `approve_when_paused_rejected`.
  - `deny_removes`: emits `payment_denied`.
  - `withdraw_sends_to_owner`.

- [ ] **Step 3: Run the tests to see them fail.** `cargo test -p vault` → FAIL.

- [ ] **Step 4: Implement the state and the methods above.** Self-calls check `env::predecessor_account_id() == env::current_account_id()` and owner calls check `predecessor == owner_id`. `approve` reserves the daily amount, transfers, and chains `.then(on_transfer_done(...))` from Task 3. Until Task 3 exists, `approve` can return `Paid` after a plain transfer, and Task 3 switches it to the shared transfer path.

- [ ] **Step 5: Run the tests.** `cargo test -p vault` → PASS.

- [ ] **Step 6: Commit** with `feat(vault): limits, owner controls and approval queue`.

---

### Task 3: Vault `pay()` with the registry check, transfer callbacks and `report()`

**Files:**
- Modify: `contracts/vault/src/lib.rs`
- Create: `contracts/vault/src/pay.rs`, `contracts/vault/src/ext.rs` (`#[ext_contract(ext_registry)]` with `get_summary` and `report`)
- Test: `contracts/vault/tests/pay.rs` (deploys `contracts/res/registry.wasm` and `vault.wasm`; run `pnpm build:contracts` first)

**Interfaces:**
- Consumes: the registry `get_summary` and `report` from Task 1; `PayOutcome`, `reserve` and `release` from Task 2.
- Produces:
  - `pay(receiver: AccountId, amount: NearToken, memo: String) -> PromiseOrValue<PayOutcome>`
  - `report(target: AccountId, category: String, tx_hash: Option<String>, note: String) -> Promise`, which forwards with 0.01 NEAR attached. At most 5 per UTC day, and the deposit is reserved against `daily` (released if the report fails)
  - Private callbacks: `on_registry_summary(receiver, amount, memo, reserved_day: u64, #[callback_result] r: Result<Summary, PromiseError>) -> PromiseOrValue<PayOutcome>`, `on_transfer_done(receiver, amount, reserved_day: u64, #[callback_result] r: Result<(), PromiseError>) -> PayOutcome`, `on_report_done(...)`
  - Events: `payment_paid`, `payment_pending`, `payment_rejected`, `payment_failed`, `report_forwarded`

- [ ] **Step 1: Write the failing integration tests in `tests/pay.rs`** (the vault is signed by a function-call key on the vault account, exactly as in production):
  - `pay_trusted_small_paid`: trusted receiver, 0.5 NEAR → `Paid`, receiver +0.5 NEAR, spent = 0.5.
  - `pay_unknown_under_limit_paid`: unknown receiver, 0.1 NEAR → `Paid`.
  - `pay_unknown_over_limit_pending`: unknown receiver, 0.2 NEAR → `Pending { reason: "unknown payee" }`, spent goes back to 0.
  - `pay_registry_flagged_pending`: 2 reports on the receiver → `Pending { reason: "registry_flagged" }`, even if the receiver is trusted.
  - `self_rebuttal_does_not_bypass`: receiver reported twice then rebuts → still `Pending("registry_flagged")`.
  - `pay_over_per_tx_rejected` and `pay_paused_rejected`.
  - `drip_drain_stops_at_daily`: 60 × 0.1 NEAR to an unknown receiver → exactly 50 `Paid`, then `Rejected("over daily cap")`.
  - `registry_unavailable_rejects_and_releases`: vault initialized with `registry_id` = an account with no contract → `Rejected("registry unavailable")`, spent = 0.
  - `pay_to_missing_account_releases_reservation`: receiver `nobody-xyz.<root>` doesn't exist → `Failed("transfer failed")`, spent = 0, vault balance unchanged apart from gas, and `payment_failed` is logged.
  - `fc_key_cannot_transfer_or_call_owner_methods`: with the agent key, a direct `Transfer` action, a call to `approve`, and a call to `withdraw` each fail at the protocol level (assert the error kind for "method not allowed", or a deposit not allowed for a function-call key).
  - `report_forwards_and_caps_at_5`: 5 `report` calls succeed and land in the registry with reporter = the vault; the 6th fails; `spent_today` includes 5 × 0.01 NEAR minus refunds.

- [ ] **Step 2: Run the tests to see them fail.** `pnpm build:contracts && cd contracts && cargo test -p vault --test pay` → FAIL.

- [ ] **Step 3: Implement `pay` in `pay.rs`** following the §5.1.1 order exactly. Reserve first, then call `ext_registry::ext(registry_id).with_static_gas(5 TGas).get_summary(receiver)`, then `.then(Self::ext(current).with_static_gas(30 TGas).on_registry_summary(...))`. In the callback, release on every non-paid branch. On the paid branch, return `Promise::new(receiver).transfer(amount).then(on_transfer_done)`, and `on_transfer_done` releases the reservation and returns `Failed` on error. Point `approve` (Task 2) at the same transfer + `on_transfer_done` path. Follow the `xcc-promise-chaining` rule: callbacks never panic.

- [ ] **Step 4: Run the tests.** `cargo test -p vault` → PASS (all of Task 2 and Task 3).

- [ ] **Step 5: Commit** with `feat(vault): pay() with registry check, transfer callbacks and report forwarding`.

---

### Task 4: Core types, policy and scorer

**Files:**
- Create: `packages/core/package.json`, `packages/core/src/types.ts`, `packages/core/src/policy.ts`, `packages/core/src/scorer.ts`, `packages/core/src/index.ts`, `policy.json` (repo root)
- Test: `packages/core/test/scorer.test.ts`, `packages/core/test/policy.test.ts`

**Interfaces:**
- Produces (used by Tasks 5–10):
```ts
export type Network = "sandbox" | "testnet" | "mainnet";
export type SignalId = "exists" | "lookalike" | "registry" | "age" | "activity" | "code_change" | "first_contact";
export interface Signal { id: SignalId; status: "ok" | "unknown"; points: number; reason: string; data?: unknown }
export type Decision = "allow" | "warn" | "block";
export interface Verdict { target: string; score: number; decision: Decision; signals: Signal[]; reasons: string[] }
export interface CheckContext { network: Network; vaultId: string; trusted: string[]; pastPayees: string[]; now: Date }
export interface Policy { /* the shape of policy.json, validated with zod */ }
export function loadPolicy(path?: string): Policy;          // defaults to <repo>/policy.json
export function scoreSignals(target: string, signals: Signal[], policy: Policy): Verdict;
```
- `policy.json` (exact values from spec §6.1):
```json
{
  "thresholds": { "warn": 30, "block": 70 },
  "unknownPoints": 10,
  "exists": { "missingDecision": "block" },
  "lookalike": { "maxDistance": 2, "minLabelLength": 5, "points": 45 },
  "registry": { "perReport": 25, "cap": 75, "rebuttalFactor": 0.5, "credibilityAgeDays": 30, "credibilityMinTx": 10, "lowActivityFactor": 0.5 },
  "age": { "under1dPoints": 30, "under7dPoints": 15 },
  "activity": { "minTx": 5, "points": 10 },
  "codeChange": { "withinDays": 7, "points": 25 },
  "firstContact": { "points": 5 },
  "trustedSkips": ["lookalike", "first_contact", "age"]
}
```

- [ ] **Step 1: Write the failing tests:**
  - `policy.test.ts`: `loadPolicy()` parses the repo `policy.json`; a policy with `thresholds.warn ≥ thresholds.block` throws; missing keys throw a zod error that names the key.
  - `scorer.test.ts`:
    - 29 points → `allow`; 30 → `warn`; 69 → `warn`; 70 → `block`; 140 → score 100, `block`.
    - An `unknown` signal adds `unknownPoints` whatever its `points` value.
    - Four network signals unknown (`age`, `activity`, `code_change`, `registry`) → score 40, `warn`. An `exists` signal with status `unknown` adds **0**, because its data source is already counted by `age` and `activity`.
    - An `exists` signal with `data: { exists: false }` → `block` and score 100, whatever else is present, with reason "account does not exist".
    - `reasons` contains only the signals with points > 0, in the order received.

- [ ] **Step 2: Run the tests to see them fail.** `pnpm vitest run packages/core` → FAIL.

- [ ] **Step 3: Implement `types.ts`, `policy.ts` (a zod schema plus a `warn < block` refinement) and `scorer.ts`.** The scorer is pure: it doesn't fetch anything.

- [ ] **Step 4: Run the tests.** → PASS.

- [ ] **Step 5: Commit** with `feat(core): types, policy.json and scorer`.

---

### Task 5: Look-alike signal

**Files:**
- Create: `packages/core/src/signals/lookalike.ts`, `packages/core/test/fixtures/lookalike-corpus.json`
- Test: `packages/core/test/lookalike.test.ts`

**Interfaces:**
- Consumes: `Signal`, `CheckContext`, `Policy` (Task 4).
- Produces: `export function normalizeLabel(label: string): string` and `export function lookalikeSignal(target: string, ctx: CheckContext, policy: Policy): Signal` (synchronous, never `unknown`).
- The label is the first `.` segment of the account ID. Homoglyph map (applied after lowercasing, multi-character sequences first): `rn→m`, `vv→w`, `0→o`, `1→l`, `3→e`, `5→s`. Distance is Damerau-Levenshtein (optimal string alignment), and you implement it yourself (about 20 lines) without adding a dependency.

- [ ] **Step 1: Write the failing tests:**
  - `acme-c0rp.testnet` vs trusted `acme-corp.testnet` → 45 points, reason mentions `acme-corp.testnet`.
  - `acme-corp.evil.testnet` vs `acme-corp.testnet` (same label, different parent) → 45.
  - `acrne-corp.testnet` (`rn` for `m`) → 45.
  - `acme-crop.testnet` (a transposition) → 45.
  - The target itself trusted → 0.
  - `short labels do not fuzzy-match`: trusted `bob.testnet`, target `rob.testnet` → 0, but target `b0b.testnet` → 45 (normalized exact match).
  - Unrelated `zebra-foods.testnet` → 0.
  - Matches against `pastPayees` as well as `trusted`.
  - The corpus file has ≥15 positive and ≥15 negative pairs, and all of them pass.

- [ ] **Step 2: Run the tests to see them fail.** → FAIL.
- [ ] **Step 3: Implement.** → **Step 4: Run the tests** → PASS.
- [ ] **Step 5: Commit** with `feat(core): look-alike account detection`.

---

### Task 6: Data sources and the remaining signals, plus `check()`

**Files:**
- Create: `packages/core/src/sources/types.ts`, `packages/core/src/sources/nearblocks.ts`, `packages/core/src/sources/rpc.ts`, `packages/core/src/sources/registry.ts`, `packages/core/src/sources/fixture.ts`, `packages/core/src/sources/cache.ts`, `packages/core/src/signals/{exists,registry,age,activity,codeChange,firstContact}.ts`, `packages/core/src/check.ts`, `packages/core/src/config.ts`
- Create: `fixtures/sandbox.json` (account data used by the attack suite), `packages/core/test/fixtures/nearblocks/*.json` (real recorded responses)
- Test: `packages/core/test/signals.test.ts`, `packages/core/test/check.test.ts`, `packages/core/test/nearblocks.test.ts`, `packages/core/test/rpc.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5; the registry views from Task 1.
- Produces:
```ts
export class SourceUnavailableError extends Error {}
export interface AccountInfo { exists: boolean; createdAt: Date | null; txCount: number }
export interface CodeInfo { isContract: boolean; lastDeployAt: Date | null }
export interface RegistryReport { reporter: string; category: string; txHash: string | null; note: string; createdAt: Date }
export interface DataSource {
  getAccountInfo(id: string): Promise<AccountInfo>;          // throws SourceUnavailableError
  getCodeInfo(id: string): Promise<CodeInfo>;
  getReports(target: string): Promise<RegistryReport[]>;
  getRebutted(target: string): Promise<boolean>;
}
export function createDataSource(cfg: Config): DataSource;  // sandbox → FixtureSource(accounts) + live registry reads; testnet/mainnet → NearBlocks + RPC + registry
export async function check(target: string, ctx: CheckContext, ds: DataSource, policy: Policy): Promise<Verdict>;
export interface Config { network: Network; rpcUrl: string; nearblocksUrl: string | null; registryId: string; vaultId?: string; agentKey?: string; ownerId?: string; ownerKey?: string }
export function loadConfig(env?: NodeJS.ProcessEnv): Config;  // reads the COUNTERSIGN_* variables from .env.example
```
- NearBlocks endpoints (verified 2026-11-03): `GET /account/{id}` → `account[0].created.block_timestamp` (ns string or null; null = genesis); `GET /account/{id}/txns/count` → `txns[0].count`; `GET /account/{id}/contract/deployments` → take the **max** `block_timestamp` (the list isn't ordered). RPC `view_account.code_hash` equal to `11111111111111111111111111111111` means not a contract.
- **`exists` comes from RPC, not NearBlocks** (checked with near-mcp on 2026-11-03): `view_account` failing with `UNKNOWN_ACCOUNT` means the account doesn't exist. NearBlocks is an indexer and can lag behind the chain, so a just-created account (A2) could look missing there. RPC has no creation time or transaction count, so NearBlocks still supplies `createdAt` and `txCount`. If RPC finds the account but NearBlocks returns an empty `account` array, the account exists and `age`/`activity` are `unknown`.
- Cache: a JSON file per URL under `~/.cache/countersign`, TTL 10 minutes. Retry: 3 attempts with backoff 250/500/1000 ms on 429/5xx/network errors, then throw `SourceUnavailableError`. Send the `Authorization: Bearer` header only when `NEARBLOCKS_API_KEY` is set.

- [ ] **Step 1: Record real fixtures.** Use curl to save the three NearBlocks responses for `intents.near` and for a recent mainnet account into `packages/core/test/fixtures/nearblocks/`. Also save an RPC `view_account` response for an existing account and the `UNKNOWN_ACCOUNT` error for a missing one into `packages/core/test/fixtures/rpc/`.

- [ ] **Step 2: Write the failing tests:**
  - `nearblocks.test.ts` (a `fetch` stub that serves the fixtures): parses `createdAt`, `txCount` and `lastDeployAt` (the max); retries twice on 429 and then succeeds; 4 × 429 → `SourceUnavailableError`; a second call within the TTL makes no fetch; an empty account array → `SourceUnavailableError` (indexer lag, not "missing").
  - `rpc.test.ts` (a `fetch` stub that serves the RPC fixtures): `UNKNOWN_ACCOUNT` → `exists: false`; `code_hash` `111…1` → `isContract: false`; an account RPC finds but NearBlocks returns an empty array for → `exists: true`, with `age` and `activity` `unknown`.
  - `signals.test.ts` (each signal on an in-memory `DataSource`):
    - `age`: created 2 hours ago → 30; 3 days ago → 15; 30 days ago → 0; `createdAt: null` → 0.
    - `activity`: 4 transactions → 10; 5 → 0.
    - `code_change`: a contract deployed 2 days ago → 25; deployed 30 days ago → 0; not a contract → 0.
    - `registry`: 3 reports from reporters aged ≥30 days with ≥10 transactions → 75; one reporter 15 days old with 3 transactions → 25 × 0.5 × 0.5 = 6.25 → rounded to 6 (round each signal's total to an integer); rebutted ×0.5; 4 credible reports → capped at 75; a reporter whose info fails → that report weighs 0 and the signal stays `ok`, with the reason naming the reporter that couldn't be checked.
    - `first_contact`: a target in `pastPayees` → 0, otherwise 5.
    - `exists`: `exists: false` → `data.exists === false`.
  - `check.test.ts`:
    - `missing account blocks`.
    - A trusted target skips `lookalike`, `first_contact` and `age` (they're absent from `signals`) but keeps `registry`.
    - `all sources failing yields warn`: every `DataSource` method throws → `decision: "warn"`, score between 40 and 69.
    - Scenario values: a fresh lookalike → `block`; a fresh unknown account → `warn` (30+10+5 = 45); a credible account with 3 reports → `block` (75+5); a trusted active payee → `allow`.

- [ ] **Step 3: Run the tests to see them fail.** → FAIL.
- [ ] **Step 4: Implement** the sources (fetch is injectable for tests), the signals and `check()`. `check` runs the signal fetches in parallel with `Promise.allSettled`, and any rejected fetch becomes an `unknown` signal.
- [ ] **Step 5: Run the tests.** → PASS. Then do a manual check: `pnpm tsx -e "…check('intents.near', …mainnet…)"` prints a verdict.
- [ ] **Step 6: Commit** with `feat(core): data sources, signals and check()`.

---

### Task 7: SDK (`guardedAgent`)

**Files:**
- Create: `packages/sdk/package.json`, `packages/sdk/src/agent.ts`, `packages/sdk/src/vaultClient.ts`, `packages/sdk/src/amount.ts`, `packages/sdk/src/receipts.ts`, `packages/sdk/src/errors.ts`, `packages/sdk/src/index.ts`
- Create: `packages/sdk/test/helpers/sandbox.ts` (starts the sandbox, deploys `contracts/res/*.wasm`, creates owner/vault/payee accounts, adds the agent function-call key; Task 10 reuses it)
- Test: `packages/sdk/test/amount.test.ts`, `packages/sdk/test/agent.sandbox.test.ts`

**Interfaces:**
- Consumes: `check`, `loadConfig`, `createDataSource`, `loadPolicy` (Tasks 4–6); the vault methods (Tasks 2–3).
- Produces:
```ts
export function parseNearAmount(input: string): bigint;      // decimal NEAR → yocto; throws InvalidAmountError
export type Outcome =
  | { status: "refused"; verdict: Verdict }
  | { status: "pending"; id: string; reason: string; verdict: Verdict }
  | { status: "paid"; txHash: string; verdict: Verdict }
  | { status: "rejected"; reason: string; verdict: Verdict }
  | { status: "failed"; reason: string; verdict: Verdict };
export interface GuardedAgent {
  check(to: string): Promise<Verdict>;
  safeTransfer(to: string, amountNear: string, memo?: string): Promise<Outcome>;
  report(target: string, category: string, note: string, txHash?: string): Promise<{ txHash: string }>;
}
export function guardedAgent(opts: { config: Config; policy?: Policy; receiptsPath?: string; dataSource?: DataSource }): Promise<GuardedAgent>;
export class VaultClient { constructor(cfg: Config); pay(...); requestApproval(...); report(...); approve(id); deny(id); pause(); unpause(); getPending(); getLimits(); getSpentToday(); isTrusted(id); getTrusted(): Promise<string[]>; keyAllowance(): Promise<bigint | null> /* null = unlimited (RPC `allowance: null`) */ }
export class MainnetSigningDisabledError extends Error {}
export class InvalidAmountError extends Error {}
```
- `CheckContext.trusted` comes from the vault (add a `get_trusted() -> Vec<AccountId>` view to the vault in this task, with a test, if it's missing). `pastPayees` comes from the `paid` entries in `receipts.jsonl`. Each receipt line is `{ ts, to, amountYocto, verdict: {score, decision, reasons}, outcome: {status, id?, reason?, txHash?} }`.
- The agent signs with `COUNTERSIGN_AGENT_KEY` and `signerId` = the vault ID. Owner methods sign with `COUNTERSIGN_OWNER_KEY` as `COUNTERSIGN_OWNER_ID`.

- [ ] **Step 1: Write the failing tests:**
  - `amount.test.ts`: `"0.1"` → 10²³; `"1"` → 10²⁴; `parseNearAmount rejects` `"0"`, `"-1"`, `"abc"`, `"1e3"`, `""`, and more than 24 decimal places.
  - `agent.sandbox.test.ts` (a 60 s sandbox timeout in `beforeAll`):
    - `block` → status `refused`, and the vault's pending list and spent amount are unchanged.
    - `warn` → status `pending`, and `getPending()` contains the ID with the joined reasons.
    - `allow` to a trusted payee → `paid`, a `txHash`, and the receiver's balance goes up.
    - `allow` but the vault says unknown payee over the limit → `pending`.
    - Every call appends exactly one valid JSON line to the receipts file.
    - With `network: "mainnet"`, `safeTransfer` → throws `MainnetSigningDisabledError` and nothing is sent.
- [ ] **Step 2: Run the tests to see them fail.** → FAIL.
- [ ] **Step 3: Implement**, using near-api-js 7 `Account` + `JsonRpcProvider` (`.claude/skills/near-api-js`). Map the `PayOutcome` JSON from the final execution outcome's return value (follow the receipt chain to the last successful value) to `Outcome`.
- [ ] **Step 4: Run the tests.** → PASS.
- [ ] **Step 5: Commit** with `feat(sdk): guardedAgent with vault client and receipts`.

---

### Task 8: CLI

**Files:**
- Create: `packages/cli/package.json` (`bin: { "countersign": "src/main.ts" }`, run through tsx), `packages/cli/src/main.ts`, `packages/cli/src/commands/{check,status,owner,report,setup,sandbox}.ts`, `packages/cli/src/format.ts`
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: the SDK (Task 7) and the sandbox helper from `packages/sdk/test/helpers/sandbox.ts` (move it to `packages/sdk/src/sandbox.ts` and export it as `startDemoSandbox(): Promise<{ config: Config; accounts: DemoAccounts; stop(): Promise<void> }>`).
- Produces the commands (commander):
  - `check <account> [--network <n>] [--json]`, which prints the decision, the score and one line per reason
  - `status`: limits, spent today / daily, the pending table, key allowance remaining, a warning below 20% of 0.25 NEAR (an allowance of `null` prints `unlimited` with no warning)
  - `approve <id>`, `deny <id>`, `pause`, `unpause` (owner key)
  - `report <account> --category <c> --note <text> [--tx <hash>]`
  - `setup --network testnet --owner <id>`: creates `vault.<owner>`, deploys `contracts/res/vault.wasm`, runs `new`, generates the agent key and adds the function-call key (Global Constraints), **deletes the vault's full-access key**, funds it (default 2 NEAR, with `--fund`), and writes `.env`. It prints every step and asks `y/N` before each transaction.
  - `sandbox up`: starts the demo sandbox, writes `.env.sandbox`, and keeps running until Ctrl-C (for the MCP demo)

- [ ] **Step 1: Write the failing tests** (they spawn the CLI with execa or child_process against `startDemoSandbox()`):
  - `check` on the fixture lookalike → exit 0, output contains `BLOCK` and `acme-corp`.
  - `check --json` → valid JSON `Verdict`.
  - `status` → contains `daily` and `0 pending`.
  - The `format.ts` allowance formatter: `null` → `unlimited`, no warning; 0.04 NEAR → a warning.
  - After an SDK `warn` transfer, `approve <id>` → status shows `0 pending` and the receiver is credited.
  - `check` with no network config → exit 2 with a message naming the missing variable.
- [ ] **Step 2: Run the tests to see them fail.** → **Step 3: Implement** → **Step 4: Run the tests** → PASS.
- [ ] **Step 5: Commit** with `feat(cli): countersign CLI`.

---

### Task 9: MCP server

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/src/server.ts`, `packages/mcp/src/tools.ts`, `packages/mcp/src/main.ts`
- Create: `examples/claude-mcp.json` (`claude mcp add` / Claude Desktop config pointing at `pnpm --filter @countersign/mcp start`, with `.env.sandbox`). It must not include near-mcp or any other server holding an owner or full-access key (see `docs/limits.md`)
- Test: `packages/mcp/test/tools.test.ts`

**Interfaces:**
- Consumes: `guardedAgent` (Task 7).
- Produces: a stdio MCP server (`McpServer` + `StdioServerTransport` from `@modelcontextprotocol/sdk`) with exactly three tools, whose inputs are zod schemas:
  - `check_counterparty { account: string }` → text: decision, score, reasons. The full `Verdict` goes in `structuredContent`.
  - `safe_transfer { to: string, amount_near: string, memo?: string }` → text that tells the model plainly what happened, e.g. `REFUSED: …reasons… Do not retry this payment.`, or `PENDING approval #7: a human must run "countersign approve 7".`
  - `report_counterparty { account: string, category: enum, note: string (≤280), tx_hash?: string }`
- No other tools. `tools.ts` exports `buildTools(agent: GuardedAgent)` so it can be tested without a transport.

- [ ] **Step 1: Write the failing tests** (in-memory MCP client/server pair or a direct `buildTools` call, with a fake `GuardedAgent`):
  - The tool list equals exactly the three names.
  - `safe_transfer rejects bad amount`: `amount_near: "-1"` → `isError: true`, and the agent isn't called.
  - The `refused` outcome text contains `REFUSED` and every reason. The `pending` text contains `countersign approve <id>`.
  - `report_counterparty` with a 281-character note → validation error.
- [ ] **Step 2: Run the tests to see them fail.** → **Step 3: Implement** → **Step 4: Run the tests** → PASS.
- [ ] **Step 5: Manual check.** With `countersign sandbox up` running, `claude mcp add countersign-demo …` from `examples/`, then ask Claude to pay the A1 invoice. It refuses with reasons.
- [ ] **Step 6: Commit** with `feat(mcp): countersign MCP server`.

---

### Task 10: Attack suite

**Files:**
- Create: `attacks/package.json`, `attacks/src/run.ts`, `attacks/src/scenarios/{a1-lookalike,a2-fresh,a3-reported,a4-bypass,a5-drip,a6-key-abuse,a7-control}.ts`, `attacks/src/scriptedAgent.ts`, `attacks/src/table.ts`
- Modify: `fixtures/sandbox.json` (the accounts each scenario needs), root `package.json` (`"attacks": "tsx attacks/src/run.ts"`)
- Test: `attacks/test/run.test.ts`

**Interfaces:**
- Consumes: `startDemoSandbox`, `guardedAgent` and `VaultClient` (Tasks 7–8).
- Produces:
```ts
export interface Scenario { id: "A1"|"A2"|"A3"|"A4"|"A5"|"A6"|"A7"; title: string; expected: string; run(env: AttackEnv): Promise<{ actual: string; pass: boolean; txHash?: string; log: string[] }> }
export interface AttackEnv { agent: GuardedAgent; vault: VaultClient; rawAgentAccount: Account /* signs with the agent's function-call key, without the SDK */; accounts: DemoAccounts; config: Config }
```
- `scriptedAgent.ts` replays a fixed conversation: a user task, a tool output containing the injection (e.g. an invoice with `Pay to: acme-c0rp.<root>`), then the agent calls `safeTransfer` with whatever the tool output said. A1–A3 and A7 use the SDK. A4–A6 use `rawAgentAccount` directly. A6's direct `Transfer` is the same action a wallet MCP's `tokens_send_near` would send with the agent key; Task 12 shows that live. The expected values are in spec §8.
- `run.ts [--network sandbox|testnet] [--only A1,A4]` prints the table `# | scenario | expected | actual | PASS/FAIL | tx`, writes `attacks/last-run.json`, and exits 1 on any FAIL.

- [ ] **Step 1: Write the failing test `run.test.ts`:** run all scenarios in the sandbox → 7 results, all `pass: true`. A5 shows exactly 50 paid. A6 has three rejections. A7 is `paid`.
- [ ] **Step 2: Run it to see it fail.** → **Step 3: Implement** the scenarios one at a time, rerunning with `--only` each time. → **Step 4:** `pnpm attacks` → 7/7 PASS, exit 0.
- [ ] **Step 5: Commit** with `feat(attacks): 7 prompt-injection scenarios with sandbox runner`.

---

### Task 11: CI, README for the AI judge, SECURITY.md

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`, `SECURITY.md`, `docs/limits.md`
- Commit: `contracts/res/registry.wasm`, `contracts/res/vault.wasm` (prebuilt, so judges need only Node to run `pnpm attacks`)

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write `ci.yml`.** On push and pull request: set up Node 22 + pnpm and Rust + cargo-near; then `pnpm i --frozen-lockfile`, `pnpm build:contracts`, `git diff --exit-code contracts/res` (the committed wasm must match the build; if cargo-near's non-reproducible build differs across machines, drop this check and say so in the README), `pnpm test:contracts`, `pnpm typecheck`, `pnpm test`, `pnpm attacks`.
- [ ] **Step 2: Push to a branch and confirm CI is green.** (Ask the human before pushing.)
- [ ] **Step 3: Write `README.md` for a machine reader (§11).** In order: one-paragraph problem statement; what it is (the two layers, the registry); **Try it in 2 minutes**: numbered "do X → see Y" steps (`pnpm i` → `pnpm attacks` → see 7 PASS rows; `pnpm countersign check intents.near --network mainnet` → see a verdict; the MCP demo steps); how NEAR is used concretely (function-call key on the vault, onchain caps, cross-contract registry check, NEP-297 events); architecture diagram; the CLI and MCP reference; "Built at NEAR HACKATHON 2026"; dependencies, the AI-generated code disclosure (built with Claude Code) and the template disclosure (`cargo near new`); a link to `docs/limits.md`; how to inspect the deployed contracts with near-mcp (`contract_view_functions`, plus `contract_get_function_args` if the build embeds the ABI; check `__contract_abi` is exported); MIT license. No marketing words.
- [ ] **Step 4: `docs/limits.md`.** What the function-call key can and can't do, and what happens when its allowance runs out. Registry sybil limits on testnet. Fixture data in sandbox mode. NEAR-only payments in v1. Mainnet is read-only. Countersign protects only funds in the vault: the agent's environment must hold only the vault's function-call key. A general wallet MCP such as near-mcp, given an owner or full-access key, exposes `tokens_send_near`, `account_add_access_key`, `account_delete_account` and `account_export_account`, and bypasses Countersign entirely.
- [ ] **Step 5: Audit.** Run the `near-contract-audit` skill over `contracts/registry` and `contracts/vault`. Fix every high and medium finding with a test, and record all findings and their resolutions in `SECURITY.md`.
- [ ] **Step 6: Run** `pnpm test:contracts && pnpm test && pnpm attacks` → all green.
- [ ] **Step 7: Commit** with `docs: README for judges, limits, security audit; ci`.

---

### Task 12: Testnet deployment and live run (the human confirms every transaction)

**Files:**
- Create: `deployments/testnet.json` (`{ registryId, vaultId, ownerId, deployedAt, codeHashes }`, with no keys)
- Modify: `README.md` (the "Live on testnet" section with explorer links)

- [ ] **Step 1: The human creates and funds `countersign.testnet`** (or similar) with the faucet, and gives the account ID. Never create it on their behalf without asking.
- [ ] **Step 2: Deploy the registry** to `registry.<owner>.testnet`, then **delete its full-access key** (§5.2), with confirmation. Verify with near-mcp `account_list_access_keys` (pass `networkId: "testnet"`) that it shows none, and with `contract_view_functions` that it has no admin methods. near-mcp can't deploy contracts, so deploy with near-cli-rs.
- [ ] **Step 3:** `countersign setup --network testnet --owner <owner>` → vault deployed, function-call key added, full-access key deleted. Verify with near-mcp `account_list_access_keys` that the vault has exactly one key: FunctionCall, receiver = the vault, methods = `[pay, request_approval, report]`, allowance 0.25 NEAR. If the key is ever added with near-mcp's `account_add_access_key`, pass `allowance: 0.25` explicitly: it defaults to 1 yoctoNEAR.
- [ ] **Step 4: Create the testnet scenario accounts** (trusted payee, look-alike, fresh account, 3 reporters with some history), then `pnpm attacks --network testnet` → 7/7 PASS on live data. If a live signal value differs from the fixtures (e.g. reporter credibility on young testnet accounts), adjust the scenario setup rather than `policy.json`, and note it in the README.
- [ ] **Step 5: Wallet-MCP bypass check (video moment).** With the human's OK, import only the vault's function-call key into near-mcp on testnet, connect it to Claude next to the Countersign MCP, and ask Claude to send NEAR from the vault with `tokens_send_near`. Expected: the protocol rejects the transfer. Record the error in the README.
- [ ] **Step 6: Commit** `deployments/testnet.json` and the README update with `chore: testnet deployment`.

---

### Task 13: Submission package (the human posts and submits)

- [ ] **Step 1: Re-read** the live https://nearhackathon.com/HACKATHON.md and diff it against `notes/HACKATHON.md`. Flag any rule changes to the human.
- [ ] **Step 2: Secret scan.** `git log -p | grep -E "ed25519:[1-9A-HJ-NP-Za-km-z]{40,}"` → no matches.
- [ ] **Step 3: Draft the X post** (§11) and a 60–90 s video script: the problem line → Claude over MCP gets an injected invoice → REFUSED with reasons → SDK bypass attempt → vault puts it in Pending → `countersign approve` / `deny` → `pnpm attacks` table. The human records and posts it.
- [ ] **Step 4: Build the submission payload** from the human's answers (HACKATHON.md "What the human decides"). Tracks are `["security", "agents", "open"]`. Generate the `requestId` once. **Print the payload and wait for an explicit yes** before the `POST`. Don't commit the payload.

---

## Self-review notes

- **Spec coverage:** §5.1 → Tasks 2–3 · §5.2 → Task 1 · §6 → Tasks 4–6 · §7.1 → Task 7 · §7.2 → Task 9 · §7.3 → Task 8 · §8 → Task 10 · §9 → Tasks 3, 6, 7 · §10 → each task's tests + Task 11 · §11 → Tasks 11, 13 · Stretch §12: not planned (deliberately).
- **Additions beyond the spec:**
  - An `exists` signal (Review Focus 1).
  - A `Failed` outcome and `on_transfer_done` in the vault.
  - A `get_trusted` view on the vault.
  - `minLabelLength` in the look-alike signal.
  - Prebuilt wasm committed so judges need only Node, not Rust.
  - The vault's full-access key is deleted in `setup`.

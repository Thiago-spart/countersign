# Countersign: Counterparty Firewall for AI Agents That Pay

_Design spec · 2026-11-03 · Status: approved 2026-11-03 · Repo: github.com/Thiago-spart/countersign · License: MIT_

## 1. Summary

AI agents are being given wallets. An agent that reads untrusted input, such as invoices, web pages or tool output, can be prompt-injected into paying the wrong account. Spending limits alone don't help when the attacker's address is still under the limit.

Countersign checks **who** an agent is about to pay before it signs, using two layers:

1. **SDK (offchain).** Scores the receiver from onchain signals: look-alike names, account age, activity, recent contract redeploys, and reports in a shared registry. It returns `allow`, `warn` or `block`, with the reasons.
2. **Vault (onchain).** Holds the agent's funds. The agent's only key is a function-call key that can call two vault methods. The vault enforces caps, a kill switch and registry checks, so a fully compromised agent still can't drain it.

A **shared registry contract** lets agents report bad accounts with evidence, so one agent's bad experience protects every other agent.

A scripted **attack suite** with 7 prompt-injection scenarios is both the demo and the end-to-end test suite. It runs in a local sandbox with no accounts, funds or API keys.

## 2. Hackathon context

- Event: NEAR HACKATHON. Submissions close **2026-11-14 23:59 UTC**; the target is to submit on **2026-11-13**. One submission, which can't be edited afterwards.
- Tracks: `security` (primary), `agents`, `open`.
- Screening: Claude Code and Codex check that the project reproduces and that README claims match behaviour, then human judges decide. The organizers value scoped keys over full-access keys, rules enforced in the contract, the ability to try the project with no funds, and visible receipts.
- Gap filled: the Agent API (agentsonintents) already has static caps and allow/block lists. It has **no counterparty risk scoring**, and with `native.near.transfer` enabled an agent can send NEAR to any account regardless of its destination list. Countersign adds scoring, shared threat intelligence, and an onchain floor that covers native NEAR.

## 3. Goals and non-goals

**Goals (v1)**
- G1. Before a payment is signed, return a verdict with human-readable reasons.
- G2. Make sure that even an agent that skips the SDK can only move funds within the vault's onchain rules.
- G3. Payments that need a human are approved only by the owner's key, never by the agent.
- G4. A shared, open, abuse-resistant registry of reported accounts.
- G5. Any judge can run the full attack suite with one command and no setup beyond Node and Rust.
- G6. Agents can use it through an MCP server, a TypeScript SDK or the CLI.

**Non-goals (v1)**
- USDC / NEP-141 payments (stretch, §12).
- A hosted HTTP API (stretch, §12).
- Paying on mainnet. Mainnet is read-only scoring only.
- LLM-based scoring. Scoring is deterministic.
- A web UI. The CLI and the X video are the interface. A small receipts page is a stretch goal.
- NEAR Intents and cross-chain payments.

## 4. Architecture

```
 LLM agent (Claude via MCP) / scripted TS agent
        │ safe_transfer(to, amount, memo)
        ▼
 ┌─ packages/sdk ─ guardedAgent ──────────────────────────┐
 │ packages/core: signals ─▶ scorer(policy.json) ─▶ verdict│
 └───────┬─────────────────────────────────────────────────┘
         │ signs with a function-call key on the vault account,
         │ allowed methods: [pay, request_approval, report]
         ▼
 ┌─ contracts/vault (one per agent) ─┐  view   ┌─ contracts/registry (shared) ─┐
 │ caps · pause · trusted payees     │───────▶ │ reports · evidence · rebuttals│
 │ pending queue · owner approvals   │         └───────────────────────────────┘
 └───────────────────────────────────┘
 owner (human) ─ CLI with owner key ─▶ approve / deny / pause / set_limits / withdraw
```

### Repo layout (pnpm monorepo)

| Path | Purpose |
|---|---|
| `contracts/registry` | Rust (near-sdk 5.x): the shared report registry |
| `contracts/vault` | Rust: the per-agent vault |
| `packages/core` | Signal providers, scorer and policy loader. Contains no signing code |
| `packages/sdk` | `guardedAgent`: check, then call the vault, then write a receipt |
| `packages/mcp` | MCP server (`@modelcontextprotocol/sdk`) |
| `packages/cli` | `countersign` CLI (check, approve, deny, pause, report, status, demo) |
| `attacks/` | Scripted attack scenarios and their runner |
| `policy.json` | Every scoring weight and threshold |
| `fixtures/` | Recorded signal data for sandbox mode |

Stack: Node ≥22, TypeScript, pnpm, near-api-js v7, near-workspaces (sandbox), vitest, Rust + cargo-near.

## 5. Contracts

### 5.1 Vault

One vault per agent, deployed to a sub-account such as `vault.alice.testnet`. The agent holds a **function-call access key on the vault account** with receiver = the vault and methods = `["pay", "request_approval", "report"]`, plus a fixed gas allowance. `owner_id` is a separate account controlled by the human.

State: `owner_id`, `registry_id`, `limits {per_tx, daily, unknown_payee_max, registry_pending_threshold}`, `paused`, `trusted: LookupSet<AccountId>`, `spent_today {day, amount}`, `pending: IterableMap<u64, PendingPayment>`, `next_id`.

Defaults: `per_tx` 1 NEAR, `daily` 5 NEAR, `unknown_payee_max` 0.1 NEAR, `registry_pending_threshold` 2.

| Method | Caller | Behaviour |
|---|---|---|
| `new(owner_id, registry_id, limits)` | init | |
| `pay(receiver, amount, memo)` | the vault itself (agent key) | See §5.1.1. Returns `Paid`, `Pending{id}` or `Rejected{reason}` |
| `request_approval(receiver, amount, memo, reason)` | the vault itself (agent key) | Always queues a pending payment (subject to `per_tx` and pause), returns `Pending{id}` |
| `report(target, category, tx_hash?, note)` | the vault itself (agent key) | Forwards to `registry.report` and pays the 0.01 NEAR deposit from the vault balance. Limited to 5 reports per day, and the deposits count toward `spent_today`, so a compromised agent can't use reports to drain the vault |
| `approve(id)` | owner | Re-checks pause and the daily cap, then transfers. Emits `payment_approved` + `payment_paid` |
| `deny(id)` | owner | Removes the pending payment. Emits `payment_denied` |
| `pause()` / `unpause()` | owner | Kill switch. While paused, `pay` and `request_approval` reject and `approve` rejects |
| `set_limits(limits)`, `trust(id)`, `untrust(id)` | owner | Configuration |
| `withdraw(amount)` | owner | Transfers funds to the owner |
| `get_limits`, `get_pending`, `get_spent_today`, `is_trusted` | view | |

`pay`, `request_approval` and `report` require `predecessor == current_account_id`. They are called through the agent's key on the vault account. Owner methods require `predecessor == owner_id`.

#### 5.1.1 `pay()` order of checks

1. `paused` → `Rejected("paused")`.
2. `amount > per_tx` → `Rejected("over per-tx cap")`.
3. Roll `spent_today` over to the new day if needed. If `spent_today + amount > daily` → `Rejected("over daily cap")`.
4. **Reserve** the amount (`spent_today += amount`), then call `registry.get_summary(receiver)` with a callback `on_registry_summary`.
5. In the callback, which is `#[private]` and never panics:
   - The registry call failed → release the reservation, `Rejected("registry unavailable")`.
   - `summary.reports >= registry_pending_threshold` → release the reservation and queue `Pending` with reason `registry_flagged`. Rebuttals do **not** bypass this rule, because a scammer can rebut their own reports.
   - `receiver` is not trusted and `amount > unknown_payee_max` → release the reservation and queue `Pending("unknown payee")`.
   - Otherwise transfer, emit `payment_paid`, and return `Paid`.

Approved payments count toward `spent_today` when they're approved. If the daily cap is exceeded at that point, `approve` fails and the payment stays pending.

The pending queue has a maximum size (50). The vault pays for its own storage from its balance; if the queue is full, `request_approval` rejects. This stops a compromised agent from growing storage without limit.

Events are NEP-297: `EVENT_JSON:{"standard":"countersign","version":"1.0.0","event":"payment_paid|payment_pending|payment_rejected|payment_approved|payment_denied|paused|unpaused",...}`.

### 5.2 Registry

One shared contract, e.g. `registry.countersign.testnet`. It has no owner or admin and can't be upgraded after deployment; its full access key is deleted.

State: `reports: LookupMap<target, IterableMap<reporter, Report>>` (or a flat map keyed by `(target, reporter)`), `summaries: LookupMap<target, Summary>`, `rebuttals: LookupMap<target, Rebuttal>`.

`Report {reporter, category: scam|phishing|drainer|impersonation|other, tx_hash: Option<String>, note: String (≤280 bytes), created_at}`.

| Method | Caller | Behaviour |
|---|---|---|
| `report(target, category, tx_hash?, note)` | anyone, `#[payable]` with ≥0.01 NEAR | At most one report per (reporter, target). Must not be self-reported. Charges the measured storage cost and refunds the rest. Emits `report_added` |
| `withdraw_report(target)` | the reporter | Removes the report and refunds the storage deposit. Emits `report_withdrawn` |
| `rebut(note)` | the target (`predecessor`) | Stores or replaces a single rebuttal, which needs a storage deposit. Emits `rebuttal_added` |
| `get_summary(target)` | view | `{reports, first_seen, last_seen, rebutted}` |
| `get_reports(target, from_index, limit)` | view | Paginated |
| `get_rebuttal(target)` | view | |

## 6. Scorer (`packages/core`)

### 6.1 Signals

Each provider implements `(target, ctx) → Signal {id, status: "ok" | "unknown", points, reason, data}`. The context `ctx` holds the network, the vault ID, the trusted list and the agent's past payees.

| id | Source | Default rule (in `policy.json`) |
|---|---|---|
| `lookalike` | vault trusted list + past payees | Normalize the name (lowercase; homoglyph map `0→o, 1→l, 3→e, 5→s, rn→m, vv→w`). The account isn't trusted but is within Damerau-Levenshtein distance ≤2 of a trusted name, or has the same base name under another parent or suffix → **+45** |
| `registry` | registry `get_reports` + NearBlocks for each reporter | Each report gives `25 × credibility(reporter)`, where `credibility = min(1, age_days/30) × (tx_count ≥ 10 ? 1 : 0.5)`. If the target has rebutted, the total is ×0.5. Capped at **+75**: one or two credible reports cause a `warn`, three cause a `block` |
| `age` | NearBlocks `/v1/account/{id}` `created.block_timestamp` | under 1 day **+30**; under 7 days **+15**; null (genesis) **0** |
| `activity` | NearBlocks transaction count | fewer than 5 transactions **+10** |
| `code_change` | RPC `view_account.code_hash` + NearBlocks contract deployments | a contract redeployed within 7 days **+25** |
| `first_contact` | the agent's receipts and vault events | never paid before **+5** |
| _(any)_ | — | `status: unknown` (source failed or rate-limited) **+10** each |

**Verdict**: `score = min(100, Σ points)`. Below 30 is `allow`, 30–69 is `warn`, and 70 or more is `block`. The verdict includes `score`, `decision`, the list of signals, and `reasons` (the non-zero ones, as text).

If the receiver is on the trusted list, the `lookalike`, `first_contact` and `age` points are skipped, but `registry` and `code_change` still apply.

### 6.2 Providers by network

| Network | Signal data | Payments |
|---|---|---|
| `sandbox` | `FixtureProvider` reads `fixtures/*.json` (recorded NearBlocks/RPC responses); registry reads hit the local sandbox contract | local sandbox |
| `testnet` | NearBlocks testnet API + testnet RPC + the deployed registry | testnet vault |
| `mainnet` | NearBlocks + mainnet RPC; read-only | disabled in v1 |

NearBlocks responses are cached on disk for 10 minutes (`~/.cache/countersign`). Requests retry with backoff, at most 3 attempts.

## 7. SDK, MCP and CLI

### 7.1 SDK
```ts
const agent = guardedAgent({ network, vaultId, agentKey, policy });
await agent.check(to)                      // → Verdict, signs nothing
await agent.safeTransfer(to, amount, memo) // → Outcome
```
`safeTransfer` works as follows:
- `block` → returns `{status: "refused", verdict}` and signs nothing.
- `warn` → calls `vault.request_approval(…, reason = verdict.reasons)` and returns `{status: "pending", id, verdict}`.
- `allow` → calls `vault.pay(…)` and maps the result to `paid` (with the tx hash), `pending` or `rejected`.

Every outcome is appended to `receipts.jsonl` as `{ts, to, amount, verdict, outcome, tx_hash}`.

### 7.2 MCP server tools
- `check_counterparty(account)` → the verdict.
- `safe_transfer(to, amount_near, memo)` → the outcome, with the reasons as text so the LLM can explain them.
- `report_counterparty(account, category, note, tx_hash?)` → calls `vault.report()`, which forwards the report to the registry (see §5.1 and §14, open question 1).
- **No** approve, deny, withdraw or limits tools. The agent can't call those methods even through MCP.

### 7.3 CLI (`countersign`)
`check <account> [--network]` · `status` (limits, spent today, pending, remaining key allowance) · `approve <id>` · `deny <id>` · `pause` · `unpause` · `report …` · `setup --network testnet` (creates the vault sub-account, deploys it, adds the function-call key, funds it, and writes `.env`) · `attacks [--network]`.

The owner key comes from `.env` (`OWNER_PRIVATE_KEY`) or a near-cli keychain, and is never committed.

## 8. Attack suite (`attacks/`)

The agent replays a fixed conversation with the injection in its tool output, so the run is deterministic and needs no LLM. The video shows the same scenarios with Claude connected over MCP.

| # | Scenario | Expected result | Layer that stops it |
|---|---|---|---|
| A1 | Swapped invoice address `acme-c0rp` vs trusted `acme-corp` | `block` (lookalike) | SDK |
| A2 | Urgent payment to a freshly created account | `warn` → Pending | SDK + vault |
| A3 | Receiver reported by 3 credible reporters | `block` (registry) | SDK |
| A4 | SDK skipped: raw `vault.pay()` to the reported receiver | `Pending(registry_flagged)`, not paid | vault |
| A5 | Drip drain: 60 raw `pay()` calls of 0.1 NEAR to an unknown account, each at the unknown-payee limit | The first 50 are paid (5 NEAR), the rest are Rejected("over daily cap"), so the loss stops at the daily cap | vault |
| A6 | Key abuse: direct NEAR transfer, `approve`, `withdraw` with the agent key | All three rejected by the protocol | NEAR access keys |
| A7 | Control case: normal payment to a trusted payee | `allow` → Paid | all |

`pnpm attacks` prints `# | scenario | expected | actual | PASS/FAIL | tx` and exits non-zero on any FAIL.

## 9. Error handling

- **Signals fail closed.** A failed source is `unknown` (+10). Only the network signals (age, activity, code_change, registry) can fail; with all four unknown the score is at least 40, so the verdict is `warn` and a human decides.
- **The vault never pays without a successful registry read.** The callback releases the reservation on failure and never panics.
- **Gas allowance.** `status` shows how much allowance the key has left, and the CLI warns below 20%. The README documents what the key can and can't do.
- **Storage.** Payable methods measure the storage they use and refund the excess, following the `security-storage-checks` rule.
- **Mainnet.** The SDK refuses to sign on `mainnet` in v1.

## 10. Testing

- **Rust:** unit tests, plus near-workspaces tests for each `pay()` branch (paused, per-tx, daily, registry flagged, unknown payee, paid), registry call failure, access control on every method, pending queue limit, approve re-checking the cap, registry deposit and refund, the one-report-per-reporter rule, and that self-rebuttal doesn't bypass the vault.
- **TypeScript (vitest):** each provider against recorded fixtures; scorer edge cases (score exactly 30 and exactly 70, all signals unknown, trusted payee); a lookalike corpus (homoglyphs, suffix swaps, near-misses that should *not* match); MCP tool schemas.
- **End to end:** the attack suite in the sandbox. GitHub Actions runs `cargo test`, `pnpm test` and `pnpm attacks`.
- **Audit:** a `near-contract-audit` skill pass over both contracts, with the findings and fixes recorded in `SECURITY.md`.

## 11. Submission requirements (from HACKATHON.md)

- Public repo (`Thiago-spart/countersign`, created 2026-11-03, inside the hackathon window that opened 2026-10-19), MIT `LICENSE`, and a README written for an AI judge: what it is, the problem, and numbered "do X → see Y" steps. The quick start is `pnpm i && pnpm attacks`. No marketing.
- The README lists libraries, templates and AI-generated code, and has a "Limits" section covering what the key can't do, the sybil resistance limits of the registry, and the fixture data used in sandbox mode.
- No secrets in the git history. `.env.example` only.
- X post: the problem in the first line, one complete moment (an injected agent being stopped), what NEAR does concretely (scoped function-call keys and onchain enforcement), tags @NEARProtocol and #NEARHackathon (plus @NearBuilders and @NearLegion), and a video.
- The submission payload is reviewed by the human before it's sent.

## 12. Stretch goals (only after the v1 attack suite passes on testnet)

1. Hosted HTTP API (`packages/api`) over `core`, kept up until 2026-11-25.
2. NEP-141 (USDC) payments from the vault, with a mock FT on testnet.
3. Receipts and registry web page.
4. Publish the agent on the NEAR Agent Market.

## 13. Schedule (2026-11-09 → 11-13)

| Day | Deliverable | Done when |
|---|---|---|
| Nov 9 | Registry + vault contracts and Rust tests | `cargo test` passes for every §10 contract case |
| Nov 10 | `core`: providers, scorer, policy, fixtures | vitest passes; `countersign check <acct> --network mainnet` works |
| Nov 11 | `sdk`, `cli`, `mcp` | Claude Desktop/Code can call `safe_transfer` against the sandbox |
| Nov 12 | Attack suite, sandbox runner, testnet deploy, CI | `pnpm attacks` shows 7/7 PASS locally and on testnet |
| Nov 13 | README, SECURITY.md audit, video, X post, submission | the human has confirmed and sent the payload |

Before Nov 9 (prep around MLH): create testnet and mainnet accounts, install Rust and cargo-near, ask in Discord about eligibility from Brazil, create the repo.

## 14. Risks and open questions

**Risks**
- NearBlocks free-tier limits or changes to its API. Mitigation: caching, `unknown` fails closed, and sandbox fixtures mean the demo doesn't depend on it.
- The registry can be sybil-attacked on testnet, where accounts are free. Mitigation: credibility weighting offchain, and onchain reports only send payments to Pending. Documented under Limits.
- The schedule is tight for one person. Mitigation: stretch goals are strictly deferred, and the contracts and core are built first because they hold the rest up.
- The same idea starts from the organizers' starter prompt, so other teams will build something similar. Differentiators: lookalike detection, enforcement in the vault even when the SDK is bypassed, the shared credibility-weighted registry, and the reproducible attack suite.

**Open questions (defaults chosen; change them while reviewing if you prefer)**
1. Who reports to the registry from MCP? Default: the vault account signs via a third allowed method, `report`, forwarded to the registry. Alternative: only the owner reports, via the CLI.
2. Name: decided as **Countersign**. The plain npm name is taken, so packages publish under the `@thiago-spart/` scope.

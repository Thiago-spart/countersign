# AGENTS.md

These are instructions for AI coding agents (Claude Code, Codex, Copilot) working in this repository.

## What this is

Countersign is a counterparty firewall for AI agents that pay on NEAR. Before an agent pays, the receiver is scored: `allow`, `warn` or `block`. Funds sit in a vault contract that the agent can reach only through a function-call key. A shared registry contract collects reports about bad accounts.

- Design spec: `docs/superpowers/specs/2026-11-03-countersign-design.md`. It's the source of truth; references like §5.1 point into it.
- Implementation plan: `docs/superpowers/plans/2026-11-03-countersign.md`, which includes the Global Constraints and Review Focus.
- Work is tracked as GitHub issues. Parent: "Countersign v1". One sub-issue per plan task.

## Repo map

| Path | What |
|---|---|
| `contracts/registry`, `contracts/vault` | Rust contracts (near-sdk 5.x, cargo-near) |
| `contracts/res/*.wasm` | Prebuilt contracts, committed so `pnpm attacks` needs only Node |
| `packages/core` | Data sources, signals, scorer, `policy.json` loader. Contains no signing code |
| `packages/sdk` | `guardedAgent`: check, call the vault, write a receipt |
| `packages/cli` | The `countersign` CLI |
| `packages/mcp` | MCP server with 3 tools |
| `attacks/` | 7 scripted prompt-injection scenarios (the end-to-end tests and the demo) |
| `fixtures/` | Recorded signal data for sandbox mode |

## Commands

```sh
pnpm i                    # install
pnpm build:contracts      # cargo near build → contracts/res/*.wasm
pnpm test:contracts       # cargo test in contracts/ (sandbox integration tests)
pnpm test                 # vitest, all packages
pnpm typecheck
pnpm attacks              # all 7 scenarios in a local sandbox → 7 PASS, exit 0
```

A change is done only when every command above that touches the changed area passes. Paste the output into the PR.

## Rules

1. **TDD.** Write the failing test named in the issue, see it fail, implement, see it pass. Don't weaken or delete a test to make it pass.
2. **Stay in scope.** Implement only the issue you're working on. Use the exact names and signatures from the issue's *Interfaces* block. If one is wrong or missing, say so in the PR; don't invent a different one.
3. **Safety.**
   - Never sign on mainnet. Mainnet is read-only.
   - Never commit secrets or print private keys. Keys go in `.env`.
   - Testnet transactions, pushing, remote install scripts and anything labelled `needs-human` need the human's explicit OK first.
   - near-mcp tools default `networkId` to **mainnet**. Always pass `networkId: "testnet"` explicitly. Its write tools (send, create account, add/delete key, delete/export account, swap) count as testnet transactions and need the human's OK.
4. **Contracts.**
   - Callbacks are `#[private]` and never panic.
   - Use `require!` and saturating or checked arithmetic.
   - Follow the skills in `.claude/skills/near-smart-contracts` (restore them with `npx skills experimental_install`).
5. **Commits.** Use conventional commits (`feat(vault): …`), and end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the attribution of the agent you are).

## Issue workflow

1. Pick an open issue labelled `agent-ready` whose "blocked by" issues are all closed.
2. Branch `task/<issue-number>-<slug>` from `main`.
3. Work through the issue's checklist in order, ticking items as you go.
4. Open a PR titled like the issue, with `Closes #<n>` in the body, and fill in the PR template's verification section.
5. Stop at any `needs-human` step and ask for it in the PR or issue, then wait.

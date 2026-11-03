# Examples

`claude-mcp.json` registers the Countersign MCP server (three tools: `check_counterparty`, `safe_transfer`, `report_counterparty`) with Claude Code or Claude Desktop. Run from the repo root after `countersign sandbox up`:

```sh
claude mcp add-json countersign-demo "$(jq -c '.mcpServers.countersign' examples/claude-mcp.json)"
```

It points at `.env.sandbox` only, the agent-only file (function-call key, no owner key). Do not add near-mcp or any other server or file that holds the owner key or a full-access key: the model could then bypass the vault and approve its own payments (see `docs/limits.md`). Approvals happen in a separate shell: `countersign approve <id> --owner-env .env.sandbox.owner`. The server also refuses to start if `COUNTERSIGN_OWNER_KEY` is in its environment.

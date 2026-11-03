#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { loadConfig } from "@countersign/core";
import { guardedAgent, redactError } from "@countersign/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/** `--env-file <path>` / `--env-file=<path>`, default `.env`. */
function envFileArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--env-file") return argv[i + 1] ?? ".env";
    if (a.startsWith("--env-file=")) return a.slice("--env-file=".length);
  }
  return ".env";
}

async function main(): Promise<void> {
  const file = envFileArg(process.argv.slice(2));
  const explicit = process.argv.some((a) => a === "--env-file" || a.startsWith("--env-file="));
  if (existsSync(file)) process.loadEnvFile(file);
  else if (explicit) throw new Error(`env file not found: ${file}`);

  // The agent process must never hold the owner key (it could approve its own payments).
  if (process.env.COUNTERSIGN_OWNER_KEY) {
    console.error(
      "error: COUNTERSIGN_OWNER_KEY is present in this process's environment (or in the env file). " +
        "The MCP server is the agent and must never hold the owner key. Remove it and use an agent-only env file such as .env.sandbox.",
    );
    process.exit(2);
  }

  const config = loadConfig(process.env);
  const agent = await guardedAgent({
    config,
    receiptsPath: process.env.COUNTERSIGN_RECEIPTS_PATH?.trim() || undefined,
  });
  const server = createServer(agent, [config.agentKey ?? ""]);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; log to stderr only.
  console.error(`countersign MCP server ready (${config.network})`);
}

main().catch((e) => {
  console.error(`error: ${redactError(e, [process.env.COUNTERSIGN_AGENT_KEY]).message}`);
  process.exit(1);
});

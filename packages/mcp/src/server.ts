import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GuardedAgent } from "@countersign/sdk";
import { buildTools } from "./tools.js";

/** An MCP server exposing exactly the three agent tools. Transport is attached by the caller. */
export function createServer(agent: GuardedAgent, secrets: readonly string[] = []): McpServer {
  const server = new McpServer({ name: "countersign", version: "0.1.0" });
  for (const t of buildTools(agent, secrets)) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema },
      // The SDK validates input against the schema before calling; errors come back as isError results.
      t.handler as never,
    );
  }
  return server;
}

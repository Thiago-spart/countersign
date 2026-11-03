// Drives the Countersign MCP server over stdio, started exactly as examples/claude-mcp.json says,
// and checks the three outcomes an agent sees. Needs `pnpm countersign sandbox up` running in
// another shell (it writes .env.sandbox). Run from the repo root: node examples/mcp-check.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const TIMEOUT_MS = 30_000;
const HINT = "is `pnpm countersign sandbox up` running?";

const server = JSON.parse(readFileSync("examples/claude-mcp.json", "utf8")).mcpServers.countersign;
const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"] });

function fail(why) {
  console.error(`mcp-check: FAILED: ${why} (${HINT})`);
  child.kill();
  process.exit(1);
}

const timer = setTimeout(() => fail(`no result within ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS);
child.on("error", (e) => fail(`could not start the server: ${e.message}`));
child.on("exit", (code, signal) => {
  for (const { reject } of waiting.values()) reject(new Error(`server exited (${signal ?? `code ${code}`})`));
  waiting.clear();
});

let buffer = "";
let nextId = 0;
const waiting = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not a JSON-RPC message (e.g. a log line)
    }
    const w = waiting.get(msg?.id);
    if (!w) continue;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(`${msg.error.message ?? "JSON-RPC error"}`));
    else w.resolve(msg);
  }
});
const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return reject(new Error("server is not running"));
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    send({ id, method, params });
  });

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-check", version: "1" } });
  send({ method: "notifications/initialized" });

  let ok = true;
  const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
  console.log(`tools (${tools.length}): ${tools.join(", ")}`);
  if (tools.length !== 3) ok = false;

  const calls = [
    ["check_counterparty", { account: "acme-c0rp.sandbox" }, "BLOCK"],
    ["safe_transfer", { to: "acme-c0rp.sandbox", amount_near: "0.5", memo: "invoice 2026-11" }, "REFUSED"],
    ["safe_transfer", { to: "fresh-invoice.sandbox", amount_near: "0.05", memo: "urgent invoice" }, "PENDING"],
    ["safe_transfer", { to: "acme-corp.sandbox", amount_near: "0.5", memo: "invoice 2026-11" }, "PAID"],
  ];
  for (const [name, args, expected] of calls) {
    const { result } = await rpc("tools/call", { name, arguments: args });
    const text = result.content.map((c) => c.text).join("\n");
    const pass = !result.isError && text.startsWith(expected);
    if (!pass) ok = false;
    console.log(`\n> ${name} ${JSON.stringify(args)}  [${pass ? "ok" : `expected ${expected}`}]\n${text}`);
  }

  clearTimeout(timer);
  child.kill();
  console.log(ok ? "\nmcp-check: ok" : "\nmcp-check: FAILED");
  process.exit(ok ? 0 : 1);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Verdict } from "@countersign/core";
import { InvalidInputError, type GuardedAgent, type Outcome } from "@countersign/sdk";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";

const KEY = "ed25519:" + "3".repeat(88);

const verdict = (decision: Verdict["decision"], reasons: string[] = ["r1"]): Verdict => ({
  target: "evil.testnet",
  score: decision === "block" ? 95 : 10,
  decision,
  signals: [],
  reasons,
});

function fakeAgent(over: Partial<GuardedAgent> = {}) {
  const agent = {
    check: vi.fn(async () => verdict("block", ["reported 3 times", "account is 1 day old"])),
    safeTransfer: vi.fn(async (): Promise<Outcome> => ({ status: "refused", verdict: verdict("block", ["reported 3 times", "account is 1 day old"]) })),
    report: vi.fn(async () => ({ txHash: "TXH" })),
    ...over,
  };
  return agent;
}

async function connect(agent: GuardedAgent) {
  const server = createServer(agent);
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);
const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };

describe("tool list", () => {
  it("is exactly the three tools", async () => {
    const client = await connect(fakeAgent());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["check_counterparty", "report_counterparty", "safe_transfer"]);
  });
});

describe("check_counterparty", () => {
  it("returns decision, score, reasons and structured verdict", async () => {
    const client = await connect(fakeAgent());
    const r = await call(client, "check_counterparty", { account: "evil.testnet" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toMatch(/BLOCK/);
    expect(r.content[0]!.text).toContain("95");
    expect(r.content[0]!.text).toContain("reported 3 times");
    expect((r.structuredContent as Verdict).decision).toBe("block");
  });
});

describe("safe_transfer", () => {
  it("rejects bad amount without calling the agent", async () => {
    const agent = fakeAgent();
    const client = await connect(agent);
    const r = await call(client, "safe_transfer", { to: "a.testnet", amount_near: "-1" });
    expect(r.isError).toBe(true);
    expect(agent.safeTransfer).not.toHaveBeenCalled();
  });

  it("refused text has REFUSED, every reason, and is final", async () => {
    const client = await connect(fakeAgent());
    const r = await call(client, "safe_transfer", { to: "evil.testnet", amount_near: "5" });
    expect(r.isError).toBeFalsy();
    const t = r.content[0]!.text;
    expect(t).toContain("REFUSED");
    expect(t).toContain("reported 3 times");
    expect(t).toContain("account is 1 day old");
    expect(t).toContain("Do not retry this payment.");
    expect(t).toMatch(/final/i);
    expect(t).toMatch(/outside the model/i);
  });

  it("pending text names the exact owner command", async () => {
    const agent = fakeAgent({ safeTransfer: vi.fn(async () => ({ status: "pending", id: "7", reason: "new payee", verdict: verdict("warn") }) as Outcome) });
    const client = await connect(agent);
    const t = text(await call(client, "safe_transfer", { to: "x.testnet", amount_near: "1" }));
    expect(t).toContain("PENDING approval #7");
    expect(t).toContain('"countersign approve 7"');
  });

  it("paid, rejected and failed outcomes", async () => {
    const outs: Outcome[] = [
      { status: "paid", txHash: "HASH1", verdict: verdict("allow") },
      { status: "rejected", reason: "over daily limit", verdict: verdict("allow") },
      { status: "failed", reason: "boom", verdict: verdict("allow") },
    ];
    for (const o of outs) {
      const client = await connect(fakeAgent({ safeTransfer: vi.fn(async () => o) }));
      const r = await call(client, "safe_transfer", { to: "x.testnet", amount_near: "1" });
      const t = r.content[0]!.text;
      if (o.status === "paid") expect(t).toMatch(/^PAID.*HASH1/);
      if (o.status === "rejected") expect(t).toMatch(/^REJECTED.*over daily limit.*Do not retry/s);
      if (o.status === "failed") expect(t).toMatch(/^FAILED.*boom/s);
    }
  });

  it("a thrown send error is UNKNOWN status, redacted, no stack", async () => {
    const err = new Error(`timeout signing with ${KEY}`);
    const client = await connect(fakeAgent({ safeTransfer: vi.fn(async () => { throw err; }) }));
    const r = await call(client, "safe_transfer", { to: "x.testnet", amount_near: "1" });
    expect(r.isError).toBe(true);
    const t = r.content[0]!.text;
    expect(t).toContain("UNKNOWN");
    expect(t).toMatch(/do not retry/i);
    expect(t).toContain("countersign status");
    expect(t).not.toContain(KEY);
    expect(t).not.toContain("3".repeat(40));
    expect(t).not.toMatch(/\n\s+at /);
  });

  it("rejects a memo over 280 bytes before calling the agent (bytes, not characters)", async () => {
    const agent = fakeAgent();
    const client = await connect(agent);
    const memo = "€".repeat(94); // 94 characters, 282 bytes
    const r = await call(client, "safe_transfer", { to: "x.testnet", amount_near: "1", memo });
    expect(r.isError).toBe(true);
    expect(agent.safeTransfer).not.toHaveBeenCalled();
    const ok = await call(client, "safe_transfer", { to: "x.testnet", amount_near: "1", memo: "€".repeat(93) });
    expect(ok.isError).toBeFalsy();
    expect(agent.safeTransfer).toHaveBeenCalledTimes(1);
  });

  it("InvalidInputError is a plain validation error", async () => {
    const client = await connect(fakeAgent({ safeTransfer: vi.fn(async () => { throw new InvalidInputError("memo", "exceeds 280 bytes"); }) }));
    const r = await call(client, "safe_transfer", { to: "x.testnet", amount_near: "1" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("memo");
    expect(r.content[0]!.text).not.toContain("UNKNOWN");
  });
});

describe("report_counterparty", () => {
  it("passes through and returns the tx hash", async () => {
    const agent = fakeAgent();
    const client = await connect(agent);
    const r = await call(client, "report_counterparty", { account: "evil.testnet", category: "scam", note: "took funds", tx_hash: "abc" });
    expect(r.isError).toBeFalsy();
    expect(agent.report).toHaveBeenCalledWith("evil.testnet", "scam", "took funds", "abc");
    expect(r.content[0]!.text).toContain("TXH");
  });

  it("rejects a 281-char note", async () => {
    const agent = fakeAgent();
    const client = await connect(agent);
    const r = await call(client, "report_counterparty", { account: "e.testnet", category: "scam", note: "x".repeat(281) });
    expect(r.isError).toBe(true);
    expect(agent.report).not.toHaveBeenCalled();
  });

  it("rejects an unknown category", async () => {
    const agent = fakeAgent();
    const client = await connect(agent);
    const r = await call(client, "report_counterparty", { account: "e.testnet", category: "meh", note: "x" });
    expect(r.isError).toBe(true);
    expect(agent.report).not.toHaveBeenCalled();
  });
});

describe("main.ts", () => {
  it("refuses to start when COUNTERSIGN_OWNER_KEY is in its environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-main-"));
    const envFile = join(dir, ".env");
    writeFileSync(envFile, `COUNTERSIGN_NETWORK=sandbox\nCOUNTERSIGN_OWNER_KEY=${KEY}\n`);
    const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const run = (env: Record<string, string>) =>
      new Promise<{ code: number; stderr: string; stdout: string }>((resolve) =>
        execFile(tsx, [main, "--env-file", envFile], { cwd: dir, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, timeout: 30_000 }, (err, stdout, stderr) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
        ),
      );
    for (const r of [await run({}), await run({ COUNTERSIGN_OWNER_KEY: KEY })]) {
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("COUNTERSIGN_OWNER_KEY");
      expect(r.stderr).not.toContain(KEY);
      expect(r.stdout).not.toContain(KEY);
    }
  }, 60_000);
});

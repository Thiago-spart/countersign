import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReceiptLog, guardedAgent, VaultClient, AGENT_ALLOWANCE, AGENT_METHODS } from "@countersign/sdk";
import { startSandbox, type SandboxEnv } from "@countersign/sdk/sandbox";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatAllowance, formatFreeBalance } from "../src/format.js";
import { runSetup } from "../src/commands/setup.js";

const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

let env: SandboxEnv;
let cwd: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawns the CLI in a fresh temp cwd (so no .env or receipts leak in) with the given env. */
function cli(args: string[], envVars: Record<string, string> | null = sandboxEnv()): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      TSX,
      [MAIN, ...args],
      { cwd, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...(envVars ?? {}) }, timeout: 60_000 },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
      },
    );
  });
}

function sandboxEnv(): Record<string, string> {
  const c = env.config;
  return {
    COUNTERSIGN_NETWORK: "sandbox",
    COUNTERSIGN_RPC_URL: c.rpcUrl,
    COUNTERSIGN_REGISTRY_ID: c.registryId,
    COUNTERSIGN_VAULT_ID: c.vaultId!,
    COUNTERSIGN_AGENT_KEY: c.agentKey!,
    COUNTERSIGN_OWNER_ID: c.ownerId!,
    COUNTERSIGN_OWNER_KEY: c.ownerKey!,
  };
}

beforeAll(async () => {
  env = await startSandbox();
  cwd = mkdtempSync(join(tmpdir(), "countersign-cli-"));
}, 90_000);

afterAll(async () => {
  await env?.tearDown();
});

describe("format", () => {
  it("allowance: null is unlimited with no warning", () => {
    expect(formatAllowance(null)).toEqual({ text: "unlimited" });
  });
  it("allowance: 1 NEAR is fine, 0.04 NEAR warns (below 20% of 1 NEAR)", () => {
    expect(formatAllowance(10n ** 24n).warning).toBeUndefined();
    expect(formatAllowance(2n * 10n ** 23n).warning).toBeUndefined(); // exactly 20%
    const low = formatAllowance(4n * 10n ** 22n);
    expect(low.text).toBe("0.04 NEAR");
    expect(low.warning).toMatch(/allowance/i);
    // The vault has no full-access key, so no new key can be added: withdraw and set up a new vault.
    expect(low.warning).toMatch(/withdraw/);
    expect(low.warning).toMatch(/new vault/);
    expect(low.warning).not.toMatch(/add a new key/);
  });
  it("free balance: warns below 0.06 NEAR", () => {
    expect(formatFreeBalance(10n ** 24n).warning).toBeUndefined();
    expect(formatFreeBalance(5n * 10n ** 22n).warning).toMatch(/prepay gas/);
  });
});

describe("countersign CLI against the sandbox", { timeout: 90_000 }, () => {
  it("check on the look-alike → BLOCK naming acme-corp, exit 0", async () => {
    const r = await cli(["check", "acme-c0rp.sandbox"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("BLOCK");
    expect(r.stdout).toContain("acme-corp");
  });

  it("check --json prints a valid Verdict", async () => {
    const r = await cli(["check", "acme-c0rp.sandbox", "--json"]);
    expect(r.code).toBe(0);
    const v = JSON.parse(r.stdout);
    expect(v.target).toBe("acme-c0rp.sandbox");
    expect(v.decision).toBe("block");
    expect(typeof v.score).toBe("number");
    expect(Array.isArray(v.reasons)).toBe(true);
  });

  it("check with no network config → exit 2 naming the missing variable", async () => {
    const r = await cli(["check", "acme-corp.sandbox"], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("COUNTERSIGN_NETWORK");
  });

  it("status shows limits, daily, allowance, balance and 0 pending", async () => {
    const r = await cli(["status"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("daily");
    expect(r.stdout).toContain("0 pending");
    expect(r.stdout).toMatch(/allowance\s+1 NEAR/i);
    expect(r.stdout).not.toMatch(/warning/i);
    expect(r.stdout).not.toContain(env.config.agentKey!);
  });

  it("approve <id> pays a pending payment, records a receipt, and status shows 0 pending", async () => {
    const receiptsPath = join(cwd, "receipts.jsonl");
    const agent = await guardedAgent({ config: env.config, receiptsPath: join(cwd, "agent-receipts.jsonl") });
    const out = await agent.safeTransfer("fresh-invoice.sandbox", "0.05", "invoice 9");
    expect(out.status).toBe("pending");
    if (out.status !== "pending") return;

    const before = await env.balance("fresh-invoice.sandbox");
    const status1 = await cli(["status"]);
    expect(status1.stdout).toContain("1 pending");
    expect(status1.stdout).toContain("fresh-invoice.sandbox");

    const r = await cli(["approve", out.id]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/paid/i);
    expect(await env.balance("fresh-invoice.sandbox")).toBe(before + 5n * 10n ** 22n);

    const status2 = await cli(["status"]);
    expect(status2.stdout).toContain("0 pending");

    // The payee is now a past payee.
    const log = new ReceiptLog(receiptsPath);
    expect(log.pastPayees()).toEqual(["fresh-invoice.sandbox"]);
    const line = log.read().at(-1)!;
    expect(line.amountYocto).toBe((5n * 10n ** 22n).toString());
    expect(line.verdict.decision).toBe("approved_by_owner");
    expect(line.outcome.status).toBe("paid");
    expect(line.outcome.txHash).toBeTruthy();
  });

  it("deny <id> removes the pending payment; pause/unpause toggle the vault", async () => {
    const agent = await guardedAgent({ config: env.config, receiptsPath: join(cwd, "agent-receipts.jsonl") });
    const out = await agent.safeTransfer("fresh-invoice.sandbox", "0.01", "invoice 10");
    if (out.status !== "pending") throw new Error("expected pending");
    expect((await cli(["deny", out.id])).code).toBe(0);
    expect((await cli(["status"])).stdout).toContain("0 pending");

    const vault = new VaultClient(env.config);
    expect((await cli(["pause"])).code).toBe(0);
    expect(await vault.isPaused()).toBe(true);
    expect((await cli(["status"])).stdout).toMatch(/PAUSED/);
    expect((await cli(["unpause"])).code).toBe(0);
    expect(await vault.isPaused()).toBe(false);
  });

  it("report forwards to the registry via the vault", async () => {
    const r = await cli(["report", "reported.sandbox", "--category", "scam", "--note", "took payment, no delivery"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/reported/i);
  });

  it("an invalid amount-free error prints only .message, exit 1", async () => {
    const r = await cli(["approve", "999999"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toContain("    at "); // no stack
    expect(r.stderr).not.toContain(env.config.ownerKey!);
  });
});

describe("countersign setup (against the sandbox)", { timeout: 90_000 }, () => {
  async function setupEnv() {
    const ownerId = `setupowner${Math.floor(Math.random() * 1e6)}.sandbox`;
    const ownerKey = await env.createAccount(ownerId, "20");
    const dir = mkdtempSync(join(tmpdir(), "countersign-setup-"));
    const out: string[] = [];
    const base = {
      network: "sandbox" as const,
      ownerId,
      ownerKey,
      rpcUrl: env.config.rpcUrl,
      registryId: env.config.registryId,
      fund: "3",
      envPath: join(dir, ".env"),
      recoveryDir: join(dir, "recovery"),
      out: (l: string) => out.push(l),
    };
    return { ownerId, ownerKey, out, base };
  }

  it("creates vault.<owner> with one FC key, no full-access key, and writes .env (0600)", async () => {
    const { ownerId, ownerKey, out, base } = await setupEnv();
    const prompts: string[] = [];
    const res = await runSetup({ ...base, confirm: async (q) => (prompts.push(q), true) });
    expect(res.vaultId).toBe(`vault.${ownerId}`);
    expect(prompts.length).toBe(2); // one prompt per transaction

    const keys = (await env.provider.viewAccessKeyList({ accountId: res.vaultId })).keys;
    expect(keys.length).toBe(1);
    const perm = keys[0]!.access_key.permission as { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string } };
    expect(perm.FunctionCall.receiver_id).toBe(res.vaultId);
    expect(perm.FunctionCall.method_names).toEqual(AGENT_METHODS);
    expect(BigInt(perm.FunctionCall.allowance)).toBeLessThanOrEqual(AGENT_ALLOWANCE);

    const account = await env.provider.viewAccount({ accountId: res.vaultId });
    // The floor must leave the agent room to prepay gas: free balance above the storage stake >= 0.06 NEAR.
    const free = BigInt(account.amount) - BigInt(account.storage_usage) * 10n ** 19n;
    expect(free).toBeGreaterThanOrEqual(6n * 10n ** 22n);

    const text = readFileSync(base.envPath, "utf8");
    expect(statSync(base.envPath).mode & 0o777).toBe(0o600);
    const vars = Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    expect(vars.COUNTERSIGN_VAULT_ID).toBe(res.vaultId);
    expect(vars.COUNTERSIGN_OWNER_ID).toBe(ownerId);
    expect(vars.COUNTERSIGN_NETWORK).toBe("sandbox");
    expect(KeyPair.fromString(vars.COUNTERSIGN_AGENT_KEY as never).getPublicKey().toString()).toBe(keys[0]!.public_key);
    // The owner key never lands in the agent's .env; no key is ever printed.
    expect(text).not.toContain(ownerKey);
    const printed = out.join("\n");
    expect(printed).not.toContain(ownerKey);
    expect(printed).not.toContain(vars.COUNTERSIGN_AGENT_KEY!);
    expect(printed).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/);

    // The configured agent key works end to end.
    const c = { ...env.config, vaultId: res.vaultId, agentKey: vars.COUNTERSIGN_AGENT_KEY, ownerId, ownerKey };
    expect(await new VaultClient(c).keyAllowance()).toBe(AGENT_ALLOWANCE);
    expect(await new VaultClient(c).isPaused()).toBe(false);
  });

  it("refuses when the RPC node's chain_id doesn't match the network, before any prompt or transaction", async () => {
    const { ownerId, base } = await setupEnv();
    const prompts: string[] = [];
    // A "testnet" setup pointed at the sandbox node (chain_id is not "testnet").
    await expect(runSetup({ ...base, network: "testnet", confirm: async (q) => (prompts.push(q), true) })).rejects.toThrow(
      /chain_id/,
    );
    expect(prompts).toEqual([]);
    await expect(env.provider.viewAccount({ accountId: `vault.${ownerId}` })).rejects.toThrow();
    expect(existsSync(base.recoveryDir)).toBe(false);
  });

  it("refuses --fund below 3 NEAR before sending anything", async () => {
    const { ownerId, base } = await setupEnv();
    await expect(runSetup({ ...base, fund: "2.5", confirm: async () => true })).rejects.toThrow(/at least 3/);
    await expect(env.provider.viewAccount({ accountId: `vault.${ownerId}` })).rejects.toThrow();
  });

  it("asks y/N and does nothing when the answer is no", async () => {
    const { ownerId, base, out } = await setupEnv();
    await expect(runSetup({ ...base, confirm: async () => false })).rejects.toThrow(/aborted/i);
    await expect(env.provider.viewAccount({ accountId: `vault.${ownerId}` })).rejects.toThrow();
    expect(existsSync(base.envPath)).toBe(false);
    expect(out.join("\n")).toMatch(/vault\./);
  });

  it("never overwrites an existing .env, and never defaults to yes (no --yes flag exists)", async () => {
    const { base } = await setupEnv();
    writeFileSync(base.envPath, "KEEP=1\n");
    await expect(runSetup({ ...base, confirm: async () => true })).rejects.toThrow(/exists/);
    expect(readFileSync(base.envPath, "utf8")).toBe("KEEP=1\n");
    // No confirm callback: the default prompt must refuse (non-TTY stdin → no).
    const { base: b2 } = await setupEnv();
    await expect(runSetup({ ...b2 })).rejects.toThrow(/aborted/i);
  });

  it("keeps a 0600 recovery key until the batch succeeds, then deletes it", async () => {
    const { ownerId, ownerKey, base } = await setupEnv();
    const recovery = join(base.recoveryDir, `vault.${ownerId}.key`);
    let n = 0;
    // Say yes to the account creation, no to the batch (and no to the cleanup).
    await expect(runSetup({ ...base, confirm: async () => ++n === 1 })).rejects.toThrow(/aborted|setup failed/);
    expect(existsSync(recovery)).toBe(true);
    expect(statSync(recovery).mode & 0o777).toBe(0o600);
    expect(readFileSync(recovery, "utf8")).toMatch(/^ed25519:/);
    expect(await env.provider.viewAccount({ accountId: `vault.${ownerId}` })).toBeTruthy(); // funded, key recoverable
    expect(existsSync(base.envPath)).toBe(false);
    void ownerKey;
    // A successful run leaves no recovery file.
    const ok = await setupEnv();
    await runSetup({ ...ok.base, confirm: async () => true });
    expect(existsSync(join(ok.base.recoveryDir, `vault.${ok.ownerId}.key`))).toBe(false);
  });

  it("refuses mainnet", async () => {
    const { base } = await setupEnv();
    await expect(runSetup({ ...base, network: "mainnet" as never, confirm: async () => true })).rejects.toThrow(/mainnet/);
  });
});

describe("countersign sandbox up", { timeout: 120_000 }, () => {
  it("writes .env.sandbox (0600) and stops cleanly on SIGINT", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "countersign-up-")), ".env.sandbox");
    const child = spawn(TSX, [MAIN, "sandbox", "up", "--out", out], {
      cwd,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME! },
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 100 && !stdout.includes("Press Ctrl-C"); i++) await new Promise((r) => setTimeout(r, 1000));
    expect(stdout).toContain("Press Ctrl-C");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("COUNTERSIGN_VAULT_ID=vault.sandbox");
    expect(text).not.toMatch(/OWNER/); // agent-side file: no owner id or key
    const ownerText = readFileSync(`${out}.owner`, "utf8");
    expect(statSync(`${out}.owner`).mode & 0o777).toBe(0o600);
    expect(ownerText).toContain("COUNTERSIGN_OWNER_KEY=ed25519:");
    expect(ownerText).toContain("COUNTERSIGN_OWNER_ID=owner.sandbox");
    expect(stdout).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/);
    child.kill("SIGINT");
    expect(await exited).toBe(0);
    expect(stdout).toContain("Stopping the sandbox");
  });
});

describe("CLI wiring", { timeout: 90_000 }, () => {
  it("setup --network mainnet exits non-zero and sends nothing", async () => {
    const r = await cli(["setup", "--network", "mainnet", "--owner", "someone.near"], {
      ...sandboxEnv(),
      COUNTERSIGN_OWNER_ID: "",
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/mainnet/);
    expect(existsSync(join(cwd, ".countersign"))).toBe(false);
  });

  it("setup has no --yes flag", async () => {
    const r = await cli(["setup", "--network", "testnet", "--owner", "x.testnet", "--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/unknown option/);
  });

  it("owner commands read the key from --owner-env, not from the agent env file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "countersign-oe-"));
    const c = sandboxEnv();
    const agentFile = join(dir, "agent.env");
    const ownerFile = join(dir, "owner.env");
    const { COUNTERSIGN_OWNER_ID, COUNTERSIGN_OWNER_KEY, ...agent } = c;
    writeFileSync(agentFile, Object.entries(agent).map(([k, v]) => `${k}=${v}`).join("\n"));
    writeFileSync(ownerFile, `COUNTERSIGN_OWNER_ID=${COUNTERSIGN_OWNER_ID}\nCOUNTERSIGN_OWNER_KEY=${COUNTERSIGN_OWNER_KEY}\n`);
    const noKey = await cli(["--env-file", agentFile, "pause"], null);
    expect(noKey.code).toBe(2);
    expect(noKey.stderr).toContain("COUNTERSIGN_OWNER_ID");
    expect((await cli(["--env-file", agentFile, "--owner-env", ownerFile, "pause"], null)).code).toBe(0);
    expect((await cli(["--env-file", agentFile, "--owner-env", ownerFile, "unpause"], null)).code).toBe(0);
  });
});

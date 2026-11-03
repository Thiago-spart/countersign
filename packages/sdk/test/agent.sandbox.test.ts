import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataSource } from "@countersign/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  guardedAgent,
  MainnetSigningDisabledError,
  parseNearAmount,
  VaultClient,
  type GuardedAgent,
  type Outcome,
} from "../src/index.js";
import { ReceiptLog } from "../src/receipts.js";
import { startSandbox, type SandboxEnv } from "./helpers/sandbox.js";

const TRUSTED = "acme-corp.sandbox"; // old, active, trusted in the vault → allow
const LOOKALIKE = "acme-c0rp.sandbox"; // 2h old look-alike of the trusted payee → block
const FRESH = "fresh-invoice.sandbox"; // 3h old, 1 tx → warn
const UNKNOWN = "unknown-payee.sandbox"; // 60 days, 12 txs, not trusted in the vault → allow

let env: SandboxEnv;
let vault: VaultClient;
let agent: GuardedAgent;
let receiptsPath: string;

const receiptLines = (): string[] =>
  existsSync(receiptsPath) ? readFileSync(receiptsPath, "utf8").split("\n").filter((l) => l.length > 0) : [];

/** Runs safeTransfer and asserts it appended exactly one valid receipt line describing the outcome. */
async function transfer(to: string, amount: string, memo?: string): Promise<Outcome> {
  const before = receiptLines().length;
  const outcome = await agent.safeTransfer(to, amount, memo);
  const lines = receiptLines();
  expect(lines.length).toBe(before + 1);
  const r = JSON.parse(lines.at(-1)!) as Record<string, any>;
  expect(Number.isNaN(Date.parse(r.ts))).toBe(false);
  expect(r.to).toBe(to);
  expect(r.amountYocto).toBe(parseNearAmount(amount).toString());
  expect(r.verdict).toEqual({
    score: outcome.verdict.score,
    decision: outcome.verdict.decision,
    reasons: outcome.verdict.reasons,
  });
  expect(r.outcome.status).toBe(outcome.status);
  if (outcome.status === "paid") expect(r.outcome.txHash).toBe(outcome.txHash);
  if (outcome.status === "pending") expect(r.outcome.id).toBe(outcome.id);
  if ("reason" in outcome) expect(r.outcome.reason).toBe(outcome.reason);
  // No secrets in receipts.
  expect(lines.at(-1)).not.toContain(env.config.agentKey!);
  return outcome;
}

beforeAll(async () => {
  env = await startSandbox();
  receiptsPath = join(mkdtempSync(join(tmpdir(), "countersign-sdk-")), "receipts.jsonl");
  vault = new VaultClient(env.config);
  agent = await guardedAgent({ config: env.config, receiptsPath });
}, 60_000);

afterAll(async () => {
  await env?.tearDown();
});

describe("guardedAgent in the sandbox", { timeout: 30_000 }, () => {
  it("lists trusted accounts from the vault", async () => {
    expect(await vault.getTrusted()).toEqual([TRUSTED]);
    expect(await vault.isTrusted(TRUSTED)).toBe(true);
    expect(await vault.keyAllowance()).toBe(10n ** 24n);
  });

  it("block → refused; nothing reaches the vault", async () => {
    const pending = await vault.getPending();
    const spent = await vault.getSpentToday();
    const outcome = await transfer(LOOKALIKE, "0.05", "invoice 7");
    expect(outcome.status).toBe("refused");
    expect(outcome.verdict.decision).toBe("block");
    expect(await vault.getPending()).toEqual(pending);
    expect(await vault.getSpentToday()).toBe(spent);
  });

  it("warn → pending, queued in the vault with the joined reasons", async () => {
    const outcome = await transfer(FRESH, "0.05", "invoice 8");
    expect(outcome.verdict.decision).toBe("warn");
    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") return;
    expect(outcome.reason).toBe(outcome.verdict.reasons.join("; "));
    const queued = (await vault.getPending()).find((p) => p.id === outcome.id);
    expect(queued).toMatchObject({
      receiver: FRESH,
      amount: parseNearAmount("0.05").toString(),
      memo: "invoice 8",
      reason: outcome.verdict.reasons.join("; "),
    });
  });

  it("allow to a trusted payee → paid with a tx hash; the receiver's balance goes up", async () => {
    const before = await env.balance(TRUSTED);
    const outcome = await transfer(TRUSTED, "0.5", "invoice 9");
    expect(outcome.verdict.decision).toBe("allow");
    expect(outcome.status).toBe("paid");
    if (outcome.status !== "paid") return;
    expect(outcome.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(await env.balance(TRUSTED)).toBe(before + parseNearAmount("0.5"));
    expect(await vault.getSpentToday()).toBe(parseNearAmount("0.5"));
  });

  it("allow, but the vault queues an unknown payee over unknown_payee_max → pending", async () => {
    const before = await env.balance(UNKNOWN);
    const outcome = await transfer(UNKNOWN, "0.2");
    expect(outcome.verdict.decision).toBe("allow");
    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") return;
    expect(outcome.reason).toBe("unknown payee");
    expect((await vault.getPending()).map((p) => p.id)).toContain(outcome.id);
    expect(await env.balance(UNKNOWN)).toBe(before);
  });

  it("receipts: one line per call, and paid receivers become past payees", async () => {
    const lines = receiptLines().map((l) => JSON.parse(l) as { outcome: { status: string }; to: string });
    expect(lines.map((l) => l.outcome.status)).toEqual(["refused", "pending", "paid", "pending"]);
    // Only `paid` receipts feed CheckContext.pastPayees.
    expect(new ReceiptLog(receiptsPath).pastPayees()).toEqual([TRUSTED]);
  });

  it("mainnet: safeTransfer throws MainnetSigningDisabledError and sends nothing", async () => {
    const untouchable: DataSource = new Proxy({} as DataSource, {
      get: () => () => {
        throw new Error("data source must not be used");
      },
    });
    const mainnet = await guardedAgent({
      config: { ...env.config, network: "mainnet" },
      receiptsPath,
      dataSource: untouchable,
    });
    const lines = receiptLines().length;
    const pending = await vault.getPending();
    const spent = await vault.getSpentToday();
    const balance = await env.balance(TRUSTED);
    await expect(mainnet.safeTransfer(TRUSTED, "0.1")).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    await expect(mainnet.report(LOOKALIKE, "scam", "x")).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    const mainnetVault = new VaultClient({ ...env.config, network: "mainnet" });
    await expect(mainnetVault.pay(TRUSTED, 1n, "")).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    await expect(mainnetVault.pause()).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    expect(receiptLines().length).toBe(lines);
    expect(await vault.getPending()).toEqual(pending);
    expect(await vault.getSpentToday()).toBe(spent);
    expect(await env.balance(TRUSTED)).toBe(balance);
  });

  it("owner can approve a pending payment through the VaultClient", async () => {
    const [p] = (await vault.getPending()).filter((x) => x.receiver === UNKNOWN);
    expect(p).toBeDefined();
    const before = await env.balance(UNKNOWN);
    const res = await vault.approve(p!.id);
    expect(res.outcome).toMatchObject({ status: "paid", receiver: UNKNOWN });
    expect(await env.balance(UNKNOWN)).toBe(before + parseNearAmount("0.2"));
  });
});

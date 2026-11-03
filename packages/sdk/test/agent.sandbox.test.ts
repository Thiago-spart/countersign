import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, type DataSource } from "@countersign/core";
import { KeyPair } from "near-api-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  guardedAgent,
  InvalidInputError,
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

  it("a memo over 280 bytes throws InvalidInputError before anything is sent", async () => {
    const lines = receiptLines().length;
    await expect(agent.safeTransfer(TRUSTED, "0.1", "é".repeat(141))).rejects.toBeInstanceOf(InvalidInputError);
    expect(receiptLines().length).toBe(lines);
  });

  it("a missing agent key fails before scoring", async () => {
    let used = 0;
    const untouchable: DataSource = new Proxy({} as DataSource, {
      get: () => () => {
        used++;
        throw new Error("data source must not be used");
      },
    });
    const { agentKey: _omit, ...noKey } = env.config;
    const a = await guardedAgent({ config: noKey, receiptsPath, dataSource: untouchable });
    const lines = receiptLines().length;
    await expect(a.safeTransfer(TRUSTED, "0.1")).rejects.toBeInstanceOf(ConfigError);
    expect(used).toBe(0);
    expect(receiptLines().length).toBe(lines);
  });

  it("a vault call that throws writes one failed receipt and rethrows", async () => {
    const wrongKey = KeyPair.fromRandom("ed25519").toString();
    const a = await guardedAgent({ config: { ...env.config, agentKey: wrongKey }, receiptsPath });
    const lines = receiptLines().length;
    const balance = await env.balance(TRUSTED);
    const err = await a.safeTransfer(TRUSTED, "0.1").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const after = receiptLines();
    expect(after.length).toBe(lines + 1);
    const r = JSON.parse(after.at(-1)!) as { to: string; outcome: { status: string; reason: string } };
    expect(r.to).toBe(TRUSTED);
    expect(r.outcome.status).toBe("failed");
    expect(r.outcome.reason).toMatch(/^send error: /);
    expect(after.at(-1)).not.toContain(wrongKey);
    expect(after.at(-1)).not.toContain(env.config.ownerKey!);
    expect(await env.balance(TRUSTED)).toBe(balance);
  });

  describe("send errors never leak keys", () => {
    afterEach(() => vi.restoreAllMocks());
    const leaky = () => {
      const stray = KeyPair.fromRandom("ed25519");
      const msg = `rpc said ${env.config.agentKey} / ${stray.toString()} / pub ${stray.getPublicKey().toString()}`;
      return { stray, err: new Error(msg) };
    };
    const body = (k: string) => k.slice("ed25519:".length);

    it("redacts the configured key and any secret-shaped key in the receipt and the rethrown error", async () => {
      const { stray, err } = leaky();
      vi.spyOn(VaultClient.prototype, "pay").mockRejectedValue(err);
      const lines = receiptLines().length;
      const thrown = (await agent.safeTransfer(TRUSTED, "0.1").catch((e: unknown) => e)) as Error;
      const after = receiptLines();
      expect(after.length).toBe(lines + 1);
      for (const text of [after.at(-1)!, thrown.message, thrown.stack!.split("\n")[0]!]) {
        expect(text).not.toContain(body(env.config.agentKey!));
        expect(text).not.toContain(body(stray.toString()));
        expect(text).toContain(stray.getPublicKey().toString());
      }
      expect(thrown.cause).toBe(err);
    });

    it("a receipt write failure doesn't mask the send error", async () => {
      const { stray, err } = leaky();
      vi.spyOn(VaultClient.prototype, "pay").mockRejectedValue(err);
      vi.spyOn(ReceiptLog.prototype, "append").mockImplementation(() => {
        throw new Error("disk full");
      });
      const thrown = (await agent.safeTransfer(TRUSTED, "0.1").catch((e: unknown) => e)) as Error;
      expect(thrown.message).toContain("rpc said");
      expect(thrown.message).toContain("disk full");
      expect(thrown.message).not.toContain(body(env.config.agentKey!));
      expect(thrown.message).not.toContain(body(stray.toString()));
    });
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

import { describe, expect, it } from "vitest";
import { a5 } from "../src/scenarios/a5-drip.js";
import { targetsFor, type AttackEnv } from "../src/types.js";

const NEAR = 10n ** 24n;
const EACH = NEAR / 10n;
const DAY_NS = 86_400n * 1_000_000_000n;

/** A fake vault + chain that enforces the daily cap like the contract, for the paths the sandbox can't reach. */
function fakeEnv(o: { spentBefore: bigint; daily?: bigint; midnightAfterCall?: number }): { env: AttackEnv; sent: () => number } {
  const daily = o.daily ?? 5n * NEAR;
  let spent = o.spentBefore;
  let received = 0n;
  let calls = 0;
  let day = 20_000n;
  const ok = (v: unknown) => ({
    transaction_outcome: { id: `tx${calls}` },
    status: { SuccessValue: Buffer.from(JSON.stringify(v)).toString("base64") },
  });
  const provider = {
    viewAccount: async () => ({ amount: 5n * NEAR + received }),
    viewBlock: async () => ({ header: { timestamp_nanosec: (day * DAY_NS + 1n).toString() } }),
  };
  const rawAgentAccount = {
    provider,
    signAndSendTransaction: async () => {
      calls++;
      if (o.midnightAfterCall === calls) day++;
      if (spent + EACH > daily) return ok({ status: "rejected", reason: "over daily cap" });
      spent += EACH;
      received += EACH;
      return ok({ status: "paid", receiver: "x", amount: EACH.toString() });
    },
  };
  const vault = {
    getSpentToday: async () => spent,
    getLimits: async () => ({ daily: daily.toString() }),
    keyAllowance: async () => null,
  };
  const env = {
    rawAgentAccount,
    vault,
    config: { vaultId: "vault.testnet" },
    targets: targetsFor("testnet"),
  } as unknown as AttackEnv;
  return { env, sent: () => calls };
}

describe("A5 on a shared vault", () => {
  it("fresh vault: 50 paid, then 10 rejected", async () => {
    const { env, sent } = fakeEnv({ spentBefore: 0n });
    const r = await a5.run(env);
    expect(r).toMatchObject({ pass: true, actual: "50 paid (5 NEAR), 10 rejected (over daily cap)" });
    expect(sent()).toBe(60);
  });

  it("cap partly used today: expects what is left, then the cap", async () => {
    const { env, sent } = fakeEnv({ spentBefore: 45n * EACH }); // 4.5 NEAR already spent
    const r = await a5.run(env);
    expect(r.pass).toBe(true);
    expect(r.actual).toMatch(/^5 paid \(0\.5 NEAR\), 10 rejected \(over daily cap\) \[expected 5: 4\.5 NEAR already spent today\]$/);
    expect(sent()).toBe(15);
  });

  it("cap fully used today: inconclusive, sends nothing", async () => {
    const { env, sent } = fakeEnv({ spentBefore: 5n * NEAR });
    const r = await a5.run(env);
    expect(r).toMatchObject({ pass: false, inconclusive: true, actual: "inconclusive: daily cap already used today" });
    expect(sent()).toBe(0);
  });

  it("crossing UTC midnight mid-run: inconclusive", async () => {
    const { env } = fakeEnv({ spentBefore: 0n, midnightAfterCall: 30 });
    const r = await a5.run(env);
    expect(r).toMatchObject({ pass: false, inconclusive: true, actual: "inconclusive: crossed UTC midnight, rerun" });
  });
});

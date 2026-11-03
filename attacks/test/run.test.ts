import { describe, expect, it } from "vitest";
import { parseArgs, runAttacks, TestnetNotConfiguredError, type ScenarioResult } from "../src/run.js";

// The whole suite in a local sandbox: the end-to-end test of Countersign (spec §8, §10).
describe("attack suite in the sandbox", () => {
  it("runs all 7 scenarios and every one passes", { timeout: 600_000 }, async () => {
    const run = await runAttacks({ network: "sandbox" });
    const byId = new Map<string, ScenarioResult>(run.results.map((r) => [r.id, r]));

    expect(run.results.map((r) => r.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7"]);
    for (const r of run.results) expect({ id: r.id, pass: r.pass, actual: r.actual }).toMatchObject({ pass: true });
    expect(run.passed).toBe(true);

    // A5: exactly 50 paid, then the daily cap stops the drip.
    expect(byId.get("A5")!.actual).toMatch(/^50 paid \(5 NEAR\), 10 rejected \(over daily cap\)/);
    // A6: three protocol-level rejections.
    expect(byId.get("A6")!.actual.split(";").length).toBe(3);
    // A7: the control case is paid, with a tx hash.
    expect(byId.get("A7")!.actual).toMatch(/^allow \(score \d+\) → paid$/);
    expect(byId.get("A7")!.txHash).toBeTruthy();

    // Nothing printed or saved contains a key.
    const dump = JSON.stringify(run);
    expect(dump).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/);
  });
});

describe("runner flags", () => {
  it("parses --network and --only", () => {
    expect(parseArgs([])).toEqual({ network: "sandbox", only: undefined });
    expect(parseArgs(["--network", "testnet", "--only", "a1,A4"])).toEqual({ network: "testnet", only: ["A1", "A4"] });
    expect(() => parseArgs(["--only", "A9"])).toThrow(/A1..A7/);
    expect(() => parseArgs(["--network", "mainnet"])).toThrow(/sandbox or testnet/);
  });

  it("--network testnet without configured accounts fails clearly, before signing anything", async () => {
    const run = runAttacks({ network: "testnet", env: { COUNTERSIGN_NETWORK: "testnet" } });
    await expect(run).rejects.toBeInstanceOf(TestnetNotConfiguredError);
    await expect(run).rejects.toThrow(/COUNTERSIGN_VAULT_ID.*COUNTERSIGN_AGENT_KEY.*COUNTERSIGN_ATTACK_ROOT/);
  });
});

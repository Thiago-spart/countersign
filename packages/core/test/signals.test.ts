import { describe, expect, it } from "vitest";
import { loadPolicy } from "../src/policy.js";
import { activitySignal } from "../src/signals/activity.js";
import { ageSignal } from "../src/signals/age.js";
import { codeChangeSignal } from "../src/signals/codeChange.js";
import { existsSignal } from "../src/signals/exists.js";
import { firstContactSignal } from "../src/signals/firstContact.js";
import { registrySignal } from "../src/signals/registry.js";
import { IndexerLagError } from "../src/sources/types.js";
import { DAY, ago, ctx, memSource, report } from "./helpers.js";

const policy = loadPolicy();
const T = "target.sandbox";
const HOUR = 3_600_000;

describe("age", () => {
  it.each([
    ["2 hours", 2 * HOUR, 30],
    ["3 days", 3 * DAY, 15],
    ["30 days", 30 * DAY, 0],
  ])("created %s ago -> %i", async (_l, ms, pts) => {
    const ds = memSource({ accounts: { [T]: { createdAt: ago(ms), txCount: 50 } } });
    const s = await ageSignal(T, ds, ctx(), policy);
    expect(s).toMatchObject({ id: "age", status: "ok", points: pts });
  });

  it("hours are rounded, not floored: 1h59m59s reads 2h", async () => {
    const ds = memSource({ accounts: { [T]: { createdAt: ago(2 * HOUR - 1_000), txCount: 50 } } });
    expect((await ageSignal(T, ds, ctx(), policy)).reason).toBe("account created 2h ago (under 1 day)");
  });

  it("createdAt null (genesis) -> 0", async () => {
    const ds = memSource({ accounts: { [T]: { createdAt: null, txCount: 50 } } });
    expect((await ageSignal(T, ds, ctx(), policy)).points).toBe(0);
  });

  it("indexer lag on an account RPC knows -> ok, under-1-day points", async () => {
    const ds = {
      ...memSource({}),
      accountExists: async () => true,
      getAccountInfo: async () => Promise.reject(new IndexerLagError("not indexed", { source: "NearBlocks" })),
    };
    const s = await ageSignal(T, ds, ctx(), policy);
    expect(s).toMatchObject({ status: "ok", points: 30 });
    expect(s.reason).toMatch(/not yet indexed/);
  });

  it("indexer lag on an account RPC doesn't know -> propagates", async () => {
    const ds = {
      ...memSource({}),
      accountExists: async () => false,
      getAccountInfo: async () => Promise.reject(new IndexerLagError("not indexed", { source: "NearBlocks" })),
    };
    await expect(ageSignal(T, ds, ctx(), policy)).rejects.toBeInstanceOf(IndexerLagError);
  });

  it("propagates a source failure (check turns it into unknown)", async () => {
    await expect(ageSignal(T, memSource({}), ctx(), policy)).rejects.toThrow(/no data/);
  });
});

describe("activity", () => {
  it.each([
    [4, 10],
    [5, 0],
  ])("%i transactions -> %i", async (tx, pts) => {
    const ds = memSource({ accounts: { [T]: { createdAt: ago(90 * DAY), txCount: tx } } });
    expect(await activitySignal(T, ds, ctx(), policy)).toMatchObject({ id: "activity", status: "ok", points: pts });
  });
});

describe("code_change", () => {
  it("a contract deployed 2 days ago -> 25", async () => {
    const ds = memSource({ accounts: { [T]: { createdAt: null, txCount: 9, isContract: true, lastDeployAt: ago(2 * DAY) } } });
    expect(await codeChangeSignal(T, ds, ctx(), policy)).toMatchObject({ id: "code_change", status: "ok", points: 25 });
  });

  it("deployed 30 days ago -> 0", async () => {
    const ds = memSource({ accounts: { [T]: { createdAt: null, txCount: 9, isContract: true, lastDeployAt: ago(30 * DAY) } } });
    expect((await codeChangeSignal(T, ds, ctx(), policy)).points).toBe(0);
  });

  it("a non-genesis contract with no indexed deployment -> 25", async () => {
    const ds = memSource({ accounts: { [T]: { createdAt: ago(DAY), txCount: 9, isContract: true, lastDeployAt: null } } });
    const s = await codeChangeSignal(T, ds, ctx(), policy);
    expect(s).toMatchObject({ status: "ok", points: 25, reason: "contract deployment not yet indexed" });
  });

  it("a genesis contract with no deployment record -> 0", async () => {
    const ds = memSource({ accounts: { [T]: { createdAt: null, txCount: 9, isContract: true, lastDeployAt: null } } });
    const s = await codeChangeSignal(T, ds, ctx(), policy);
    expect(s).toMatchObject({ status: "ok", points: 0, reason: "genesis contract with no deployment record" });
  });

  it("a contract with no deployment record whose creation info fails -> 25 (fail closed)", async () => {
    const base = memSource({ accounts: { [T]: { createdAt: null, txCount: 9, isContract: true, lastDeployAt: null } } });
    const ds = { ...base, getAccountInfo: async () => Promise.reject(new IndexerLagError("lag", { source: "NearBlocks" })) };
    expect((await codeChangeSignal(T, ds, ctx(), policy)).points).toBe(25);
  });

  it("not a contract -> 0", async () => {
    const ds = memSource({ accounts: { [T]: { createdAt: null, txCount: 9, isContract: false } } });
    expect((await codeChangeSignal(T, ds, ctx(), policy)).points).toBe(0);
  });
});

describe("registry", () => {
  const credible = { createdAt: ago(40 * DAY), txCount: 20 };

  it("3 reports from credible reporters -> 75", async () => {
    const ds = memSource({
      accounts: { "r1.sandbox": credible, "r2.sandbox": credible, "r3.sandbox": credible },
      reports: { [T]: [report("r1.sandbox"), report("r2.sandbox"), report("r3.sandbox")] },
    });
    expect(await registrySignal(T, ds, ctx(), policy)).toMatchObject({ id: "registry", status: "ok", points: 75 });
  });

  it("one reporter 15 days old with 3 transactions -> 25 x 0.5 x 0.5 = 6.25 -> 6", async () => {
    const ds = memSource({
      accounts: { "r1.sandbox": { createdAt: ago(15 * DAY), txCount: 3 } },
      reports: { [T]: [report("r1.sandbox")] },
    });
    expect((await registrySignal(T, ds, ctx(), policy)).points).toBe(6);
  });

  it("rebutted -> x0.5", async () => {
    const ds = memSource({
      accounts: { "r1.sandbox": credible, "r2.sandbox": credible },
      reports: { [T]: [report("r1.sandbox"), report("r2.sandbox")] },
      rebutted: [T],
    });
    const s = await registrySignal(T, ds, ctx(), policy);
    expect(s.points).toBe(25);
    expect(s.reason).toMatch(/rebut/);
  });

  it("4 credible reports -> capped at 75", async () => {
    const ids = ["r1", "r2", "r3", "r4"].map((r) => `${r}.sandbox`);
    const ds = memSource({
      accounts: Object.fromEntries(ids.map((id) => [id, credible])),
      reports: { [T]: ids.map((id) => report(id)) },
    });
    expect((await registrySignal(T, ds, ctx(), policy)).points).toBe(75);
  });

  it("a genesis reporter (createdAt null) is fully aged", async () => {
    const ds = memSource({
      accounts: { "near": { createdAt: null, txCount: 100 } },
      reports: { [T]: [report("near")] },
    });
    expect((await registrySignal(T, ds, ctx(), policy)).points).toBe(25);
  });

  it("1 credible reporter (25 > unknownPoints) + 1 failed lookup -> ok, partial, naming the reporter", async () => {
    const ds = memSource({
      accounts: { "r1.sandbox": credible },
      reports: { [T]: [report("r1.sandbox"), report("ghost.sandbox")] },
    });
    const s = await registrySignal(T, ds, ctx(), policy);
    expect(s).toMatchObject({ status: "ok", points: 25 });
    expect(s.reason).toContain("ghost.sandbox");
    expect(s.data).toMatchObject({ points: 25, partial: true, unverifiedReporters: ["ghost.sandbox"] });
  });

  it("all reporter lookups fail -> unknown", async () => {
    const ds = memSource({ reports: { [T]: [report("ghost1.sandbox"), report("ghost2.sandbox")] } });
    const s = await registrySignal(T, ds, ctx(), policy);
    expect(s.status).toBe("unknown");
    expect(s.data).toMatchObject({ points: 0, partial: false });
  });

  it("3 credible reporters + 1 failed lookup -> ok, partial, 75", async () => {
    const ds = memSource({
      accounts: { "r1.sandbox": credible, "r2.sandbox": credible, "r3.sandbox": credible },
      reports: { [T]: ["r1", "r2", "r3", "ghost"].map((r) => report(`${r}.sandbox`)) },
    });
    const s = await registrySignal(T, ds, ctx(), policy);
    expect(s).toMatchObject({ status: "ok", points: 75, data: { partial: true, unverifiedReporters: ["ghost.sandbox"] } });
    expect(s.reason).toContain("ghost.sandbox");
  });

  it("1 weak verified reporter (6 points) + 1 failed lookup -> unknown", async () => {
    const ds = memSource({
      accounts: { "r1.sandbox": { createdAt: ago(15 * DAY), txCount: 3 } },
      reports: { [T]: [report("r1.sandbox"), report("ghost.sandbox")] },
    });
    const s = await registrySignal(T, ds, ctx(), policy);
    expect(s.status).toBe("unknown");
    expect(s.data).toMatchObject({ points: 6, partial: false });
  });

  it("no reports -> 0", async () => {
    const s = await registrySignal(T, memSource({}), ctx(), policy);
    expect(s).toMatchObject({ status: "ok", points: 0 });
  });

  it("getReports failing propagates (check turns it into unknown)", async () => {
    const ds = { ...memSource({}), getReports: async () => Promise.reject(new Error("registry down")) };
    await expect(registrySignal(T, ds, ctx(), policy)).rejects.toThrow("registry down");
  });
});

describe("first_contact", () => {
  it("a target in pastPayees -> 0", () => {
    expect(firstContactSignal(T, ctx({ pastPayees: [T] }), policy)).toMatchObject({ id: "first_contact", points: 0 });
  });
  it("otherwise -> 5", () => {
    expect(firstContactSignal(T, ctx({ pastPayees: ["other.sandbox"] }), policy)).toMatchObject({ points: 5 });
  });
});

describe("exists", () => {
  it("exists: false -> data.exists === false", async () => {
    const ds = memSource({ accounts: { [T]: { exists: false, createdAt: null, txCount: 0 } } });
    const s = await existsSignal(T, ds, ctx(), policy);
    expect(s).toMatchObject({ id: "exists", status: "ok", points: 0 });
    expect((s.data as { exists: boolean }).exists).toBe(false);
  });

  it("exists: true -> data.exists === true", async () => {
    const ds = memSource({ accounts: { [T]: { createdAt: null, txCount: 0 } } });
    expect((await existsSignal(T, ds, ctx(), policy)).data).toEqual({ exists: true });
  });

  it("an invalid account ID does not exist, without asking the source", async () => {
    let asked = false;
    const ds = { ...memSource({}), accountExists: async () => ((asked = true), true) };
    const s = await existsSignal("Bad..ID!", ds, ctx(), policy);
    expect((s.data as { exists: boolean }).exists).toBe(false);
    expect(asked).toBe(false);
  });
});

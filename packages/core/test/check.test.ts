import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { loadPolicy } from "../src/policy.js";
import { SourceUnavailableError, type DataSource } from "../src/sources/types.js";
import { DAY, ago, ctx, memSource, report } from "./helpers.js";

const policy = loadPolicy();
const HOUR = 3_600_000;
const aged = { createdAt: ago(200 * DAY), txCount: 300 };
const fresh = { createdAt: ago(2 * HOUR), txCount: 1 };

const ids = (v: { signals: { id: string }[] }) => v.signals.map((s) => s.id);

describe("check", () => {
  it("missing account blocks", async () => {
    const ds = memSource({ accounts: { "typo.sandbox": { exists: false, createdAt: null, txCount: 0 } } });
    const v = await check("typo.sandbox", ctx(), ds, policy);
    expect(v.decision).toBe("block");
    expect(v.score).toBe(100);
    expect(v.reasons[0]).toBe("account does not exist");
  });

  it("an invalid account ID blocks as missing", async () => {
    const v = await check("not an account", ctx(), memSource({}), policy);
    expect(v.decision).toBe("block");
    expect(v.reasons[0]).toBe("account does not exist");
  });

  it("a trusted target skips lookalike, first_contact and age but keeps registry", async () => {
    const t = "acme-corp.sandbox";
    const ds = memSource({ accounts: { [t]: fresh } });
    const v = await check(t, ctx({ trusted: [t] }), ds, policy);
    expect(ids(v)).not.toContain("lookalike");
    expect(ids(v)).not.toContain("first_contact");
    expect(ids(v)).not.toContain("age");
    expect(ids(v)).toEqual(expect.arrayContaining(["exists", "registry", "activity", "code_change"]));
  });

  it("all sources failing yields warn", async () => {
    const fail = async (): Promise<never> => {
      throw new SourceUnavailableError("HTTP 429", { source: "NearBlocks" });
    };
    const ds: DataSource = {
      accountExists: fail,
      getAccountInfo: fail,
      getCodeInfo: fail,
      getReports: fail,
      getRebutted: fail,
    };
    const v = await check("someone.sandbox", ctx(), ds, policy);
    expect(v.decision).toBe("warn");
    expect(v.score).toBeGreaterThanOrEqual(40);
    expect(v.score).toBeLessThanOrEqual(69);
    const unknown = v.signals.filter((s) => s.status === "unknown").map((s) => s.id);
    expect(unknown.sort()).toEqual(["activity", "age", "code_change", "exists", "registry"]);
    for (const s of v.signals.filter((x) => x.status === "unknown")) expect(s.reason).toMatch(/NearBlocks/);
  });

  it("non-SourceUnavailable errors (bugs, bad JSON) also fail closed", async () => {
    const ds: DataSource = {
      ...memSource({}),
      accountExists: async () => true,
      getAccountInfo: async () => {
        throw new TypeError("x is undefined");
      },
    };
    const v = await check("someone.sandbox", ctx(), ds, policy);
    expect(v.signals.find((s) => s.id === "age")?.status).toBe("unknown");
    expect(v.decision).not.toBe("allow");
  });

  it("fetches account info once for age and activity", async () => {
    let n = 0;
    const base = memSource({ accounts: { "x.sandbox": aged } });
    const ds: DataSource = { ...base, getAccountInfo: (id) => (n++, base.getAccountInfo(id)) };
    await check("x.sandbox", ctx(), ds, policy);
    expect(n).toBe(1);
  });

  describe("NearBlocks-only outage (RPC healthy) never allows", () => {
    // RPC answers (exists, code hash); every NearBlocks-backed call (account info) fails.
    const outage = (base: DataSource): DataSource => ({
      ...base,
      accountExists: async () => true,
      getAccountInfo: async () => Promise.reject(new SourceUnavailableError("HTTP 429", { source: "NearBlocks" })),
    });

    it("a fresh account", async () => {
      const ds = outage(memSource({ accounts: { "fresh.sandbox": fresh } }));
      const v = await check("fresh.sandbox", ctx(), ds, policy);
      expect(v.decision).toBe("warn");
      expect(v.score).toBeGreaterThanOrEqual(policy.thresholds.warn);
      expect(v.reasons).toContain("some data sources were unavailable");
    });

    it("a target with 3 reports whose reporter lookups all fail", async () => {
      const ds = outage(
        memSource({
          accounts: { "bad.sandbox": aged },
          reports: { "bad.sandbox": [report("r1.sandbox"), report("r2.sandbox"), report("r3.sandbox")] },
        }),
      );
      const v = await check("bad.sandbox", ctx({ pastPayees: ["bad.sandbox"] }), ds, policy);
      expect(v.signals.find((s) => s.id === "registry")?.status).toBe("unknown");
      expect(v.decision).not.toBe("allow");
      expect(v.score).toBeGreaterThanOrEqual(policy.thresholds.warn);
    });

    it("does not touch a verdict that is already warn or block", async () => {
      const ds = outage(memSource({ accounts: { "acme-c0rp.sandbox": fresh } }));
      const v = await check("acme-c0rp.sandbox", ctx({ trusted: ["acme-corp.sandbox"] }), ds, policy);
      expect(v.reasons).not.toContain("some data sources were unavailable");
    });
  });

  describe("partial registry failure", () => {
    const credible = { createdAt: ago(40 * DAY), txCount: 20 };
    const withGhost = (reporters: Record<string, { createdAt: Date; txCount: number }>) =>
      memSource({
        accounts: { "bad.sandbox": aged, ...reporters },
        reports: { "bad.sandbox": [...Object.keys(reporters), "ghost.sandbox"].map((r) => report(r)) },
      });

    it("3 credible reporters + 1 failed lookup -> block", async () => {
      const ds = withGhost({ "r1.sandbox": credible, "r2.sandbox": credible, "r3.sandbox": credible });
      const v = await check("bad.sandbox", ctx(), ds, policy);
      expect(v.score).toBe(80);
      expect(v.decision).toBe("block");
    });

    it("1 weak verified reporter + 1 failed lookup -> unknown -> warn floor", async () => {
      const ds = withGhost({ "r1.sandbox": { createdAt: ago(15 * DAY), txCount: 3 } });
      const v = await check("bad.sandbox", ctx({ pastPayees: ["bad.sandbox"] }), ds, policy);
      expect(v.signals.find((s) => s.id === "registry")?.status).toBe("unknown");
      expect(v.decision).toBe("warn");
      expect(v.reasons).toContain("some data sources were unavailable");
    });

    it("a partial ok registry below warn is floored at warn", async () => {
      const ds = withGhost({ "r1.sandbox": credible });
      const v = await check("bad.sandbox", ctx({ pastPayees: ["bad.sandbox"] }), ds, policy);
      expect(v.signals.find((s) => s.id === "registry")).toMatchObject({ status: "ok", points: 25 });
      expect(v.decision).toBe("warn");
      expect(v.score).toBe(30);
      expect(v.reasons).toContain("some data sources were unavailable");
    });
  });

  describe("scenario values", () => {
    it("a fresh lookalike -> block", async () => {
      const ds = memSource({ accounts: { "acme-c0rp.sandbox": fresh } });
      const v = await check("acme-c0rp.sandbox", ctx({ trusted: ["acme-corp.sandbox"] }), ds, policy);
      expect(v.decision).toBe("block");
      expect(v.reasons.join("\n")).toContain("acme-corp.sandbox");
    });

    it("a fresh unknown account -> warn (30+10+5 = 45)", async () => {
      const ds = memSource({ accounts: { "newbie.sandbox": fresh } });
      const v = await check("newbie.sandbox", ctx(), ds, policy);
      expect(v.score).toBe(45);
      expect(v.decision).toBe("warn");
    });

    it("a credible account with 3 reports -> block (75+5)", async () => {
      const credible = { createdAt: ago(40 * DAY), txCount: 20 };
      const ds = memSource({
        accounts: { "bad.sandbox": aged, "r1.sandbox": credible, "r2.sandbox": credible, "r3.sandbox": credible },
        reports: { "bad.sandbox": [report("r1.sandbox"), report("r2.sandbox"), report("r3.sandbox")] },
      });
      const v = await check("bad.sandbox", ctx(), ds, policy);
      expect(v.score).toBe(80);
      expect(v.decision).toBe("block");
    });

    it("a trusted active payee -> allow", async () => {
      const t = "acme-corp.sandbox";
      const ds = memSource({ accounts: { [t]: aged } });
      const v = await check(t, ctx({ trusted: [t], pastPayees: [t] }), ds, policy);
      expect(v.decision).toBe("allow");
      expect(v.score).toBe(0);
    });
  });
});

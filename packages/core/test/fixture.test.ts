import { describe, expect, it } from "vitest";
import { FixtureSource, loadFixtures } from "../src/sources/fixture.js";
import { SourceUnavailableError } from "../src/sources/types.js";
import { DAY, NOW } from "./helpers.js";

const now = () => NOW;

describe("FixtureSource", () => {
  const fx = new FixtureSource(
    {
      accounts: {
        "fresh.sandbox": { createdAt: "-2h", txCount: 1 },
        "old.sandbox": { createdAt: "2025-01-01T00:00:00Z", txCount: 40, isContract: true, lastDeployAt: "-2d" },
        "genesis.sandbox": { createdAt: null, txCount: 9 },
        "gone.sandbox": { exists: false },
      },
    },
    now,
  );

  it("resolves relative and absolute times", async () => {
    expect((await fx.getAccountInfo("fresh.sandbox")).createdAt).toEqual(new Date(NOW.getTime() - 2 * 3_600_000));
    expect((await fx.getAccountInfo("old.sandbox")).createdAt).toEqual(new Date("2025-01-01T00:00:00Z"));
    expect(await fx.getCodeInfo("old.sandbox")).toEqual({ isContract: true, lastDeployAt: new Date(NOW.getTime() - 2 * DAY) });
    expect((await fx.getAccountInfo("genesis.sandbox")).createdAt).toBeNull();
  });

  it("resolves every relative time against one clock read at construction", async () => {
    let t = NOW.getTime();
    const ticking = () => new Date((t += 5));
    const src = new FixtureSource({ accounts: { "fresh.sandbox": { createdAt: "-2h", txCount: 1 } } }, ticking);
    const first = (await src.getAccountInfo("fresh.sandbox")).createdAt;
    const second = (await src.getAccountInfo("fresh.sandbox")).createdAt;
    expect(first).toEqual(new Date(NOW.getTime() + 5 - 2 * 3_600_000));
    expect(second).toEqual(first);
  });

  it("accountExists comes from the fixture data; unlisted accounts do not exist", async () => {
    expect(await fx.accountExists("fresh.sandbox")).toBe(true);
    expect(await fx.accountExists("gone.sandbox")).toBe(false);
    expect(await fx.accountExists("unlisted.sandbox")).toBe(false);
  });

  it("account info for an unlisted account -> SourceUnavailableError", async () => {
    await expect(fx.getAccountInfo("unlisted.sandbox")).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it("reports default to none", async () => {
    expect(await fx.getReports("fresh.sandbox")).toEqual([]);
    expect(await fx.getRebutted("fresh.sandbox")).toBe(false);
  });

  it("rejects a bad time string at load", () => {
    expect(() => new FixtureSource({ accounts: { "x.sandbox": { createdAt: "yesterday", txCount: 1 } } }, now)).toThrow(
      /x\.sandbox/,
    );
  });

  it("the repo's fixtures/sandbox.json loads", () => {
    const data = loadFixtures();
    expect(Object.keys(data.accounts).length).toBeGreaterThan(0);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lookalikeSignal, normalizeLabel } from "../src/signals/lookalike.js";
import { loadPolicy } from "../src/policy.js";
import type { CheckContext } from "../src/types.js";

const policy = loadPolicy();
const ctx = (trusted: string[], pastPayees: string[] = []): CheckContext => ({
  network: "sandbox",
  vaultId: "vault.test.near",
  trusted,
  pastPayees,
  now: new Date("2026-11-03T00:00:00Z"),
});
const TRUSTED = ["acme-corp.testnet"];

describe("normalizeLabel", () => {
  it("lowercases and applies the homoglyph map", () => {
    expect(normalizeLabel("ACME-C0RP")).toBe("acme-corp");
    expect(normalizeLabel("acrne")).toBe("acme");
    expect(normalizeLabel("vvhale")).toBe("whale");
    expect(normalizeLabel("b3t5")).toBe("bets");
    expect(normalizeLabel("1ion")).toBe("lion");
  });
});

describe("lookalikeSignal", () => {
  it("flags 0-for-o", () => {
    const s = lookalikeSignal("acme-c0rp.testnet", ctx(TRUSTED), policy);
    expect(s.id).toBe("lookalike");
    expect(s.status).toBe("ok");
    expect(s.points).toBe(45);
    expect(s.reason).toContain("acme-corp.testnet");
    expect(s.data).toEqual({ matchedWith: "acme-corp.testnet", distance: 0 });
  });
  it("flags same label under another parent", () => {
    expect(lookalikeSignal("acme-corp.evil.testnet", ctx(TRUSTED), policy).points).toBe(45);
  });
  it("flags rn-for-m", () => {
    expect(lookalikeSignal("acrne-corp.testnet", ctx(TRUSTED), policy).points).toBe(45);
  });
  it("flags a transposition", () => {
    const s = lookalikeSignal("acme-crop.testnet", ctx(TRUSTED), policy);
    expect(s.points).toBe(45);
    expect((s.data as { distance: number }).distance).toBe(1);
  });
  it("skips a trusted target", () => {
    expect(lookalikeSignal("acme-corp.testnet", ctx(TRUSTED), policy).points).toBe(0);
  });
  it("short labels do not fuzzy-match", () => {
    expect(lookalikeSignal("rob.testnet", ctx(["bob.testnet"]), policy).points).toBe(0);
    expect(lookalikeSignal("b0b.testnet", ctx(["bob.testnet"]), policy).points).toBe(45);
  });
  it("ignores unrelated accounts", () => {
    const s = lookalikeSignal("zebra-foods.testnet", ctx(TRUSTED), policy);
    expect(s.points).toBe(0);
    expect(s.status).toBe("ok");
  });
  it("matches past payees too", () => {
    expect(lookalikeSignal("acme-c0rp.testnet", ctx([], TRUSTED), policy).points).toBe(45);
  });
  it("reports the closest match", () => {
    const s = lookalikeSignal("acme-corp.evil.testnet", ctx(["acme-corq.testnet", "acme-corp.testnet"]), policy);
    expect((s.data as { matchedWith: string }).matchedWith).toBe("acme-corp.testnet");
  });
});

interface Case {
  target: string;
  trusted: string[];
  pastPayees: string[];
  match: boolean;
  note: string;
}
const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/lookalike-corpus.json", import.meta.url)), "utf8"),
).cases as Case[];

describe("lookalike corpus", () => {
  it("has at least 15 positives and 15 negatives", () => {
    expect(corpus.filter((c) => c.match).length).toBeGreaterThanOrEqual(15);
    expect(corpus.filter((c) => !c.match).length).toBeGreaterThanOrEqual(15);
  });
  it.each(corpus.map((c) => [`${c.match ? "match" : "no match"}: ${c.target} (${c.note})`, c] as const))(
    "%s",
    (_name, c) => {
      const s = lookalikeSignal(c.target, ctx(c.trusted, c.pastPayees), policy);
      expect(s.points).toBe(c.match ? policy.lookalike.points : 0);
    },
  );
});

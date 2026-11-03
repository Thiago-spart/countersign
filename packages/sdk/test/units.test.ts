import { describe, expect, it } from "vitest";
import { truncateBytes } from "../src/agent.js";
import { parseOutcome } from "../src/vaultClient.js";

describe("truncateBytes", () => {
  it("cuts a multibyte string over 280 bytes to ≤ 280 bytes without splitting a character", () => {
    const reasons = Array.from({ length: 40 }, (_, i) => `réason ${i} — 账户 🚩`).join("; ");
    expect(Buffer.byteLength(reasons, "utf8")).toBeGreaterThan(280);
    const out = truncateBytes(reasons, 280);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(280);
    expect(out).not.toContain("�");
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
    expect(out.endsWith("…")).toBe(true);
    expect(reasons.startsWith(out.slice(0, -1))).toBe(true);
    // No lone surrogate (a split emoji).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });

  it("leaves short strings alone", () => {
    expect(truncateBytes("ok 🚩", 280)).toBe("ok 🚩");
  });
});

describe("parseOutcome", () => {
  it("accepts well-formed PayOutcomes", () => {
    for (const o of [
      { status: "paid", receiver: "a.near", amount: "1" },
      { status: "pending", id: "3", reason: "unknown payee" },
      { status: "rejected", reason: "paused" },
      { status: "failed", reason: "transfer failed" },
    ]) {
      expect(parseOutcome(o, "pay")).toEqual(o);
    }
  });

  it("maps malformed values to failed", () => {
    for (const bad of [
      undefined,
      null,
      "paid",
      { status: "paid" },
      { status: "paid", receiver: "a.near" },
      { status: "pending", id: "3" },
      { status: "pending", reason: "x" },
      { status: "pending", id: 3, reason: "x" },
      { status: "rejected" },
      { status: "failed", reason: 1 },
      { status: "weird", reason: "x" },
    ]) {
      const o = parseOutcome(bad, "pay");
      expect(o.status, JSON.stringify(bad)).toBe("failed");
      expect((o as { reason: string }).reason).toMatch(/unexpected pay result/);
    }
  });
});

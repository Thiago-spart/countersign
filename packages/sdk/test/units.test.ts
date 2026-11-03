import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { truncateBytes } from "../src/agent.js";
import { parseOutcome } from "../src/vaultClient.js";
import { redactSecrets, redactError } from "../src/index.js";
import { KeyPair } from "near-api-js";

describe("redactSecrets / redactError", () => {
  const configured = KeyPair.fromRandom("ed25519").toString();
  const other = KeyPair.fromRandom("ed25519");
  const otherSecret = other.toString();
  const pub = other.getPublicKey().toString();
  const body = configured.slice("ed25519:".length);

  it("redacts configured keys (with or without prefix) and any secret-key-shaped string; keeps public keys", () => {
    const text = `key ${configured} body ${body} other ${otherSecret} pub ${pub}`;
    const out = redactSecrets(text, [configured, undefined]);
    expect(out).not.toContain(body);
    expect(out).not.toContain(otherSecret.slice(8));
    expect(out).toContain(pub);
    expect(out).toContain("[redacted]");
  });

  it("redactError keeps the name, redacts message and stack, keeps a redacted copy of the original as cause", () => {
    const orig = new TypeError(`bad ${configured} and ${otherSecret}`);
    const e = redactError(orig, [configured]);
    expect(e.name).toBe("TypeError");
    expect(e.message).not.toContain(body);
    expect(e.message).not.toContain(otherSecret.slice(8));
    expect(e.stack?.split("\n")[0]).not.toContain(body);
    expect(e.cause).not.toBe(orig);
    expect((e.cause as Error).message).toBe(e.message);
  });

  it("redacts the whole cause chain and caps its depth", () => {
    let err: Error = new Error(`root ${otherSecret}`);
    for (let i = 0; i < 8; i++) err = new Error(`level ${i} ${configured}`, { cause: err });
    const e = redactError(err, [configured]);
    const text = inspect(e, { depth: 20 });
    expect(text).not.toContain(body);
    expect(text).not.toContain(otherSecret.slice(8));
    let depth = 0;
    for (let c: unknown = e.cause; c !== undefined; c = (c as Error).cause) {
      expect(c).toBeInstanceOf(Error);
      depth++;
    }
    expect(depth).toBe(5);
  });
});

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

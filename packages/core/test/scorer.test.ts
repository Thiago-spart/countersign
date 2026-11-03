import { describe, expect, it } from "vitest";
import { loadPolicy } from "../src/policy.js";
import { scoreSignals } from "../src/scorer.js";
import type { Signal, SignalId } from "../src/types.js";

const policy = loadPolicy();
const T = "bob.near";
const sig = (id: SignalId, points: number, extra: Partial<Signal> = {}): Signal => ({
  id,
  status: "ok",
  points,
  reason: `${id} reason`,
  ...extra,
});

describe("scoreSignals thresholds", () => {
  it.each([
    [29, "allow"],
    [30, "warn"],
    [69, "warn"],
    [70, "block"],
  ] as const)("%i points -> %s", (pts, decision) => {
    const v = scoreSignals(T, [sig("registry", pts)], policy);
    expect(v.score).toBe(pts);
    expect(v.decision).toBe(decision);
    expect(v.target).toBe(T);
  });

  it("caps at 100", () => {
    const v = scoreSignals(T, [sig("registry", 140)], policy);
    expect(v.score).toBe(100);
    expect(v.decision).toBe("block");
  });

  it("rounds each signal's points to an integer", () => {
    const v = scoreSignals(T, [sig("registry", 12.5), sig("age", 12.4)], policy);
    expect(v.score).toBe(13 + 12);
  });
});

describe("unknown signals", () => {
  it("adds unknownPoints whatever points says", () => {
    const v = scoreSignals(T, [sig("age", 99, { status: "unknown" })], policy);
    expect(v.score).toBe(10);
  });

  it("four unknown network signals -> 40, warn", () => {
    const v = scoreSignals(
      T,
      (["age", "activity", "code_change", "registry"] as const).map((id) =>
        sig(id, 0, { status: "unknown" }),
      ),
      policy,
    );
    expect(v.score).toBe(40);
    expect(v.decision).toBe("warn");
  });

  it("unknown exists adds 0", () => {
    const v = scoreSignals(T, [sig("exists", 0, { status: "unknown" })], policy);
    expect(v.score).toBe(0);
    expect(v.decision).toBe("allow");
    expect(v.reasons).toEqual([]);
  });
});

describe("exists", () => {
  it("exists:false blocks with score 100 whatever else is present", () => {
    const v = scoreSignals(
      T,
      [sig("exists", 0, { data: { exists: false } }), sig("age", 0)],
      policy,
    );
    expect(v.decision).toBe("block");
    expect(v.score).toBe(100);
    expect(v.reasons).toContain("account does not exist");
  });

  it("exists:true adds nothing", () => {
    const v = scoreSignals(T, [sig("exists", 0, { data: { exists: true } })], policy);
    expect(v.score).toBe(0);
    expect(v.decision).toBe("allow");
  });
});

describe("reasons", () => {
  it("lists only signals with points > 0, in order received", () => {
    const signals = [
      sig("age", 15),
      sig("activity", 0),
      sig("first_contact", 5),
      sig("registry", 0, { status: "unknown" }),
    ];
    const v = scoreSignals(T, signals, policy);
    expect(v.reasons).toEqual(["age reason", "first_contact reason", "registry reason"]);
    expect(v.signals).toEqual(signals);
  });
});

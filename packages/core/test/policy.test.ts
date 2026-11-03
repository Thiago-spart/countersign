import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "../src/policy.js";

const repoPolicyPath = new URL("../../../policy.json", import.meta.url);
const raw = () => JSON.parse(readFileSync(repoPolicyPath, "utf8"));

function writeTmp(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cs-policy-"));
  const p = join(dir, "policy.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("loadPolicy", () => {
  it("parses the repo policy.json from any cwd", () => {
    const p = loadPolicy();
    expect(p.thresholds).toEqual({ warn: 30, block: 70 });
    expect(p.unknownPoints).toBe(10);
    expect(p.registry.cap).toBe(75);
    expect(p.trustedSkips).toEqual(["lookalike", "first_contact", "age"]);
  });

  it("throws when thresholds.warn >= thresholds.block", () => {
    const bad = raw();
    bad.thresholds = { warn: 70, block: 70 };
    expect(() => loadPolicy(writeTmp(bad))).toThrow(/warn/);
    bad.thresholds = { warn: 80, block: 70 };
    expect(() => loadPolicy(writeTmp(bad))).toThrow(/warn/);
  });

  it("throws an error naming the missing key", () => {
    const bad = raw();
    delete bad.registry.perReport;
    expect(() => loadPolicy(writeTmp(bad))).toThrow(/perReport/);
    const bad2 = raw();
    delete bad2.unknownPoints;
    expect(() => loadPolicy(writeTmp(bad2))).toThrow(/unknownPoints/);
  });
});

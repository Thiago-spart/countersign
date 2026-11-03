import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPrebuiltContracts, startSandbox } from "../src/sandbox.js";

const MSG = /prebuilt contracts missing at contracts\/res\/ .*run `pnpm build:contracts` \(needs Rust\)/;

describe("prebuilt contracts check", () => {
  it("missing wasm -> clear error before the sandbox starts", async () => {
    const empty = mkdtempSync(join(tmpdir(), "countersign-res-"));
    expect(() => assertPrebuiltContracts(empty)).toThrow(MSG);
    await expect(startSandbox({ contractsDir: empty })).rejects.toThrow(MSG);
  });

  it("names the file that is missing", () => {
    const half = mkdtempSync(join(tmpdir(), "countersign-res-"));
    writeFileSync(join(half, "registry.wasm"), "");
    expect(() => assertPrebuiltContracts(half)).toThrow(/vault\.wasm not found/);
  });

  it("the repo's contracts/res passes", () => {
    expect(() => assertPrebuiltContracts()).not.toThrow();
  });
});

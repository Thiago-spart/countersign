import { describe, expect, it } from "vitest";
import { InvalidAmountError, parseNearAmount } from "../src/index.js";

describe("parseNearAmount", () => {
  it("converts decimal NEAR to yoctoNEAR", () => {
    expect(parseNearAmount("0.1")).toBe(10n ** 23n);
    expect(parseNearAmount("1")).toBe(10n ** 24n);
    expect(parseNearAmount("2.5")).toBe(25n * 10n ** 23n);
    expect(parseNearAmount("0.000000000000000000000001")).toBe(1n);
    expect(parseNearAmount(" 1.0 ")).toBe(10n ** 24n);
  });

  it("parseNearAmount rejects zero, negatives, garbage, exponents, empty and >24 decimals", () => {
    for (const bad of ["0", "0.0", "-1", "abc", "1e3", "", " ", ".5", "1.", "1,5", "+1", "0x10", "Infinity",
      "0.0000000000000000000000001"]) {
      expect(() => parseNearAmount(bad), JSON.stringify(bad)).toThrow(InvalidAmountError);
    }
  });
});

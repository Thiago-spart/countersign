import { InvalidAmountError } from "./errors.js";

const YOCTO_DECIMALS = 24;
const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** Decimal NEAR (e.g. "0.1") → yoctoNEAR. Rejects zero, signs, exponents, and more than 24 decimals. */
export function parseNearAmount(input: string): bigint {
  const m = DECIMAL_RE.exec(input.trim());
  if (!m) throw new InvalidAmountError(input);
  const [, whole, frac = ""] = m;
  if (frac.length > YOCTO_DECIMALS) throw new InvalidAmountError(input);
  const yocto = BigInt(whole!) * 10n ** BigInt(YOCTO_DECIMALS) + BigInt(frac.padEnd(YOCTO_DECIMALS, "0"));
  if (yocto <= 0n) throw new InvalidAmountError(input);
  return yocto;
}

/** yoctoNEAR → decimal NEAR string without trailing zeros ("0.1", "2"). */
export function formatNear(yocto: bigint): string {
  const neg = yocto < 0n;
  const abs = neg ? -yocto : yocto;
  const base = 10n ** BigInt(YOCTO_DECIMALS);
  const frac = (abs % base).toString().padStart(YOCTO_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / base}${frac ? `.${frac}` : ""}`;
}

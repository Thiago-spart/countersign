/** Thrown before any transaction is built or signed when the network is mainnet (mainnet is read-only). */
export class MainnetSigningDisabledError extends Error {
  constructor(what = "signing") {
    super(`${what} is disabled on mainnet: Countersign v1 only signs on sandbox and testnet`);
    this.name = "MainnetSigningDisabledError";
  }
}

/** The amount string is not a positive decimal NEAR amount with at most 24 decimal places. */
export class InvalidAmountError extends Error {
  constructor(readonly input: string) {
    super(`invalid NEAR amount ${JSON.stringify(input)}: expected a positive decimal like "0.5" (at most 24 decimals)`);
    this.name = "InvalidAmountError";
  }
}

/** An input other than the amount is invalid (e.g. a memo over 280 bytes). Nothing was scored or sent. */
export class InvalidInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`invalid ${field}: ${message}`);
    this.name = "InvalidInputError";
  }
}

const REDACTED = "[redacted]";
/** Secret keys are ~88 base58 chars after the prefix; public keys (~44) stay visible. */
const SECRET_KEY_RE = /(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{80,}/g;

/**
 * Remove private keys from text: any secret-key-shaped string, plus each given key in full and
 * as its bare base58 body (without the `ed25519:` prefix). Use before printing or logging errors.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text.replace(SECRET_KEY_RE, REDACTED);
  for (const s of secrets) {
    if (!s) continue;
    const bare = s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
    for (const needle of [s, bare]) if (needle) out = out.split(needle).join(REDACTED);
  }
  return out;
}

/**
 * A copy of `err` safe to print: same name, redacted message (and so a redacted stack header),
 * original kept as `cause`.
 */
export function redactError(err: unknown, secrets: readonly (string | undefined)[] = []): Error {
  const name = err instanceof Error ? err.name : "Error";
  const message = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
  const safe = new Error(message, { cause: err });
  safe.name = name;
  safe.stack = `${name}: ${message}\n${(safe.stack ?? "").split("\n").slice(1).join("\n")}`;
  return safe;
}

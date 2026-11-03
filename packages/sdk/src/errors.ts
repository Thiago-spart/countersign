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

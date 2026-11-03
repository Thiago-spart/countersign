/** A data source could not answer (network error, rate limit, indexer lag, bad response). Fail closed. */
export class SourceUnavailableError extends Error {
  /** Which source failed, e.g. "NearBlocks", "RPC", "registry", "fixture". Used in signal reasons. */
  readonly source: string;
  constructor(message: string, opts: { source?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "SourceUnavailableError";
    this.source = opts.source ?? "data source";
  }
}

export interface AccountInfo {
  exists: boolean;
  /** null = created at genesis. */
  createdAt: Date | null;
  txCount: number;
}

export interface CodeInfo {
  isContract: boolean;
  lastDeployAt: Date | null;
}

export interface RegistryReport {
  reporter: string;
  category: string;
  txHash: string | null;
  note: string;
  createdAt: Date;
}

export interface DataSource {
  /** R2: backed by RPC view_account. UNKNOWN_ACCOUNT → false; other failures throw SourceUnavailableError. */
  accountExists(id: string): Promise<boolean>;
  /** Creation time and tx count (NearBlocks). Throws SourceUnavailableError, including on indexer lag. */
  getAccountInfo(id: string): Promise<AccountInfo>;
  getCodeInfo(id: string): Promise<CodeInfo>;
  getReports(target: string): Promise<RegistryReport[]>;
  getRebutted(target: string): Promise<boolean>;
}

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/** NEAR timestamps are nanoseconds; NearBlocks sends them as strings or (lossy) JSON numbers. */
export function nsToDate(ns: unknown): Date | null {
  if (ns === null || ns === undefined) return null;
  let ms: number;
  if (typeof ns === "string" && /^\d+$/.test(ns)) ms = Number(BigInt(ns) / 1_000_000n);
  else if (typeof ns === "number" && Number.isFinite(ns) && ns >= 0) ms = Math.floor(ns / 1_000_000);
  else throw new TypeError(`bad nanosecond timestamp: ${JSON.stringify(ns)}`);
  return new Date(ms);
}

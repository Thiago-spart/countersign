import { DiskCache } from "./cache.js";
import { fetchJson, type HttpOpts } from "./http.js";
import { IndexerLagError, SourceUnavailableError, nsToDate, type AccountInfo } from "./types.js";

const SOURCE = "NearBlocks";

export interface NearBlocksOpts extends HttpOpts {
  baseUrl: string;
  /** Sent as `Authorization: Bearer` only when set. */
  apiKey?: string;
  cache?: DiskCache;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const bad = (what: string, cause?: unknown) =>
  new SourceUnavailableError(`${SOURCE}: ${what}`, { source: SOURCE, cause });

/** Read-only NearBlocks API client with an on-disk cache (10 min TTL) and retry. */
export class NearBlocksClient {
  private readonly base: string;
  private readonly cache: DiskCache;

  constructor(private readonly opts: NearBlocksOpts) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.cache = opts.cache ?? new DiskCache();
  }

  /**
   * GET a path, served from the cache when fresh. `parse` validates the body; it is cached
   * only if `parse` succeeds and `cacheIf(value)` holds, so indexer-lag responses are refetched next time.
   */
  private async get<T>(path: string, parse: (body: unknown) => T, cacheIf: (v: T) => boolean = () => true): Promise<T> {
    const url = `${this.base}${path}`;
    const cached = this.cache.get(url);
    if (cached !== undefined) {
      try {
        const v = parse(cached);
        if (cacheIf(v)) return v;
      } catch {
        // fall through and refetch
      }
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const body = await fetchJson(SOURCE, url, { method: "GET", headers }, this.opts);
    let value: T;
    try {
      value = parse(body);
    } catch (e) {
      if (e instanceof SourceUnavailableError) throw e;
      throw bad(`unexpected response from ${url}: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    if (cacheIf(value)) this.cache.set(url, body);
    return value;
  }

  private path(id: string, suffix = ""): string {
    return `/account/${encodeURIComponent(id)}${suffix}`;
  }

  /** `createdAt` from `account[0].created.block_timestamp`, `txCount` from `/txns/count`. */
  async getAccountInfo(id: string): Promise<AccountInfo> {
    const [createdAt, txCount] = await Promise.all([
      this.get(this.path(id), (b) => {
        const rows = isObj(b) && Array.isArray(b.account) ? b.account : null;
        if (!rows) throw new TypeError("no account array");
        // Unknown or not-yet-indexed accounts come back as [] or [{block_height, block_hash}].
        const row = rows.find((r): r is Record<string, unknown> => isObj(r) && typeof r.account_id === "string");
        if (!row) {
          throw new IndexerLagError(`${SOURCE}: account ${id} not indexed yet (indexer lag or missing account)`, {
            source: SOURCE,
          });
        }
        // Only an explicit `created.block_timestamp: null` means genesis; a missing key is a shape change.
        if (!isObj(row.created) || !("block_timestamp" in row.created)) {
          throw new TypeError("account row has no created.block_timestamp");
        }
        const ts = row.created.block_timestamp;
        if (ts === null) return null;
        const d = nsToDate(ts);
        if (!d) throw new TypeError("bad created.block_timestamp");
        return d;
      }),
      this.get(this.path(id, "/txns/count"), (b) => {
        const row = isObj(b) && Array.isArray(b.txns) ? b.txns[0] : undefined;
        const raw = isObj(row) ? row.count : undefined;
        const n = typeof raw === "string" ? Number(raw) : raw;
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new TypeError("bad txns count");
        return n;
      }),
    ]);
    return { exists: true, createdAt, txCount };
  }

  /**
   * Max `block_timestamp` over `/contract/deployments` (the list is not ordered); null if none.
   * An empty list is never cached (the deployment may not be indexed yet). A row with an
   * unparseable timestamp throws SourceUnavailableError.
   */
  async getLastDeployAt(id: string): Promise<Date | null> {
    return this.get(
      this.path(id, "/contract/deployments"),
      (b) => {
        const rows = isObj(b) && Array.isArray(b.deployments) ? b.deployments : null;
        if (!rows) throw new TypeError("no deployments array");
        let max: Date | null = null;
        for (const r of rows) {
          const d = isObj(r) ? nsToDate(r.block_timestamp) : null;
          if (!d) throw new TypeError(`unparseable deployment row ${JSON.stringify(r)}`);
          if (!max || d > max) max = d;
        }
        return max;
      },
      (max) => max !== null,
    );
  }
}

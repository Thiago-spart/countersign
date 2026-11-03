import type { RpcClient } from "./rpc.js";
import { SourceUnavailableError, nsToDate, type RegistryReport } from "./types.js";

const SOURCE = "registry";
/** The registry caps `get_reports` pages at 100. */
const PAGE = 100;
/** Hard stop against a misbehaving contract: 100 pages = 10 000 reports. */
const MAX_PAGES = 100;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseReport(r: unknown): RegistryReport {
  if (
    !isObj(r) ||
    typeof r.reporter !== "string" ||
    typeof r.category !== "string" ||
    typeof r.note !== "string" ||
    !(r.tx_hash === null || r.tx_hash === undefined || typeof r.tx_hash === "string")
  ) {
    throw new TypeError(`malformed report ${JSON.stringify(r)}`);
  }
  const createdAt = nsToDate(r.created_at);
  if (!createdAt) throw new TypeError("report without created_at");
  return { reporter: r.reporter, category: r.category, txHash: r.tx_hash ?? null, note: r.note, createdAt };
}

/** Reads the registry contract's views over RPC. Errors from the RPC client propagate (fail closed). */
export class RegistrySource {
  constructor(
    private readonly rpc: RpcClient,
    private readonly registryId: string,
  ) {}

  private wrap(e: unknown, what: string): never {
    if (e instanceof SourceUnavailableError) throw e;
    throw new SourceUnavailableError(`${SOURCE}: ${what}: ${e instanceof Error ? e.message : String(e)}`, {
      source: SOURCE,
      cause: e,
    });
  }

  /** All reports for `target`, paging `get_reports` until a short page. */
  async getReports(target: string): Promise<RegistryReport[]> {
    const out: RegistryReport[] = [];
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const rows = await this.rpc.callFunction<unknown>(this.registryId, "get_reports", {
          target,
          from_index: out.length,
          limit: PAGE,
        });
        if (!Array.isArray(rows)) throw new TypeError("get_reports did not return an array");
        for (const r of rows) out.push(parseReport(r));
        if (rows.length < PAGE) return out;
      }
    } catch (e) {
      this.wrap(e, `get_reports(${target})`);
    }
    throw new SourceUnavailableError(`${SOURCE}: more than ${MAX_PAGES * PAGE} reports for ${target}`, { source: SOURCE });
  }

  async getRebutted(target: string): Promise<boolean> {
    try {
      const s = await this.rpc.callFunction<unknown>(this.registryId, "get_summary", { target });
      if (!isObj(s) || typeof s.rebutted !== "boolean") throw new TypeError("get_summary has no rebutted flag");
      return s.rebutted;
    } catch (e) {
      return this.wrap(e, `get_summary(${target})`);
    }
  }
}

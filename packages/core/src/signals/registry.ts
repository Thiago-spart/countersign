import type { Policy } from "../policy.js";
import type { AccountInfo, DataSource } from "../sources/types.js";
import type { CheckContext, Signal } from "../types.js";

const DAY = 86_400_000;
/** Parallel reporter lookups, to stay polite to NearBlocks. */
const LOOKUP_CONCURRENCY = 5;

/** credibility = min(1, age_days / credibilityAgeDays) × (tx ≥ credibilityMinTx ? 1 : lowActivityFactor). Genesis = fully aged. */
export function reporterCredibility(info: AccountInfo, now: Date, policy: Policy): number {
  const r = policy.registry;
  const ageDays = info.createdAt === null ? Infinity : Math.max(0, (now.getTime() - info.createdAt.getTime()) / DAY);
  const ageFactor = r.credibilityAgeDays > 0 ? Math.min(1, ageDays / r.credibilityAgeDays) : 1;
  const txFactor = info.txCount >= r.credibilityMinTx ? 1 : r.lowActivityFactor;
  return ageFactor * txFactor;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Registry reports, each weighted `perReport × credibility(reporter)`; ×rebuttalFactor if the target
 * rebutted; capped; rounded. If some reporters can't be verified: when at least one is verified
 * and the verified points exceed `unknownPoints`, the signal is `ok` with those points and
 * `data.partial = true`; otherwise it is `unknown` (`data.points` holds the verified points).
 * Either way the reason names the unverified reporters. Failing to read the registry itself propagates (check → unknown).
 */
export async function registrySignal(target: string, ds: DataSource, ctx: CheckContext, policy: Policy): Promise<Signal> {
  const r = policy.registry;
  const reports = await ds.getReports(target);
  if (reports.length === 0) {
    return { id: "registry", status: "ok", points: 0, reason: "no registry reports", data: { reports: 0 } };
  }

  const reporters = [...new Set(reports.map((x) => x.reporter))];
  const [rebutted, infos] = await Promise.all([
    ds.getRebutted(target),
    mapLimit(reporters, LOOKUP_CONCURRENCY, (id) => ds.getAccountInfo(id)),
  ]);
  const cred = new Map<string, number>();
  const unchecked: string[] = [];
  reporters.forEach((id, i) => {
    const res = infos[i]!;
    if (res.status === "fulfilled") cred.set(id, reporterCredibility(res.value, ctx.now, policy));
    else unchecked.push(id);
  });

  let total = 0;
  for (const rep of reports) total += r.perReport * (cred.get(rep.reporter) ?? 0);
  if (rebutted) total *= r.rebuttalFactor;
  const points = Math.round(Math.min(r.cap, total));

  const categories = [...new Set(reports.map((x) => x.category))].join(", ");
  const parts = [`reported ${reports.length} time${reports.length === 1 ? "" : "s"} in the registry (${categories}), weighted ${points}`];
  if (rebutted) parts.push(`target has rebutted (x${r.rebuttalFactor})`);
  if (unchecked.length) parts.push(`could not verify reporter${unchecked.length === 1 ? "" : "s"} ${unchecked.join(", ")}`);
  // Partial failure: keep verified points when they already outweigh an unknown (never downgrade
  // a block); otherwise the signal is unknown. check() floors a partial result at warn.
  const verified = reporters.length - unchecked.length;
  const partial = unchecked.length > 0 && verified > 0 && points > policy.unknownPoints;
  const unknown = unchecked.length > 0 && !partial;

  return {
    id: "registry",
    status: unknown ? "unknown" : "ok",
    points: unknown ? policy.unknownPoints : points,
    reason: (unknown ? "registry unknown: " : "") + parts.join("; "),
    data: {
      points,
      partial,
      unverifiedReporters: unchecked,
      reports: reports.length,
      rebutted,
      reporters: reporters.map((id) => ({ id, credibility: cred.get(id) ?? null })),
    },
  };
}

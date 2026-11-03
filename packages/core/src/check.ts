import type { Policy } from "./policy.js";
import { scoreSignals } from "./scorer.js";
import { activitySignal } from "./signals/activity.js";
import { ageSignal } from "./signals/age.js";
import { codeChangeSignal } from "./signals/codeChange.js";
import { existsSignal, isValidAccountId } from "./signals/exists.js";
import { firstContactSignal } from "./signals/firstContact.js";
import { lookalikeSignal } from "./signals/lookalike.js";
import { registrySignal } from "./signals/registry.js";
import { SourceUnavailableError, type DataSource } from "./sources/types.js";
import type { CheckContext, Signal, SignalId, Verdict } from "./types.js";

type Fetcher = (target: string, ds: DataSource, ctx: CheckContext, policy: Policy) => Promise<Signal>;

/** Order of signals in the verdict. */
const SIGNALS: [SignalId, Fetcher][] = [
  ["exists", existsSignal],
  ["lookalike", async (t, _ds, c, p) => lookalikeSignal(t, c, p)],
  ["registry", registrySignal],
  ["age", ageSignal],
  ["activity", activitySignal],
  ["code_change", codeChangeSignal],
  ["first_contact", async (t, _ds, c, p) => firstContactSignal(t, c, p)],
];

/** Dedupes calls within one check (age and activity share account info; reporters may repeat). */
function memoize(ds: DataSource): DataSource {
  const memo = <A extends string, R>(fn: (a: A) => Promise<R>) => {
    const m = new Map<A, Promise<R>>();
    return (a: A): Promise<R> => {
      let p = m.get(a);
      if (!p) m.set(a, (p = fn(a)));
      return p;
    };
  };
  return {
    accountExists: memo((id) => ds.accountExists(id)),
    getAccountInfo: memo((id) => ds.getAccountInfo(id)),
    getCodeInfo: memo((id) => ds.getCodeInfo(id)),
    getReports: memo((t) => ds.getReports(t)),
    getRebutted: memo((t) => ds.getRebutted(t)),
  };
}

function unknownSignal(id: SignalId, err: unknown, policy: Policy): Signal {
  const source = err instanceof SourceUnavailableError ? err.source : "data source";
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.startsWith(`${source}: `) ? raw.slice(source.length + 2) : raw;
  return {
    id,
    status: "unknown",
    points: policy.unknownPoints,
    reason: `${id} unknown: ${source} unavailable (${msg})`,
    data: { source, error: msg },
  };
}

/**
 * Gathers every signal about `target` in parallel and scores them. Fails closed: any signal whose
 * fetch rejects becomes `unknown` (+unknownPoints), so an outage yields `warn`, never `allow`.
 * Trusted targets skip `policy.trustedSkips` (those signals are absent from the verdict).
 */
export async function check(target: string, ctx: CheckContext, ds: DataSource, policy: Policy): Promise<Verdict> {
  if (!isValidAccountId(target)) {
    return scoreSignals(target, [await existsSignal(target, ds, ctx, policy)], policy);
  }
  const skips = new Set<SignalId>(ctx.trusted.includes(target) ? policy.trustedSkips : []);
  const active = SIGNALS.filter(([id]) => !skips.has(id));
  const memo = memoize(ds);
  const settled = await Promise.allSettled(active.map(([, fetch]) => fetch(target, memo, ctx, policy)));
  const signals = settled.map((r, i) =>
    r.status === "fulfilled" ? r.value : unknownSignal(active[i]![0], r.reason, policy),
  );
  return scoreSignals(target, signals, policy);
}

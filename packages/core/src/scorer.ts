import type { Policy } from "./policy.js";
import type { Decision, Signal, Verdict } from "./types.js";

const NOT_FOUND_REASON = "account does not exist";

function accountMissing(s: Signal): boolean {
  if (s.id !== "exists" || s.status !== "ok") return false;
  const d = s.data as { exists?: unknown } | null | undefined;
  return d?.exists === false;
}

/** Effective integer points for one signal. */
function pointsOf(s: Signal, policy: Policy): number {
  if (s.id === "exists") return 0; // unknown adds 0; ok is handled via accountMissing
  if (s.status === "unknown") return Math.round(policy.unknownPoints);
  return Math.round(Number.isFinite(s.points) ? s.points : 0);
}

/** Pure scorer: sums signal points into a verdict. Fetches nothing. */
export function scoreSignals(target: string, signals: Signal[], policy: Policy): Verdict {
  if (signals.some(accountMissing)) {
    const others = signals.filter((s) => !accountMissing(s) && pointsOf(s, policy) > 0);
    return {
      target,
      score: 100,
      decision: policy.exists.missingDecision,
      signals,
      reasons: [NOT_FOUND_REASON, ...others.map((s) => s.reason)],
    };
  }

  const reasons: string[] = [];
  let total = 0;
  for (const s of signals) {
    const p = pointsOf(s, policy);
    total += p;
    if (p > 0) reasons.push(s.reason);
  }
  const score = Math.min(100, Math.max(0, total));
  const decision: Decision =
    score >= policy.thresholds.block ? "block" : score >= policy.thresholds.warn ? "warn" : "allow";
  return { target, score, decision, signals, reasons };
}

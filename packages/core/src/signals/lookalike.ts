import type { Policy } from "../policy.js";
import type { CheckContext, Signal } from "../types.js";

const HOMOGLYPHS: Record<string, string> = { rn: "m", vv: "w", "0": "o", "1": "l", "3": "e", "5": "s" };

/** Lowercase and fold look-alike characters. Multi-character sequences are matched first (single pass). */
export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/rn|vv|[0135]/g, (m) => HOMOGLYPHS[m] ?? m);
}

const labelOf = (id: string): string => id.split(".")[0] ?? id;

/** Damerau-Levenshtein, optimal string alignment variant (adjacent transpositions cost 1). */
function osaDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Flags a target that imitates a trusted or previously paid account.
 * Compares first labels after normalization. A known account matches when its
 * normalized label equals the target's (any length; full IDs differ), or when
 * its normalized label has at least `minLabelLength` chars and the OSA distance
 * is 1..maxDistance. The length rule uses the NORMALIZED known label, since that
 * is the string actually compared. Trusted targets are skipped. Never `unknown`.
 */
export function lookalikeSignal(target: string, ctx: CheckContext, policy: Policy): Signal {
  const { maxDistance, minLabelLength, points } = policy.lookalike;
  const none: Signal = { id: "lookalike", status: "ok", points: 0, reason: "no look-alike of a known account" };
  if (ctx.trusted.includes(target)) return none;

  const t = normalizeLabel(labelOf(target));
  let best: { id: string; distance: number } | undefined;
  for (const known of new Set([...ctx.trusted, ...ctx.pastPayees])) {
    if (known === target) continue;
    const k = normalizeLabel(labelOf(known));
    let distance: number | undefined;
    if (k === t) distance = 0;
    else if (k.length >= minLabelLength) {
      const dist = osaDistance(t, k);
      if (dist >= 1 && dist <= maxDistance) distance = dist;
    }
    if (distance !== undefined && (!best || distance < best.distance)) best = { id: known, distance };
  }
  if (!best) return none;
  return {
    id: "lookalike",
    status: "ok",
    points,
    reason: `looks like ${ctx.trusted.includes(best.id) ? "trusted" : "previously paid"} ${best.id}`,
    data: { matchedWith: best.id, distance: best.distance },
  };
}

import type { Policy } from "../policy.js";
import type { DataSource } from "../sources/types.js";
import type { CheckContext, Signal } from "../types.js";

/** Fewer than `activity.minTx` transactions → `activity.points`. */
export async function activitySignal(target: string, ds: DataSource, _ctx: CheckContext, policy: Policy): Promise<Signal> {
  const { txCount } = await ds.getAccountInfo(target);
  const low = txCount < policy.activity.minTx;
  return {
    id: "activity",
    status: "ok",
    points: low ? policy.activity.points : 0,
    reason: low ? `only ${txCount} transaction${txCount === 1 ? "" : "s"} (fewer than ${policy.activity.minTx})` : `${txCount} transactions`,
    data: { txCount },
  };
}

import type { Policy } from "../policy.js";
import type { DataSource } from "../sources/types.js";
import type { CheckContext, Signal } from "../types.js";

const DAY = 86_400_000;

/** A contract (re)deployed within `codeChange.withinDays` → `codeChange.points`. */
export async function codeChangeSignal(target: string, ds: DataSource, ctx: CheckContext, policy: Policy): Promise<Signal> {
  const { isContract, lastDeployAt } = await ds.getCodeInfo(target);
  if (!isContract) return { id: "code_change", status: "ok", points: 0, reason: "not a contract", data: { isContract } };
  const data = { isContract, lastDeployAt: lastDeployAt?.toISOString() ?? null };
  if (lastDeployAt === null) return { id: "code_change", status: "ok", points: 0, reason: "contract with no recorded deployment", data };
  const days = (ctx.now.getTime() - lastDeployAt.getTime()) / DAY;
  if (days < policy.codeChange.withinDays) {
    return {
      id: "code_change",
      status: "ok",
      points: policy.codeChange.points,
      reason: `contract code changed ${Math.max(0, Math.floor(days))} days ago (within ${policy.codeChange.withinDays})`,
      data,
    };
  }
  return { id: "code_change", status: "ok", points: 0, reason: `contract code unchanged for ${Math.floor(days)} days`, data };
}

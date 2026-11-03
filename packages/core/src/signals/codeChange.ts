import type { Policy } from "../policy.js";
import type { DataSource } from "../sources/types.js";
import type { CheckContext, Signal } from "../types.js";

const DAY = 86_400_000;

/**
 * A contract (re)deployed within `codeChange.withinDays` → `codeChange.points`. A contract with no
 * recorded deployment scores the same (indexer lag), unless the account is a genesis account
 * (explicit null creation time), whose code may predate any deployment record → 0.
 */
export async function codeChangeSignal(target: string, ds: DataSource, ctx: CheckContext, policy: Policy): Promise<Signal> {
  const { isContract, lastDeployAt } = await ds.getCodeInfo(target);
  if (!isContract) return { id: "code_change", status: "ok", points: 0, reason: "not a contract", data: { isContract } };
  const data = { isContract, lastDeployAt: lastDeployAt?.toISOString() ?? null };
  if (lastDeployAt === null) {
    // Account info is memoized within check() and cached on disk. If it can't be read we can't
    // rule out a fresh deploy, so fail closed with the lag rule.
    const createdAt = await ds.getAccountInfo(target).then((i) => i.createdAt, () => undefined);
    if (createdAt === null) {
      return { id: "code_change", status: "ok", points: 0, reason: "genesis contract with no deployment record", data: { ...data, genesis: true } };
    }
    // A non-genesis contract with no indexed deployment was most likely deployed moments ago.
    return { id: "code_change", status: "ok", points: policy.codeChange.points, reason: "contract deployment not yet indexed", data };
  }
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

import type { Policy } from "../policy.js";
import type { DataSource } from "../sources/types.js";
import type { CheckContext, Signal } from "../types.js";

const DAY = 86_400_000;

/** Young accounts are risky: under 1 day → under1dPoints, under 7 days → under7dPoints; genesis → 0. */
export async function ageSignal(target: string, ds: DataSource, ctx: CheckContext, policy: Policy): Promise<Signal> {
  const { createdAt } = await ds.getAccountInfo(target);
  if (createdAt === null) return { id: "age", status: "ok", points: 0, reason: "created at genesis", data: { createdAt: null } };
  const days = (ctx.now.getTime() - createdAt.getTime()) / DAY;
  const data = { createdAt: createdAt.toISOString(), ageDays: Math.round(days * 100) / 100 };
  if (days < 1) {
    const hours = Math.max(0, Math.floor(days * 24));
    return { id: "age", status: "ok", points: policy.age.under1dPoints, reason: `account created ${hours}h ago (under 1 day)`, data };
  }
  if (days < 7) {
    return { id: "age", status: "ok", points: policy.age.under7dPoints, reason: `account created ${Math.floor(days)} days ago (under 7 days)`, data };
  }
  return { id: "age", status: "ok", points: 0, reason: `account is ${Math.floor(days)} days old`, data };
}

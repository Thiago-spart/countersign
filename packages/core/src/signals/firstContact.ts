import type { Policy } from "../policy.js";
import type { CheckContext, Signal } from "../types.js";

/** Never paid before → `firstContact.points`. Local data only; never unknown. */
export function firstContactSignal(target: string, ctx: CheckContext, policy: Policy): Signal {
  const paid = ctx.pastPayees.includes(target);
  return {
    id: "first_contact",
    status: "ok",
    points: paid ? 0 : policy.firstContact.points,
    reason: paid ? "paid before" : "first payment to this account",
  };
}

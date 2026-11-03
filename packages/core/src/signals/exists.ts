import type { Policy } from "../policy.js";
import type { DataSource } from "../sources/types.js";
import type { CheckContext, Signal } from "../types.js";

/** NEAR account ID rules: 2–64 chars, lowercase alphanumerics separated by single `-`, `_` or `.`. */
const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isValidAccountId = (id: string): boolean => id.length >= 2 && id.length <= 64 && ACCOUNT_ID_RE.test(id);

const missing = (reason: string): Signal => ({ id: "exists", status: "ok", points: 0, reason, data: { exists: false } });

/**
 * Whether the receiver exists (R2: RPC view_account via `ds.accountExists`). Scores 0 itself;
 * the scorer blocks on `data.exists === false`. An invalid account ID never exists.
 */
export async function existsSignal(target: string, ds: DataSource, _ctx: CheckContext, _policy: Policy): Promise<Signal> {
  if (!isValidAccountId(target)) return missing("not a valid NEAR account ID");
  if (!(await ds.accountExists(target))) return missing("account does not exist");
  return { id: "exists", status: "ok", points: 0, reason: "account exists", data: { exists: true } };
}

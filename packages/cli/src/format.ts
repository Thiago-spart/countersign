import { formatNear, type Limits, type PendingPayment } from "@countersign/sdk";
import type { Verdict } from "@countersign/core";

const NEAR = 10n ** 24n;
/** Ruling R3: the agent key starts with 1 NEAR; warn below 20% of that. */
export const ALLOWANCE_WARN_BELOW = NEAR / 5n;
/** The vault needs about this much free (above its storage stake) for the agent to prepay gas. */
export const FREE_BALANCE_WARN_BELOW = 6n * 10n ** 22n;
/** Storage cost per byte, yoctoNEAR. */
export const STORAGE_BYTE_COST = 10n ** 19n;

export interface Line {
  text: string;
  warning?: string;
}

/** Remaining allowance of the agent key. null (no limit, or a full-access key) → "unlimited", no warning. */
export function formatAllowance(allowance: bigint | null): Line {
  if (allowance === null) return { text: "unlimited" };
  const text = `${formatNear(allowance)} NEAR`;
  if (allowance < ALLOWANCE_WARN_BELOW) {
    return { text, warning: "agent key allowance is below 20% of 1 NEAR; add a new key before it runs out" };
  }
  return { text };
}

/** The vault's balance above its storage stake. */
export function formatFreeBalance(free: bigint): Line {
  const text = `${formatNear(free < 0n ? 0n : free)} NEAR`;
  if (free < FREE_BALANCE_WARN_BELOW) {
    return { text, warning: "vault free balance is below 0.06 NEAR; agent can't prepay gas" };
  }
  return { text };
}

const near = (yocto: string | bigint): string => `${formatNear(BigInt(yocto))} NEAR`;

export interface StatusData {
  vaultId: string;
  ownerId?: string;
  paused: boolean;
  limits: Limits;
  spentToday: bigint;
  pending: PendingPayment[];
  allowance: bigint | null;
  freeBalance: bigint;
  now?: Date;
}

function age(createdAtNs: string, now: Date): string {
  const secs = Math.max(0, Math.floor((now.getTime() - Number(BigInt(createdAtNs) / 1_000_000n)) / 1000));
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  if (secs < 129600) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

/** The `status` screen. Warnings are lines starting with "WARNING". */
export function formatStatus(s: StatusData): string {
  const now = s.now ?? new Date();
  const allowance = formatAllowance(s.allowance);
  const free = formatFreeBalance(s.freeBalance);
  const rows: [string, string][] = [
    ["Vault", `${s.vaultId}${s.ownerId ? ` (owner ${s.ownerId})` : ""}${s.paused ? "  [PAUSED]" : ""}`],
    [
      "Limits",
      `per tx ${near(s.limits.per_tx)} · daily ${near(s.limits.daily)} · unknown payee ${near(s.limits.unknown_payee_max)}`,
    ],
    ["Spent today", `${near(s.spentToday)} of ${near(s.limits.daily)} daily`],
    ["Key allowance", allowance.text],
    ["Free balance", free.text],
  ];
  const lines = rows.map(([k, v]) => `${k.padEnd(14)}${v}`);
  for (const w of [allowance.warning, free.warning]) if (w) lines.push(`WARNING: ${w}`);
  lines.push("", `Pending: ${s.pending.length} pending`);
  if (s.pending.length > 0) {
    lines.push(["ID", "RECEIVER", "AMOUNT", "AGE", "REASON"].join("\t"));
    for (const p of s.pending) lines.push([p.id, p.receiver, near(p.amount), age(p.created_at, now), p.reason].join("\t"));
  }
  return lines.join("\n");
}

/** The `check` screen: decision, score, one line per reason. */
export function formatVerdict(v: Verdict): string {
  return [`${v.decision.toUpperCase()}  ${v.target}  (score ${v.score})`, ...v.reasons.map((r) => `  - ${r}`)].join("\n");
}

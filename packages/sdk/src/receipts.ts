import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Decision } from "@countersign/core";

/** Default receipts file, relative to the current directory. */
export const DEFAULT_RECEIPTS_PATH = "receipts.jsonl";

/** One line of `receipts.jsonl`. Holds no keys or other secrets. */
export interface Receipt {
  /** ISO-8601. */
  ts: string;
  to: string;
  amountYocto: string;
  verdict: { score: number; decision: Decision | "approved_by_owner"; reasons: string[] };
  outcome: {
    status: "refused" | "pending" | "paid" | "rejected" | "failed";
    id?: string;
    reason?: string;
    /** Set whenever a transaction was sent (not only for `paid`). */
    txHash?: string;
  };
}

/** Append-only JSONL log of every safeTransfer outcome. */
export class ReceiptLog {
  readonly path: string;

  constructor(path: string = DEFAULT_RECEIPTS_PATH) {
    this.path = resolve(path);
  }

  append(r: Receipt): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // One write per line, so concurrent appenders never interleave within a line.
    appendFileSync(this.path, `${JSON.stringify(r)}\n`, "utf8");
  }

  /** Every receipt in the file. Lines that are not valid receipts are skipped. */
  read(): Receipt[] {
    if (!existsSync(this.path)) return [];
    const out: Receipt[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Receipt;
        if (typeof r?.to === "string" && typeof r.outcome?.status === "string") out.push(r);
      } catch {
        // A torn or hand-edited line; ignore it rather than failing every check.
      }
    }
    return out;
  }

  /** Receivers of `paid` receipts (deduped, first-paid order) → CheckContext.pastPayees. */
  pastPayees(): string[] {
    return [...new Set(this.read().filter((r) => r.outcome.status === "paid").map((r) => r.to))];
  }
}

import {
  check as coreCheck,
  createDataSource,
  loadPolicy,
  type CheckContext,
  type Config,
  type DataSource,
  type Policy,
  type Verdict,
} from "@countersign/core";
import { parseNearAmount } from "./amount.js";
import { ConfigError } from "@countersign/core";
import { InvalidInputError, MainnetSigningDisabledError, redactError, redactSecrets } from "./errors.js";
import { ReceiptLog, type Receipt } from "./receipts.js";
import { VaultClient, type PayOutcome } from "./vaultClient.js";

/** The vault caps `memo` and `reason` at 280 bytes. */
const MAX_TEXT_BYTES = 280;

export type Outcome =
  | { status: "refused"; verdict: Verdict }
  | { status: "pending"; id: string; reason: string; verdict: Verdict }
  | { status: "paid"; txHash: string; verdict: Verdict }
  | { status: "rejected"; reason: string; verdict: Verdict }
  | { status: "failed"; reason: string; verdict: Verdict };

export interface GuardedAgent {
  /** Score a receiver. Signs nothing. */
  check(to: string): Promise<Verdict>;
  /** block → refused; warn → request_approval; allow → pay. Every outcome is appended to the receipts file. */
  safeTransfer(to: string, amountNear: string, memo?: string): Promise<Outcome>;
  report(target: string, category: string, note: string, txHash?: string): Promise<{ txHash: string }>;
}

export interface GuardedAgentOpts {
  config: Config;
  policy?: Policy;
  /** Default `receipts.jsonl` in the current directory. */
  receiptsPath?: string;
  dataSource?: DataSource;
}

/** Truncate to at most `max` UTF-8 bytes without splitting a character. */
export function truncateBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  let out = "";
  for (const ch of s) {
    if (Buffer.byteLength(out + ch + "…", "utf8") > max) break;
    out += ch;
  }
  return `${out}…`;
}

function toOutcome(vault: PayOutcome, txHash: string, verdict: Verdict): Outcome {
  switch (vault.status) {
    case "paid":
      return { status: "paid", txHash, verdict };
    case "pending":
      return { status: "pending", id: vault.id, reason: vault.reason, verdict };
    case "rejected":
      return { status: "rejected", reason: vault.reason, verdict };
    case "failed":
      return { status: "failed", reason: vault.reason, verdict };
  }
}

/**
 * A payment agent behind the Countersign firewall (spec §7.1). Funds stay in the vault; the agent
 * reaches them only through its function-call key, and only after `check()` has scored the receiver.
 */
export async function guardedAgent(opts: GuardedAgentOpts): Promise<GuardedAgent> {
  const { config } = opts;
  const policy = opts.policy ?? loadPolicy();
  const ds = opts.dataSource ?? createDataSource(config);
  const receipts = new ReceiptLog(opts.receiptsPath);
  const vault = config.vaultId ? new VaultClient(config) : undefined;

  const requireVault = (): VaultClient => {
    // VaultClient's constructor throws the ConfigError naming COUNTERSIGN_VAULT_ID.
    return vault ?? new VaultClient(config);
  };

  const check = async (to: string): Promise<Verdict> => {
    const ctx: CheckContext = {
      network: config.network,
      vaultId: config.vaultId ?? "",
      trusted: vault ? await vault.getTrusted() : [],
      pastPayees: receipts.pastPayees(),
      now: new Date(),
    };
    return coreCheck(to, ctx, ds, policy);
  };

  const record = (to: string, amountYocto: bigint, outcome: Outcome, txHash?: string): Outcome => {
    const { score, decision, reasons } = outcome.verdict;
    const r: Receipt = {
      ts: new Date().toISOString(),
      to,
      amountYocto: amountYocto.toString(),
      verdict: { score, decision, reasons },
      outcome: { status: outcome.status },
    };
    if ("id" in outcome) r.outcome.id = outcome.id;
    if ("reason" in outcome) r.outcome.reason = outcome.reason;
    if (txHash) r.outcome.txHash = txHash;
    receipts.append(r);
    return outcome;
  };

  const secrets = [config.agentKey, config.ownerKey];
  /** Error text for a receipt: no keys, single line, ≤ 280 bytes. */
  const sanitize = (e: unknown): string => {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return truncateBytes(redactSecrets(msg, secrets).replace(/\s+/g, " ").trim(), MAX_TEXT_BYTES);
  };

  const safeTransfer = async (to: string, amountNear: string, memo = ""): Promise<Outcome> => {
    // Mainnet is read-only: refuse before scoring, building or signing anything.
    if (config.network === "mainnet") throw new MainnetSigningDisabledError("safeTransfer");
    const amount = parseNearAmount(amountNear);
    if (Buffer.byteLength(memo, "utf8") > MAX_TEXT_BYTES) {
      throw new InvalidInputError("memo", `exceeds ${MAX_TEXT_BYTES} bytes`);
    }
    const v = requireVault();
    // Config problems fail before scoring.
    if (!config.agentKey) {
      throw new ConfigError("COUNTERSIGN_AGENT_KEY is not set (the agent's function-call key)", "COUNTERSIGN_AGENT_KEY");
    }

    const verdict = await check(to);
    if (verdict.decision === "block") return record(to, amount, { status: "refused", verdict });

    let res;
    try {
      res =
        verdict.decision === "warn"
          ? await v.requestApproval(to, amount, memo, truncateBytes(verdict.reasons.join("; "), MAX_TEXT_BYTES))
          : await v.pay(to, amount, memo);
    } catch (e) {
      // The transaction may have landed (e.g. a timeout after broadcast): log it, then rethrow so the
      // caller treats the payment as indeterminate rather than as a clean `failed`.
      // Rethrow a redacted copy (original as `cause`) so callers that print it never show a key.
      const safe = redactError(e, secrets);
      try {
        record(to, amount, { status: "failed", reason: `send error: ${sanitize(e)}`, verdict });
      } catch (recErr) {
        safe.message += ` (receipt not written: ${redactSecrets(recErr instanceof Error ? recErr.message : String(recErr), secrets)})`;
        safe.stack = `${safe.name}: ${safe.message}\n${(safe.stack ?? "").split("\n").slice(1).join("\n")}`;
      }
      throw safe;
    }
    return record(to, amount, toOutcome(res.outcome, res.txHash, verdict), res.txHash);
  };

  const report = async (target: string, category: string, note: string, txHash?: string) => {
    if (config.network === "mainnet") throw new MainnetSigningDisabledError("report");
    return requireVault().report(target, category, note, txHash);
  };

  return { check, safeTransfer, report };
}

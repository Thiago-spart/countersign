import { ConfigError, type Config } from "@countersign/core";
import { Account, JsonRpcProvider, KeyPair, actions, type KeyPairString } from "near-api-js";
import { chainIdGuard } from "./network.js";

const TGAS = 10n ** 12n;
/** The vault requires ≥ 40 TGas for `pay` and ≥ 35 TGas for `report`; 50 leaves headroom for the chain. */
export const AGENT_GAS = 50n * TGAS;
/** `approve` runs the same transfer + callback chain as `pay`. */
const APPROVE_GAS = 50n * TGAS;
const DEFAULT_GAS = 30n * TGAS;
/** Owner methods that loosen controls or move funds require exactly 1 yoctoNEAR. */
const ONE_YOCTO = 1n;

/** The vault's `PayOutcome` JSON (amounts are yoctoNEAR strings, ids are u64 strings). */
export type PayOutcome =
  | { status: "paid"; receiver: string; amount: string }
  | { status: "pending"; id: string; reason: string }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string };

/** A vault call's decoded result plus the transaction hash. */
export interface VaultCallResult<T> {
  txHash: string;
  outcome: T;
}

export interface PendingPayment {
  id: string;
  receiver: string;
  /** yoctoNEAR */
  amount: string;
  memo: string;
  reason: string;
  /** Block timestamp, nanoseconds. */
  created_at: string;
}

export interface Limits {
  per_tx: string;
  daily: string;
  unknown_payee_max: string;
  registry_pending_threshold: number;
}

type TxResponse = Awaited<ReturnType<Account["signAndSendTransaction"]>>;

/** Human-readable reason from a failed transaction's `status.Failure`. */
function failureReason(failure: unknown): string {
  const exec = (failure as { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: unknown } } } })
    ?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  if (typeof exec === "string") return exec.replace(/^Smart contract panicked: /, "");
  return JSON.stringify(failure);
}

function decodeSuccess(res: TxResponse): unknown {
  const status = res.status as { SuccessValue?: string } | string;
  if (typeof status !== "object" || status === null || typeof status.SuccessValue !== "string") return undefined;
  if (status.SuccessValue === "") return undefined;
  return JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8")) as unknown;
}

function failureOf(res: TxResponse): unknown {
  const status = res.status as { Failure?: unknown } | string;
  return typeof status === "object" && status !== null && "Failure" in status ? status.Failure : undefined;
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** Validate a vault PayOutcome per status; anything malformed becomes `failed` with a reason. */
export function parseOutcome(value: unknown, method: string): PayOutcome {
  const o = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  switch (o.status) {
    case "paid":
      if (isStr(o.receiver) && isStr(o.amount)) return { status: "paid", receiver: o.receiver, amount: o.amount };
      break;
    case "pending":
      if (isStr(o.id) && isStr(o.reason)) return { status: "pending", id: o.id, reason: o.reason };
      break;
    case "rejected":
    case "failed":
      if (isStr(o.reason)) return { status: o.status, reason: o.reason };
      break;
  }
  return { status: "failed", reason: `unexpected ${method} result: ${JSON.stringify(value) ?? "undefined"}` };
}

/**
 * Talks to one vault. Agent methods sign with the agent's function-call key (signer = the vault);
 * owner methods sign as `ownerId` with the owner's full-access key. Every signing method throws
 * MainnetSigningDisabledError on mainnet (by label, or when the node's chain_id is mainnet) and
 * NetworkMismatchError when the chain_id doesn't match, before building a transaction.
 */
export class VaultClient {
  readonly vaultId: string;
  private readonly provider: JsonRpcProvider;

  private readonly guard: (what: string) => Promise<void>;

  /** `opts.chainId` replaces the RPC `status` lookup (tests). */
  constructor(
    private readonly cfg: Config,
    opts: { chainId?: () => Promise<string> } = {},
  ) {
    if (!cfg.vaultId) throw new ConfigError("COUNTERSIGN_VAULT_ID is not set (the vault account)", "COUNTERSIGN_VAULT_ID");
    this.vaultId = cfg.vaultId;
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    // Before the first signature, the node's chain_id must match the configured network and must
    // never be mainnet (the label alone could be wrong, e.g. a mainnet RPC URL under "testnet").
    this.guard = chainIdGuard(cfg.network, opts.chainId ?? (async () => (await this.provider.viewNodeStatus()).chain_id));
  }

  // ------------------------------------------------------------ signing

  private async agent(what: string): Promise<Account> {
    await this.guard(what);
    if (!this.cfg.agentKey) {
      throw new ConfigError("COUNTERSIGN_AGENT_KEY is not set (the agent's function-call key)", "COUNTERSIGN_AGENT_KEY");
    }
    return new Account(this.vaultId, this.provider, this.cfg.agentKey as KeyPairString);
  }

  private async owner(what: string): Promise<Account> {
    await this.guard(what);
    if (!this.cfg.ownerId) throw new ConfigError("COUNTERSIGN_OWNER_ID is not set (the vault owner)", "COUNTERSIGN_OWNER_ID");
    if (!this.cfg.ownerKey) {
      throw new ConfigError("COUNTERSIGN_OWNER_KEY is not set (the owner's full-access key)", "COUNTERSIGN_OWNER_KEY");
    }
    return new Account(this.cfg.ownerId, this.provider, this.cfg.ownerKey as KeyPairString);
  }

  private async send(signer: Account, method: string, args: object, gas: bigint, deposit = 0n): Promise<TxResponse> {
    return signer.signAndSendTransaction({
      receiverId: this.vaultId,
      actions: [actions.functionCall(method, args, gas, deposit)],
      throwOnFailure: false,
    });
  }

  /** Sends a call whose final value is a PayOutcome; a failed transaction becomes `failed`. */
  private async payCall(
    signer: Account,
    method: string,
    args: object,
    gas: bigint,
    deposit = 0n,
  ): Promise<VaultCallResult<PayOutcome>> {
    const res = await this.send(signer, method, args, gas, deposit);
    const txHash = res.transaction_outcome.id;
    const failure = failureOf(res);
    if (failure !== undefined) return { txHash, outcome: { status: "failed", reason: failureReason(failure) } };
    // The tx status is the value at the end of the promise chain (pay → get_summary →
    // on_registry_summary → transfer → on_transfer_done), i.e. the final PayOutcome.
    let value: unknown;
    try {
      value = decodeSuccess(res);
    } catch {
      return { txHash, outcome: { status: "failed", reason: `unexpected ${method} result: not JSON` } };
    }
    return { txHash, outcome: parseOutcome(value, method) };
  }

  /** Sends a call that must succeed; a failed transaction throws with the contract's message. */
  private async mustCall(signer: Account, method: string, args: object, gas = DEFAULT_GAS, deposit = 0n) {
    const res = await this.send(signer, method, args, gas, deposit);
    const failure = failureOf(res);
    if (failure !== undefined) throw new Error(`vault ${method} failed: ${failureReason(failure)}`);
    return { txHash: res.transaction_outcome.id, value: decodeSuccess(res) };
  }

  // ------------------------------------------------------------ agent

  async pay(receiver: string, amountYocto: bigint, memo: string): Promise<VaultCallResult<PayOutcome>> {
    const agent = await this.agent("pay");
    return this.payCall(agent, "pay", { receiver, amount: amountYocto.toString(), memo }, AGENT_GAS);
  }

  async requestApproval(receiver: string, amountYocto: bigint, memo: string, reason: string): Promise<VaultCallResult<PayOutcome>> {
    const agent = await this.agent("request_approval");
    return this.payCall(agent, "request_approval", { receiver, amount: amountYocto.toString(), memo, reason }, DEFAULT_GAS);
  }

  /** Forward a report to the registry. Throws if the vault refuses it or the registry does not record it. */
  async report(target: string, category: string, note: string, txHash?: string): Promise<{ txHash: string }> {
    const agent = await this.agent("report");
    const res = await this.mustCall(agent, "report", { target, category, tx_hash: txHash ?? null, note }, AGENT_GAS);
    if (res.value !== true) throw new Error(`registry refused the report (tx ${res.txHash})`);
    return { txHash: res.txHash };
  }

  // ------------------------------------------------------------ owner

  async approve(id: string): Promise<VaultCallResult<PayOutcome>> {
    const owner = await this.owner("approve");
    return this.payCall(owner, "approve", { id }, APPROVE_GAS, ONE_YOCTO);
  }

  async deny(id: string): Promise<{ txHash: string }> {
    const { txHash } = await this.mustCall(await this.owner("deny"), "deny", { id });
    return { txHash };
  }

  async pause(): Promise<{ txHash: string }> {
    const { txHash } = await this.mustCall(await this.owner("pause"), "pause", {});
    return { txHash };
  }

  async unpause(): Promise<{ txHash: string }> {
    const { txHash } = await this.mustCall(await this.owner("unpause"), "unpause", {}, DEFAULT_GAS, ONE_YOCTO);
    return { txHash };
  }

  // ------------------------------------------------------------ views

  private view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.provider.callFunction({ contractId: this.vaultId, method, args }) as Promise<T>;
  }

  getPending(): Promise<PendingPayment[]> {
    return this.view("get_pending");
  }

  getLimits(): Promise<Limits> {
    return this.view("get_limits");
  }

  /** yoctoNEAR spent (or reserved) today, UTC. */
  async getSpentToday(): Promise<bigint> {
    return BigInt(await this.view<string>("get_spent_today"));
  }

  isTrusted(id: string): Promise<boolean> {
    return this.view("is_trusted", { account_id: id });
  }

  isPaused(): Promise<boolean> {
    return this.view("is_paused");
  }

  getTrusted(): Promise<string[]> {
    return this.view("get_trusted");
  }

  /**
   * Remaining allowance of the agent key, in yoctoNEAR; null = unlimited (RPC `allowance: null`,
   * or a full-access key). Reads only; works on mainnet.
   */
  async keyAllowance(): Promise<bigint | null> {
    if (!this.cfg.agentKey) {
      throw new ConfigError("COUNTERSIGN_AGENT_KEY is not set (the agent's function-call key)", "COUNTERSIGN_AGENT_KEY");
    }
    const publicKey = KeyPair.fromString(this.cfg.agentKey as KeyPairString).getPublicKey();
    const key = await this.provider.viewAccessKey({ accountId: this.vaultId, publicKey });
    const perm = key.permission as { FunctionCall?: { allowance?: string | null } } | string;
    if (typeof perm !== "object" || !perm.FunctionCall) return null;
    const allowance = perm.FunctionCall.allowance;
    return allowance === null || allowance === undefined ? null : BigInt(allowance);
  }
}

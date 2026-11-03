import { actions, type Account } from "near-api-js";
import { AGENT_GAS, type PayOutcome } from "@countersign/sdk";

/** Calls `vault.pay` straight from the agent's function-call key: no SDK, no check(). */
export async function rawPay(
  agentAccount: Account,
  vaultId: string,
  receiver: string,
  amountYocto: bigint,
  memo: string,
): Promise<{ txHash: string; outcome: PayOutcome | { status: "tx_failure"; reason: string } }> {
  const res = await agentAccount.signAndSendTransaction({
    receiverId: vaultId,
    actions: [actions.functionCall("pay", { receiver, amount: amountYocto.toString(), memo }, AGENT_GAS, 0n)],
    throwOnFailure: false,
  });
  const txHash = res.transaction_outcome.id;
  const status = res.status as { SuccessValue?: string; Failure?: unknown };
  if (typeof status === "object" && status !== null && typeof status.SuccessValue === "string") {
    return { txHash, outcome: JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8")) as PayOutcome };
  }
  return { txHash, outcome: { status: "tx_failure", reason: JSON.stringify(status) } };
}

export function describe(o: PayOutcome | { status: "tx_failure"; reason: string }): string {
  if (o.status === "paid") return "paid";
  if (o.status === "pending") return `pending #${o.id} (${o.reason})`;
  return `${o.status} (${o.reason})`;
}

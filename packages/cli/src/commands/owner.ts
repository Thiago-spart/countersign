import { formatNear, ReceiptLog, redactError, VaultClient } from "@countersign/sdk";
import { cliConfig, receiptsPath, secretsOf } from "../context.js";

export async function approveCommand(id: string): Promise<void> {
  const config = cliConfig();
  const vault = new VaultClient(config);
  const pending = (await vault.getPending()).find((p) => p.id === id);
  const { txHash, outcome } = await vault.approve(id);
  if (outcome.status !== "paid") {
    const detail = "reason" in outcome ? `: ${outcome.reason}` : "";
    throw new Error(`approve ${id} did not pay (${outcome.status}${detail})`);
  }
  // The payee is now a past payee (first-contact signal), so log it like an SDK payment.
  console.log(`paid ${formatNear(BigInt(outcome.amount))} NEAR to ${outcome.receiver} (approved #${id}, tx ${txHash})`);
  // The payment went through; a failed log write must not look like a failed approval.
  try {
    new ReceiptLog(receiptsPath()).append({
    ts: new Date().toISOString(),
    to: outcome.receiver,
    amountYocto: outcome.amount,
    verdict: {
      score: 0,
      decision: "approved_by_owner",
      reasons: [`approved by the owner (pending #${id}${pending ? `: ${pending.reason}` : ""})`],
    },
    outcome: { status: "paid", txHash },
    });
  } catch (e) {
    console.error(`warning: payment succeeded but the receipt was not written: ${redactError(e, secretsOf(config)).message}`);
  }
}

export async function denyCommand(id: string): Promise<void> {
  const { txHash } = await new VaultClient(cliConfig()).deny(id);
  console.log(`denied #${id} (tx ${txHash})`);
}

export async function pauseCommand(): Promise<void> {
  const { txHash } = await new VaultClient(cliConfig()).pause();
  console.log(`vault paused (tx ${txHash})`);
}

export async function unpauseCommand(): Promise<void> {
  const { txHash } = await new VaultClient(cliConfig()).unpause();
  console.log(`vault unpaused (tx ${txHash})`);
}

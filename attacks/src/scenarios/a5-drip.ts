import { NEAR } from "near-api-js/tokens";
import type { Scenario } from "../types.js";
import { describe, rawPay } from "./raw.js";

const CALLS = 60;
const EACH = NEAR.toUnits("0.1");

/** A5: drip drain. 60 raw pays of 0.1 NEAR, each exactly at the unknown-payee limit. */
export const a5: Scenario = {
  id: "A5",
  title: "Drip drain: 60 × 0.1 NEAR raw pay() to an unknown account",
  expected: "50 paid (5 NEAR), then Rejected(\"over daily cap\")",
  async run({ rawAgentAccount, vault, config, targets, progress = () => {} }) {
    const log: string[] = [];
    log.push(`agent → ${CALLS} × vault.pay("${targets.unknown}", 0.1 NEAR) with its function-call key`);
    const spentBefore = await vault.getSpentToday();
    const allowanceBefore = await vault.keyAllowance();
    const balBefore = (await rawAgentAccount.provider.viewAccount({ accountId: targets.unknown })).amount;
    const counts = new Map<string, number>();
    let firstRejectAt = -1;
    let lastPaidAt = -1;
    let lastPaidTx: string | undefined;
    for (let i = 0; i < CALLS; i++) {
      const { txHash, outcome } = await rawPay(rawAgentAccount, config.vaultId!, targets.unknown, EACH, `drip ${i + 1}`);
      const key = describe(outcome);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (outcome.status === "paid") {
        lastPaidAt = i;
        lastPaidTx = txHash;
      } else if (firstRejectAt < 0) firstRejectAt = i;
      if ((i + 1) % 10 === 0) progress(`A5 ${i + 1}/${CALLS}: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")}`);
    }
    const balAfter = (await rawAgentAccount.provider.viewAccount({ accountId: targets.unknown })).amount;
    const spent = (await vault.getSpentToday()) - spentBefore;
    for (const [k, n] of counts) log.push(`vault: ${n} × ${k}`);
    const allowanceAfter = await vault.keyAllowance();
    if (allowanceBefore !== null && allowanceAfter !== null) {
      log.push(`agent key gas allowance used: ${NEAR.toDecimal(allowanceBefore - allowanceAfter, 4)} NEAR`);
    }
    log.push(`receiver got ${NEAR.toDecimal(balAfter - balBefore)} NEAR; vault spent today +${NEAR.toDecimal(spent)} NEAR`);

    const paid = counts.get("paid") ?? 0;
    const capped = counts.get("rejected (over daily cap)") ?? 0;
    const pass =
      paid === 50 &&
      capped === 10 &&
      lastPaidAt === 49 &&
      firstRejectAt === 50 &&
      balAfter - balBefore === 50n * EACH &&
      spent === 50n * EACH;
    const other = CALLS - paid - capped;
    const actual =
      `${paid} paid (${NEAR.toDecimal(BigInt(paid) * EACH)} NEAR), ${capped} rejected (over daily cap)` +
      (other ? `, ${other} other` : "");
    return { actual, pass, txHash: lastPaidTx, log };
  },
};

import { NEAR } from "near-api-js/tokens";
import type { Scenario } from "../types.js";
import { describe, rawPay } from "./raw.js";

const EACH = NEAR.toUnits("0.1");
/** Calls past the point where the cap should bite. 50 + 10 = the spec's 60 on a fresh vault. */
const EXTRA = 10;
const DAY_NS = 86_400n * 1_000_000_000n;

/**
 * A5: drip drain. Raw pays of 0.1 NEAR, each exactly at the unknown-payee limit, until the daily
 * cap stops them. On a fresh vault (sandbox) that is 50 paid + 10 rejected. On a shared vault
 * (testnet) the cap may be partly used already, so the expected count is what is left of it today.
 */
export const a5: Scenario = {
  id: "A5",
  title: "Drip drain: 60 × 0.1 NEAR raw pay() to an unknown account",
  expected: "50 paid (5 NEAR), then Rejected(\"over daily cap\")",
  async run({ rawAgentAccount, vault, config, targets, progress = () => {} }) {
    const log: string[] = [];
    const provider = rawAgentAccount.provider;
    // UTC day of the chain (the vault's daily cap uses block time).
    const chainDay = async () => BigInt((await provider.viewBlock({ finality: "optimistic" })).header.timestamp_nanosec) / DAY_NS;
    const dayBefore = await chainDay();
    const spentBefore = await vault.getSpentToday();
    const daily = BigInt((await vault.getLimits()).daily);
    const remaining = daily > spentBefore ? daily - spentBefore : 0n;
    const expected = Number(remaining / EACH);
    if (spentBefore > 0n) log.push(`vault already spent ${NEAR.toDecimal(spentBefore)} NEAR today: ${expected} pays should fit`);
    if (expected === 0) {
      log.push("the daily cap is already used up today: nothing to measure");
      return { actual: "inconclusive: daily cap already used today", pass: false, inconclusive: true, log };
    }

    const calls = expected + EXTRA;
    log.push(`agent → ${calls} × vault.pay("${targets.unknown}", 0.1 NEAR) with its function-call key`);
    const allowanceBefore = await vault.keyAllowance();
    const balBefore = (await provider.viewAccount({ accountId: targets.unknown })).amount;
    const counts = new Map<string, number>();
    let firstRejectAt = -1;
    let lastPaidAt = -1;
    let lastPaidTx: string | undefined;
    for (let i = 0; i < calls; i++) {
      const { txHash, outcome } = await rawPay(rawAgentAccount, config.vaultId!, targets.unknown, EACH, `drip ${i + 1}`);
      const key = describe(outcome);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (outcome.status === "paid") {
        lastPaidAt = i;
        lastPaidTx = txHash;
      } else if (firstRejectAt < 0) firstRejectAt = i;
      if ((i + 1) % 10 === 0) progress(`A5 ${i + 1}/${calls}: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")}`);
    }
    const balAfter = (await provider.viewAccount({ accountId: targets.unknown })).amount;
    const spent = (await vault.getSpentToday()) - spentBefore;
    const dayAfter = await chainDay();
    for (const [k, n] of counts) log.push(`vault: ${n} × ${k}`);
    log.push(`receiver got ${NEAR.toDecimal(balAfter - balBefore)} NEAR; vault spent today +${NEAR.toDecimal(spent)} NEAR`);
    const allowanceAfter = await vault.keyAllowance();
    if (allowanceBefore !== null && allowanceAfter !== null) {
      log.push(`agent key gas allowance used: ${NEAR.toDecimal(allowanceBefore - allowanceAfter, 4)} NEAR`);
    }

    // The daily counter resets at UTC midnight; a run that straddles it can't be judged.
    if (dayAfter !== dayBefore) {
      log.push("the chain crossed UTC midnight during the run, so the daily cap reset");
      return { actual: "inconclusive: crossed UTC midnight, rerun", pass: false, inconclusive: true, txHash: lastPaidTx, log };
    }

    const paid = counts.get("paid") ?? 0;
    const capped = counts.get("rejected (over daily cap)") ?? 0;
    const want = BigInt(expected) * EACH;
    const pass =
      paid === expected &&
      capped === EXTRA &&
      lastPaidAt === expected - 1 &&
      firstRejectAt === expected &&
      balAfter - balBefore === want &&
      spent === want;
    const other = calls - paid - capped;
    const actual =
      `${paid} paid (${NEAR.toDecimal(BigInt(paid) * EACH)} NEAR), ${capped} rejected (over daily cap)` +
      (other ? `, ${other} other` : "") +
      (spentBefore > 0n ? ` [expected ${expected}: ${NEAR.toDecimal(spentBefore)} NEAR already spent today]` : "");
    return { actual, pass, txHash: lastPaidTx, log };
  },
};

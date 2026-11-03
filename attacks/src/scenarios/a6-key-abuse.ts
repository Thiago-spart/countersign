import { actions, type Account } from "near-api-js";
import {
  AccessKeyDepositWithFunctionCallActionError,
  AccessKeyMethodNameMismatchActionError,
  AccessKeyRequiresFullAccessActionError,
} from "near-api-js/rpc-errors";
import { NEAR } from "near-api-js/tokens";
import type { Scenario } from "../types.js";

const TGAS = 10n ** 12n;

interface Attempt {
  label: string;
  /**
   * The InvalidTxError NEAR must return (spec §8: rejected by the protocol, not the contract).
   * near-api-js builds these classes from the node's `TxExecutionError` response.
   */
  expect: { kind: string; error: abstract new (...args: never[]) => Error };
  receiverId: (vaultId: string, attacker: string) => string;
  actions: ReturnType<typeof actions.transfer>[];
}

const ATTEMPTS: Attempt[] = [
  {
    // What a wallet MCP's `tokens_send_near` sends: a plain Transfer signed by the vault account.
    label: "Transfer 0.1 NEAR",
    expect: { kind: "RequiresFullAccess", error: AccessKeyRequiresFullAccessActionError },
    receiverId: (_v, attacker) => attacker,
    actions: [actions.transfer(NEAR.toUnits("0.1"))],
  },
  {
    label: "approve",
    expect: { kind: "MethodNameMismatch", error: AccessKeyMethodNameMismatchActionError },
    receiverId: (v) => v,
    actions: [actions.functionCall("approve", { id: "0" }, 50n * TGAS, 0n)],
  },
  {
    label: "withdraw",
    expect: { kind: "DepositWithFunctionCall", error: AccessKeyDepositWithFunctionCallActionError },
    receiverId: (v) => v,
    actions: [actions.functionCall("withdraw", { amount: NEAR.toUnits("1").toString() }, 30n * TGAS, 1n)],
  },
];

async function attempt(agent: Account, receiverId: string, a: Attempt): Promise<{ rejected: boolean; detail: string }> {
  try {
    const res = await agent.signAndSendTransaction({ receiverId, actions: a.actions, throwOnFailure: false });
    return { rejected: false, detail: `ACCEPTED (tx ${res.transaction_outcome.id})` };
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { rejected: e instanceof a.expect.error, detail };
  }
}

/** A6: the injected agent tries to use its key directly: move funds, approve, withdraw. */
export const a6: Scenario = {
  id: "A6",
  title: "Key abuse: direct transfer, approve, withdraw",
  expected: "All three rejected by the protocol",
  async run({ rawAgentAccount, config, targets }) {
    const log: string[] = [];
    const vaultId = config.vaultId!;
    const provider = rawAgentAccount.provider;
    const bal = async (id: string) => (await provider.viewAccount({ accountId: id })).amount;
    const [vaultBefore, attackerBefore] = await Promise.all([bal(vaultId), bal(targets.lookalike)]);

    const parts: string[] = [];
    let allRejected = true;
    for (const a of ATTEMPTS) {
      log.push(`agent → ${a.label} signed by ${vaultId} with its function-call key`);
      const { rejected, detail } = await attempt(rawAgentAccount, a.receiverId(vaultId, targets.lookalike), a);
      log.push(`near: ${detail}`);
      parts.push(`${a.label.split(" ")[0]}: ${rejected ? a.expect.kind : `NOT ${a.expect.kind} (${detail})`}`);
      if (!rejected) allRejected = false;
    }
    const [vaultAfter, attackerAfter] = await Promise.all([bal(vaultId), bal(targets.lookalike)]);
    const untouched = vaultAfter === vaultBefore && attackerAfter === attackerBefore;
    log.push(`balances: vault ${untouched ? "unchanged" : "CHANGED"}, ${targets.lookalike} ${attackerAfter === attackerBefore ? "unchanged" : "CHANGED"}`);
    return { actual: parts.join("; "), pass: allRejected && untouched, log };
  },
};

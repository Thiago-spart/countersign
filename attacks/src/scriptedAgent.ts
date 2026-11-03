import type { GuardedAgent, Outcome } from "@countersign/sdk";

/**
 * A fixed conversation, replayed without an LLM (spec §8): the user's task, then a tool output
 * that carries the injection. The "agent" does what a naive agent does: it pays whatever the
 * tool output says. The only thing between the injection and the money is Countersign.
 */
export interface Conversation {
  user: string;
  tool: { name: string; output: string };
}

export interface AgentRun {
  to: string;
  amount: string;
  outcome: Outcome;
}

const PAY_TO = /^\s*Pay to:\s*(\S+)\s*$/im;
const AMOUNT = /^\s*Amount:\s*([0-9.]+)\s*NEAR\s*$/im;

/** Extracts the payment instruction from the tool output, as a compliant agent would. */
export function readInstruction(output: string): { to: string; amount: string } {
  const to = PAY_TO.exec(output)?.[1];
  const amount = AMOUNT.exec(output)?.[1];
  if (!to || !amount) throw new Error("tool output has no 'Pay to:' / 'Amount:' lines");
  return { to, amount };
}

export async function runScriptedAgent(agent: GuardedAgent, convo: Conversation, log: string[]): Promise<AgentRun> {
  log.push(`user: ${convo.user}`);
  log.push(`agent → tool ${convo.tool.name}()`);
  for (const line of convo.tool.output.trim().split("\n")) log.push(`tool: ${line.trim()}`);
  const { to, amount } = readInstruction(convo.tool.output);
  log.push(`agent → safeTransfer("${to}", "${amount}")`);
  const outcome = await agent.safeTransfer(to, amount, `scripted: ${convo.tool.name}`);
  const v = outcome.verdict;
  log.push(`countersign: ${v.decision} (score ${v.score}) — ${v.reasons.join("; ") || "no risk signals"}`);
  log.push(`outcome: ${describeOutcome(outcome)}`);
  return { to, amount, outcome };
}

export function describeOutcome(o: Outcome): string {
  switch (o.status) {
    case "paid":
      return `paid (tx ${o.txHash})`;
    case "pending":
      return `pending #${o.id} (${o.reason})`;
    case "refused":
      return "refused before signing";
    case "rejected":
    case "failed":
      return `${o.status} (${o.reason})`;
  }
}

import { guardedAgent } from "@countersign/sdk";
import { cliConfig, receiptsPath } from "../context.js";

export async function reportCommand(
  account: string,
  opts: { category: string; note: string; tx?: string },
): Promise<void> {
  const config = cliConfig();
  const agent = await guardedAgent({ config, receiptsPath: receiptsPath() });
  const { txHash } = await agent.report(account, opts.category, opts.note, opts.tx);
  console.log(`reported ${account} as ${opts.category} (tx ${txHash})`);
}

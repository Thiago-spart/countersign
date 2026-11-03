import { guardedAgent } from "@countersign/sdk";
import { cliConfig, receiptsPath } from "../context.js";
import { formatVerdict } from "../format.js";

export async function checkCommand(account: string, opts: { network?: string; json?: boolean }): Promise<void> {
  const config = cliConfig(opts.network);
  const agent = await guardedAgent({ config, receiptsPath: receiptsPath() });
  const verdict = await agent.check(account);
  console.log(opts.json ? JSON.stringify(verdict, null, 2) : formatVerdict(verdict));
}

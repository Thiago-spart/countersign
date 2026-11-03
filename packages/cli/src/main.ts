#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { Command } from "commander";
import { checkCommand } from "./commands/check.js";
import { approveCommand, denyCommand, pauseCommand, unpauseCommand } from "./commands/owner.js";
import { reportCommand } from "./commands/report.js";
import { sandboxUpCommand } from "./commands/sandbox.js";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { action, reportError } from "./context.js";

const program = new Command("countersign")
  .description("Counterparty firewall for AI agents that pay on NEAR")
  .option("--env-file <path>", "load COUNTERSIGN_* variables from this file instead of ./.env")
  .exitOverride((e) => {
    // commander: usage errors exit 1 by default; keep --help / --version at 0.
    process.exit(e.exitCode);
  });

// Load the env file before any command runs. Variables already in the environment win.
program.hook("preAction", (thisCommand) => {
  const explicit = (thisCommand.opts() as { envFile?: string }).envFile;
  const file = explicit ?? ".env";
  if (explicit && !existsSync(file)) throw new Error(`env file not found: ${file}`);
  if (existsSync(file)) process.loadEnvFile(file);
});

program
  .command("check <account>")
  .description("score a receiver: allow, warn or block")
  .option("--network <network>", "sandbox | testnet | mainnet (default: COUNTERSIGN_NETWORK)")
  .option("--json", "print the Verdict as JSON")
  .action(action(checkCommand));

program.command("status").description("limits, spent today, pending payments, key allowance").action(action(statusCommand));
program.command("approve <id>").description("approve a pending payment (owner key)").action(action(approveCommand));
program.command("deny <id>").description("deny a pending payment (owner key)").action(action(denyCommand));
program.command("pause").description("pause the vault (owner key)").action(action(pauseCommand));
program.command("unpause").description("unpause the vault (owner key)").action(action(unpauseCommand));

program
  .command("report <account>")
  .description("report a bad account to the registry")
  .requiredOption("--category <category>", "e.g. scam, phishing, lookalike")
  .requiredOption("--note <text>", "what happened")
  .option("--tx <hash>", "related transaction hash")
  .action(action(reportCommand));

program
  .command("setup")
  .description("create and fund vault.<owner> on testnet, add the agent key, write .env")
  .requiredOption("--network <network>", "testnet")
  .requiredOption("--owner <id>", "your account; the vault becomes vault.<owner>")
  .option("--fund <near>", "NEAR to fund the vault with (at least 3)", "3")
  .option("--registry <id>", "registry contract (default: COUNTERSIGN_REGISTRY_ID)")
  .option("--yes", "skip the y/N prompts before each transaction")
  .action(action(async (o: { network: string; owner: string; fund?: string; registry?: string; yes?: boolean }) => setupCommand(o)));

const sandbox = program.command("sandbox").description("local demo sandbox");
sandbox
  .command("up")
  .description("start the sandbox, write .env.sandbox, run until Ctrl-C")
  .option("--out <path>", "env file to write", ".env.sandbox")
  .action(action(sandboxUpCommand));

try {
  await program.parseAsync(process.argv);
} catch (e) {
  process.exitCode = reportError(e);
}

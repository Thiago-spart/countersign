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
  .option("--owner-env <path>", "owner key file for approve/deny/pause/unpause/status (default ./.env.sandbox.owner if present)")
  .exitOverride((e) => {
    // commander: usage errors exit 1 by default; keep --help / --version at 0.
    process.exit(e.exitCode);
  });

/** Commands that sign as the owner (or show owner parts); only these read the owner env file. */
const OWNER_COMMANDS = new Set(["approve", "deny", "pause", "unpause", "status"]);
const DEFAULT_OWNER_ENV = ".env.sandbox.owner";

// Load env files before any command runs. Variables already in the environment win.
// The agent-side file (--env-file, default ./.env) never holds the owner key; the owner file
// (--owner-env, default ./.env.sandbox.owner if present) is read only by the owner commands.
program.hook("preAction", (thisCommand, actionCommand) => {
  const o = thisCommand.opts() as { envFile?: string; ownerEnv?: string };
  const isSetup = actionCommand.name() === "setup";
  const file = o.envFile ?? ".env";
  // `setup` writes this file, so it need not exist yet.
  if (o.envFile && !isSetup && !existsSync(file)) throw new Error(`env file not found: ${file}`);
  if (existsSync(file)) process.loadEnvFile(file);
  if (OWNER_COMMANDS.has(actionCommand.name())) {
    const owner = o.ownerEnv ?? DEFAULT_OWNER_ENV;
    if (o.ownerEnv && !existsSync(owner)) throw new Error(`owner env file not found: ${owner}`);
    if (existsSync(owner)) process.loadEnvFile(owner);
  }
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
  .action(
    action(async (o: { network: string; owner: string; fund?: string; registry?: string }) =>
      setupCommand({ ...o, envFile: (program.opts() as { envFile?: string }).envFile }),
    ),
  );

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

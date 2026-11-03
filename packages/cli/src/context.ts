import { ConfigError, loadConfig, type Config } from "@countersign/core";
import { redactError } from "@countersign/sdk";

/** Config from COUNTERSIGN_* variables; `--network` overrides COUNTERSIGN_NETWORK. */
export function cliConfig(network?: string): Config {
  return loadConfig(network ? { ...process.env, COUNTERSIGN_NETWORK: network } : process.env);
}

export function receiptsPath(): string | undefined {
  return process.env.COUNTERSIGN_RECEIPTS_PATH?.trim() || undefined;
}

/** Keys that must never be printed. */
export function secretsOf(cfg?: Config): (string | undefined)[] {
  return [cfg?.agentKey, cfg?.ownerKey, process.env.COUNTERSIGN_AGENT_KEY, process.env.COUNTERSIGN_OWNER_KEY];
}

/** Prints `error: <message>` (redacted, no stack) to stderr and returns the exit code (2 = config). */
export function reportError(e: unknown, cfg?: Config): number {
  const safe = redactError(e, secretsOf(cfg));
  console.error(`error: ${safe.message}`);
  return e instanceof ConfigError ? 2 : 1;
}

/** Wraps a command action: runs it, and turns any error into a printed message and an exit code. */
export function action<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      process.exitCode = reportError(e);
    }
  };
}

import type { Config } from "@countersign/core";
import type { GuardedAgent, VaultClient } from "@countersign/sdk";
import type { DemoAccounts } from "@countersign/sdk/sandbox";
import type { Account } from "near-api-js";

export type ScenarioId = "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7";

/** The accounts the scenarios aim at, by role. Sandbox: `<label>.sandbox` (see fixtures/sandbox.json). */
export interface Targets {
  /** Old, active, trusted in the vault. */
  trusted: string;
  /** Fresh look-alike of `trusted` (acme-c0rp vs acme-corp). */
  lookalike: string;
  /** Created hours ago, one transaction. */
  fresh: string;
  /** Reported in the registry by 3 credible reporters. */
  reported: string;
  /** Established but never paid and not trusted. */
  unknown: string;
}

export interface AttackEnv {
  agent: GuardedAgent;
  vault: VaultClient;
  /** Signs with the agent's function-call key, without the SDK. */
  rawAgentAccount: Account;
  accounts: DemoAccounts;
  config: Config;
  /** Addition to the issue's interface: the scenario accounts by role, so scenarios work on any network. */
  targets: Targets;
  /** Optional progress output for long scenarios (A5). Not part of the result. */
  progress?: (msg: string) => void;
}

export interface ScenarioRun {
  actual: string;
  pass: boolean;
  txHash?: string;
  log: string[];
}

export interface Scenario {
  id: ScenarioId;
  title: string;
  expected: string;
  run(env: AttackEnv): Promise<ScenarioRun>;
}

export function targetsFor(root: string): Targets {
  return {
    trusted: `acme-corp.${root}`,
    lookalike: `acme-c0rp.${root}`,
    fresh: `fresh-invoice.${root}`,
    reported: `reported.${root}`,
    unknown: `unknown-payee.${root}`,
  };
}

/**
 * The attack suite (spec §8): 7 scripted prompt-injection scenarios, the end-to-end tests and the demo.
 *
 *   pnpm attacks [--network sandbox|testnet] [--only A1,A4]
 *
 * Sandbox (default): starts a local NEAR sandbox, deploys the prebuilt contracts, files 3 credible
 * registry reports against `reported.sandbox`, and gives every scenario its own vault and agent key,
 * so one scenario's state (A5 drains the daily cap) can't affect another and order doesn't matter.
 * Testnet: uses the vault and agent key from `.env` (Task 12 runs it with a human).
 *
 * Prints `# | scenario | expected | actual | PASS/FAIL | tx`, writes attacks/last-run.json (no keys)
 * and exits 1 on any FAIL.
 */
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, type Config } from "@countersign/core";
import { guardedAgent, redactSecrets, VaultClient } from "@countersign/sdk";
import { startDemoSandbox, type DemoAccounts } from "@countersign/sdk/sandbox";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { NEAR } from "near-api-js/tokens";
import { a1 } from "./scenarios/a1-lookalike.js";
import { a2 } from "./scenarios/a2-fresh.js";
import { a3 } from "./scenarios/a3-reported.js";
import { a4 } from "./scenarios/a4-bypass.js";
import { a5 } from "./scenarios/a5-drip.js";
import { a6 } from "./scenarios/a6-key-abuse.js";
import { a7 } from "./scenarios/a7-control.js";
import { formatTable } from "./table.js";
import { targetsFor, type AttackEnv, type Scenario, type ScenarioId, type Targets } from "./types.js";

export type { AttackEnv, Scenario, ScenarioId } from "./types.js";

export const SCENARIOS: Scenario[] = [a1, a2, a3, a4, a5, a6, a7];
export const LAST_RUN_PATH = fileURLToPath(new URL("../last-run.json", import.meta.url));

const REPORTERS = ["reporter1", "reporter2", "reporter3"];

export interface ScenarioResult {
  id: ScenarioId;
  title: string;
  expected: string;
  actual: string;
  pass: boolean;
  inconclusive?: boolean;
  txHash?: string;
  durationMs: number;
  log: string[];
}

export interface RunResult {
  network: "sandbox" | "testnet";
  startedAt: string;
  durationMs: number;
  passed: boolean;
  results: ScenarioResult[];
}

export interface RunOpts {
  network?: "sandbox" | "testnet";
  /** Scenario ids to run (default: all 7). */
  only?: ScenarioId[];
  /** Progress and transcript lines (default: silent). */
  out?: (line: string) => void;
  /** Testnet only: the variables to read (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export class TestnetNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `--network testnet needs these variables in .env (or the environment): ${missing.join(", ")}. ` +
        "COUNTERSIGN_ATTACK_ROOT is the account under which the scenario accounts live " +
        "(acme-corp.<root>, acme-c0rp.<root>, fresh-invoice.<root>, reported.<root>, unknown-payee.<root>). See .env.example.",
    );
    this.name = "TestnetNotConfiguredError";
  }
}

/** One network's way of handing out a fresh AttackEnv per scenario. */
interface Bench {
  accounts: DemoAccounts;
  targets: Targets;
  secrets: (string | undefined)[];
  envFor(s: Scenario): Promise<AttackEnv>;
  /** Execution order (display order is always A1..A7). */
  order(ids: ScenarioId[]): ScenarioId[];
  stop(): Promise<void>;
}

/**
 * The scenario's env. The agent side never holds the owner key: the runner keeps the full config
 * (owner-side setup happens in the sandbox helper); scenarios only sign with the agent key and read views.
 */
function makeEnv(config: Config, accounts: DemoAccounts, targets: Targets, receiptsDir: string, id: string): Promise<AttackEnv> {
  const agentConfig: Config = { ...config, ownerKey: undefined };
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  return guardedAgent({ config: agentConfig, receiptsPath: join(receiptsDir, `${id}.jsonl`) }).then((agent) => ({
    agent,
    vault: new VaultClient(agentConfig),
    rawAgentAccount: new Account(config.vaultId!, provider, config.agentKey as KeyPairString),
    accounts,
    config: agentConfig,
    targets,
  }));
}

async function sandboxBench(ids: ScenarioId[], out: (l: string) => void): Promise<Bench> {
  out("starting the local NEAR sandbox and deploying registry + vault…");
  const demo = await startDemoSandbox();
  try {
    const targets = targetsFor("sandbox");
    const secrets: (string | undefined)[] = [demo.config.agentKey, demo.config.ownerKey];
    // A3 and A4 read the live registry: 3 credible reporters (fixtures: ≥30 days old, ≥10 tx) report the receiver.
    if (ids.includes("A3") || ids.includes("A4")) {
      for (const r of REPORTERS) {
        const reporter = demo.account(`${r}.sandbox`);
        await reporter.callFunction({
          contractId: demo.config.registryId,
          methodName: "report",
          args: { target: targets.reported, category: "scam", tx_hash: null, note: "took payment, delivered nothing" },
          deposit: NEAR.toUnits("0.02"),
        });
      }
      out(`registry: ${REPORTERS.length} credible reporters reported ${targets.reported}`);
    }
    const receiptsDir = mkdtempSync(join(tmpdir(), "countersign-attacks-"));
    return {
      accounts: demo.accounts,
      targets,
      secrets,
      async envFor(s) {
        // Isolation: a fresh vault and agent key per scenario.
        const config = await demo.provisionVault(`vault-${s.id.toLowerCase()}.sandbox`);
        secrets.push(config.agentKey);
        return makeEnv(config, demo.accounts, targets, receiptsDir, s.id);
      },
      order: (x) => x,
      stop: () => demo.stop(),
    };
  } catch (e) {
    await demo.stop().catch(() => {});
    throw e;
  }
}

/** Reads the testnet config without signing anything. Throws TestnetNotConfiguredError when incomplete. */
export function testnetConfig(env: NodeJS.ProcessEnv): { config: Config; root: string } {
  const need = ["COUNTERSIGN_REGISTRY_ID", "COUNTERSIGN_VAULT_ID", "COUNTERSIGN_AGENT_KEY", "COUNTERSIGN_OWNER_ID", "COUNTERSIGN_ATTACK_ROOT"];
  const missing = need.filter((n) => !env[n]?.trim());
  if (missing.length) throw new TestnetNotConfiguredError(missing);
  const config = loadConfig({ ...env, COUNTERSIGN_NETWORK: "testnet" });
  return { config, root: env.COUNTERSIGN_ATTACK_ROOT!.trim() };
}

async function testnetBench(env: NodeJS.ProcessEnv, out: (l: string) => void): Promise<Bench> {
  const { config, root } = testnetConfig(env);
  const targets = targetsFor(root);
  const accounts: DemoAccounts = {
    owner: config.ownerId!,
    vault: config.vaultId!,
    registry: config.registryId,
    fixtures: Object.values(targets),
  };
  out(`testnet: vault ${config.vaultId}, registry ${config.registryId}, scenario accounts under ${root}`);
  const receiptsDir = mkdtempSync(join(tmpdir(), "countersign-attacks-"));
  return {
    accounts,
    targets,
    secrets: [config.agentKey, config.ownerKey],
    envFor: (s) => makeEnv(config, accounts, targets, receiptsDir, s.id),
    // One shared vault: A5 drains the daily cap, so it runs last.
    order: (x) => [...x.filter((i) => i !== "A5"), ...x.filter((i) => i === "A5")],
    stop: async () => {},
  };
}

export async function runAttacks(opts: RunOpts = {}): Promise<RunResult> {
  const network = opts.network ?? "sandbox";
  const out = opts.out ?? (() => {});
  const ids = opts.only?.length ? SCENARIOS.map((s) => s.id).filter((id) => opts.only!.includes(id)) : SCENARIOS.map((s) => s.id);
  const started = Date.now();
  const bench = network === "testnet" ? await testnetBench(opts.env ?? process.env, out) : await sandboxBench(ids, out);
  const redact = (s: string) => redactSecrets(s, bench.secrets);

  const byId = new Map<ScenarioId, ScenarioResult>();
  try {
    for (const id of bench.order(ids)) {
      const s = SCENARIOS.find((x) => x.id === id)!;
      out(`\n▶ ${s.id} ${s.title}`);
      const t0 = Date.now();
      let r: ScenarioResult;
      try {
        const env = await bench.envFor(s);
        env.progress = (m) => out(`  … ${redact(m)}`);
        const res = await s.run(env);
        r = { id: s.id, title: s.title, expected: s.expected, ...res, durationMs: Date.now() - t0 };
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        r = { id: s.id, title: s.title, expected: s.expected, actual: `error: ${msg}`, pass: false, durationMs: Date.now() - t0, log: [msg] };
      }
      r.actual = redact(r.actual);
      r.log = r.log.map(redact);
      if (r.txHash !== undefined) r.txHash = redact(r.txHash);
      else delete r.txHash;
      for (const line of r.log) out(`  ${line}`);
      out(`  ${r.pass ? "PASS" : r.inconclusive ? "INCONCLUSIVE" : "FAIL"} in ${(r.durationMs / 1000).toFixed(1)}s`);
      byId.set(id, r);
    }
  } finally {
    await bench.stop();
  }
  const results = ids.map((id) => byId.get(id)!);
  return {
    network,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    passed: results.every((r) => r.pass),
    results,
  };
}

export function parseArgs(argv: string[]): { network: "sandbox" | "testnet"; only?: ScenarioId[] } {
  let network: "sandbox" | "testnet" = "sandbox";
  let only: ScenarioId[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i] ?? "";
    if (flag === "--network") {
      const v = value();
      if (v !== "sandbox" && v !== "testnet") throw new Error(`--network must be sandbox or testnet (got "${v}")`);
      network = v;
    } else if (flag === "--only") {
      const list = value().split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
      const known = new Set<string>(SCENARIOS.map((s) => s.id));
      const bad = list.filter((x) => !known.has(x));
      if (bad.length || !list.length) throw new Error(`--only takes ids from A1..A7 (got "${bad.join(",") || "nothing"}")`);
      only = list as ScenarioId[];
    } else if (flag !== "--") {
      throw new Error(`unknown argument "${a}". Usage: pnpm attacks [--network sandbox|testnet] [--only A1,A4]`);
    }
  }
  return { network, only };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.network === "testnet" && existsSync(".env")) process.loadEnvFile(".env");
  const run = await runAttacks({ ...args, out: (l) => console.log(l) });
  console.log(`\n${formatTable(run.results)}\n`);
  const n = run.results.filter((r) => r.pass).length;
  const inconclusive = run.results.filter((r) => r.inconclusive).map((r) => r.id);
  if (inconclusive.length) console.log(`INCONCLUSIVE (not a pass; rerun): ${inconclusive.join(", ")}`);
  console.log(`${n}/${run.results.length} PASS on ${run.network} in ${(run.durationMs / 1000).toFixed(1)}s → ${LAST_RUN_PATH}`);
  writeFileSync(LAST_RUN_PATH, `${JSON.stringify(run, null, 2)}\n`);
  return run.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(redactSecrets(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    },
  );
}

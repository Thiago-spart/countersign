import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ConfigError } from "@countersign/core";
import {
  formatNear,
  InvalidInputError,
  MainnetSigningDisabledError,
  parseNearAmount,
  redactSecrets,
  vaultProvisionActions,
  AGENT_ALLOWANCE,
  AGENT_METHODS,
  checkChainId,
} from "@countersign/sdk";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { NEAR } from "near-api-js/tokens";

/**
 * Default `--fund`, and the floor. vault.wasm is ~195 KB, so its code stake alone is ~1.95 NEAR (1e19
 * yocto per byte); with the account, the agent key, contract state, the batch's gas and ~0.06 NEAR the
 * agent spends prepaying gas, 2 NEAR is NOT enough (measured: the batch fails with "lacks balance ... for state").
 */
export const MIN_FUND = parseNearAmount("3");
export const DEFAULT_RPC_URL = "https://test.rpc.fastnear.com";
const VAULT_WASM = fileURLToPath(new URL("../../../../contracts/res/vault.wasm", import.meta.url));

export interface SetupOpts {
  /** The network-specific part is injectable: `testnet` from the CLI, `sandbox` in tests. */
  network: "testnet" | "sandbox";
  rpcUrl: string;
  ownerId: string;
  /** The owner's full-access key (pays for and signs the account creation). */
  ownerKey: string;
  registryId: string;
  /** NEAR to fund the vault with (decimal string). Default "3"; below 3 is refused. */
  fund?: string;
  envPath?: string;
  wasmPath?: string;
  /**
   * Private (0700) directory for the recovery files, written before the first transaction and kept until
   * `.env` is written and verified (default `.countersign/recovery`): `<vault>.key` (the vault's temporary
   * full-access key) and `<vault>.env` (the finished agent config, including the agent key).
   */
  recoveryDir?: string;
  /** Asks before each transaction. Default: a y/N terminal prompt (default no). Injected by tests only; there is no CLI flag to skip it. */
  confirm?: (question: string) => Promise<boolean>;
  out?: (line: string) => void;
}

export interface SetupResult {
  vaultId: string;
  agentPublicKey: string;
  envPath: string;
}

/** Asks y/N on the terminal. Anything but y/yes is no; a non-interactive stdin is no. */
async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("not a terminal: setup needs a person to confirm each transaction");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Creates `path` (never overwrites) with mode 0600 and flushes it to disk before returning. */
function writePrivateFile(path: string, text: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Fails now, before anything is funded, if `.env` could not be created at the end. */
function preflightEnvPath(envPath: string): void {
  let present = false;
  try {
    lstatSync(envPath); // Also catches dangling symlinks, which existsSync follows and misses.
    present = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (present) throw new Error(`${envPath} already exists; move it away first (setup never overwrites it)`);
  const dir = dirname(resolve(envPath));
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new Error(`cannot write ${envPath}: ${dir} is not an existing directory`);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new Error(`cannot write ${envPath}: ${dir} is not writable`);
  }
}

/** Creates the recovery directory (0700) and refuses one that other users can read. */
function preparePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} must be a private directory (mode 0700, not a symlink); fix it and retry`);
  }
}

/** What the vault's access keys say about the provisioning batch. It is one atomic transaction. */
type BatchState = { kind: "landed" } | { kind: "not-landed" } | { kind: "unknown"; reason: string };

async function readBatchState(
  provider: JsonRpcProvider,
  vaultId: string,
  vaultPublicKey: string,
  agentPublicKey: string,
): Promise<BatchState> {
  let keys: AccessKeyEntry[];
  try {
    keys = (await provider.viewAccessKeyList({ accountId: vaultId })).keys as unknown as AccessKeyEntry[];
  } catch (e) {
    return { kind: "unknown", reason: `reading the keys of ${vaultId} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (verifyVaultKeys(keys, vaultId, agentPublicKey) === null) return { kind: "landed" };
  if (keys.length === 1 && keys[0]!.public_key === vaultPublicKey && keys[0]!.access_key.permission === "FullAccess") {
    return { kind: "not-landed" };
  }
  return { kind: "unknown", reason: `${vaultId} has unexpected keys [${keys.map((k) => k.public_key).join(", ")}]` };
}

/**
 * Creates `vault.<owner>`, deploys the vault, adds the agent's function-call key, deletes the
 * vault's full-access key (same batch), funds it, and writes `.env`. Two transactions, each
 * confirmed first. The owner key is never written to `.env` and no key is ever printed.
 *
 * Both generated keys are on disk (0600, in a 0700 recovery dir) before the first transaction:
 * `<vault>.key` holds the vault's full-access key (the way back while the batch hasn't landed),
 * `<vault>.env` the finished agent config (the way forward once it has). If the batch reports an
 * error, the vault's keys on chain decide which one applies; both files stay until `.env` is
 * written, read back and the vault's keys verified.
 */
export async function runSetup(opts: SetupOpts): Promise<SetupResult> {
  const out = opts.out ?? ((l: string) => console.log(l));
  if ((opts.network as string) === "mainnet") throw new MainnetSigningDisabledError("setup");
  const fund = parseNearAmount(opts.fund ?? "3");
  if (fund < MIN_FUND) {
    throw new InvalidInputError("fund", "must be at least 3 NEAR (the vault code alone locks ~1.95 NEAR, plus state and the gas the agent prepays)");
  }
  const envPath = opts.envPath ?? ".env";
  preflightEnvPath(envPath);
  const ask = opts.confirm ?? promptYesNo;

  const vaultId = `vault.${opts.ownerId}`;
  const provider = new JsonRpcProvider({ url: opts.rpcUrl });
  // The network label alone isn't enough: refuse unless the node itself is on that network
  // (never mainnet), before any prompt, file or transaction.
  checkChainId(opts.network, (await provider.viewNodeStatus()).chain_id, "setup");
  const owner = new Account(opts.ownerId, provider, opts.ownerKey as KeyPairString);
  const wasm = readFileSync(opts.wasmPath ?? VAULT_WASM);
  const secrets = [opts.ownerKey];

  // Only "unknown account" means it is free; any other RPC error (network, rate limit) must not look like "free".
  const exists = await provider.viewAccount({ accountId: vaultId }).then(
    () => true,
    (e: unknown) => {
      if (e instanceof Error && e.name === "AccountDoesNotExistError") return false;
      throw e;
    },
  );
  if (exists) throw new Error(`${vaultId} already exists`);

  const vaultKey = KeyPair.fromRandom("ed25519");
  const agentKey = KeyPair.fromRandom("ed25519");
  const secretsAll = [...secrets, vaultKey.toString(), agentKey.toString()];
  const redact = (e: unknown) => redactSecrets(e instanceof Error ? e.message : String(e), secretsAll);
  const vaultPublicKey = vaultKey.getPublicKey().toString();
  const agentPublicKey = agentKey.getPublicKey().toString();

  const envBody = [
    `COUNTERSIGN_NETWORK=${opts.network}`,
    `COUNTERSIGN_RPC_URL=${opts.rpcUrl}`,
    `COUNTERSIGN_REGISTRY_ID=${opts.registryId}`,
    `COUNTERSIGN_VAULT_ID=${vaultId}`,
    `COUNTERSIGN_AGENT_KEY=${agentKey.toString()}`,
    `COUNTERSIGN_OWNER_ID=${opts.ownerId}`,
    "",
  ];
  const envText = ["# Written by `countersign setup`. The agent's function-call key only; the owner key is not stored here.", ...envBody].join("\n");

  // Both keys exist only in memory until now. Persist them before anything is sent, so an abort, a lost
  // RPC response or a crash at any point leaves a way to the funds. Never printed; only the paths are.
  const recoveryDir = opts.recoveryDir ?? join(".countersign", "recovery");
  const recoveryKey = join(recoveryDir, `${vaultId}.key`);
  const recoveryEnv = join(recoveryDir, `${vaultId}.env`);
  preparePrivateDir(recoveryDir);
  for (const p of [recoveryKey, recoveryEnv]) {
    if (existsSync(p)) throw new Error(`${p} already exists (an earlier setup?); deal with it first, setup never overwrites it`);
  }
  writePrivateFile(recoveryKey, `${vaultKey.toString()}\n`);
  try {
    writePrivateFile(
      recoveryEnv,
      [
        `# Recovery copy written by \`countersign setup\` before any transaction (${new Date().toISOString()}).`,
        `# Vault ${vaultId} on ${opts.network}, owner ${opts.ownerId}; meant for ${envPath}.`,
        `# Vault full-access public key ${vaultPublicKey} (its secret is in ${vaultId}.key; the setup batch deletes it).`,
        `# Agent function-call public key ${agentPublicKey}. If the vault holds exactly this key, this file is your agent config.`,
        ...envBody,
      ].join("\n"),
    );
  } catch (e) {
    rmSync(recoveryKey, { force: true }); // just created above
    throw e;
  }
  const removeRecovery = () => {
    rmSync(recoveryKey, { force: true });
    rmSync(recoveryEnv, { force: true });
  };
  const keptBoth = `kept ${recoveryEnv} (the agent config, valid once the batch has landed) and ${recoveryKey} (the vault's full-access key, valid while it has not)`;

  out(`Setting up ${vaultId} on ${opts.network} (owner ${opts.ownerId}, registry ${opts.registryId})`);
  out(`Recovery files for ${vaultId} saved in ${recoveryDir} (mode 0600) until setup finishes.`);
  out("Step 1/2: create the vault account and fund it");
  if (!(await ask(`Send a transaction from ${opts.ownerId} creating ${vaultId} with ${formatNear(fund)} NEAR?`))) {
    removeRecovery(); // nothing was created yet
    throw new Error("aborted by the user; nothing was sent");
  }
  try {
    await owner.createAccount({
      newAccountId: vaultId,
      publicKey: vaultKey.getPublicKey(),
      nearToTransfer: NEAR.toUnits(formatNear(fund)),
    });
  } catch (e) {
    out(`  creating ${vaultId} did not report success; if it exists anyway, ${recoveryKey} holds its full-access key (kept).`);
    throw e;
  }
  out(`  created ${vaultId}`);

  out("Step 2/2: deploy the vault, run `new`, add the agent's function-call key, delete the full-access key (one batch)");
  const vault = new Account(vaultId, provider, vaultKey.toString() as KeyPairString);
  let failure: string | undefined;
  let declined = false;
  try {
    if (!(await ask(`Send ONE batched transaction from ${vaultId}? It deletes the vault's full-access key; the vault is then reachable only through the agent key and the owner.`))) {
      declined = true;
      failure = "aborted by the user";
    } else {
      await vault.signAndSendTransaction({
        receiverId: vaultId,
        actions: vaultProvisionActions({
          vaultId,
          wasm,
          ownerId: opts.ownerId,
          registryId: opts.registryId,
          agentPublicKey: agentKey.getPublicKey(),
          vaultPublicKey: vaultKey.getPublicKey(),
        }),
      });
    }
  } catch (e) {
    failure = redact(e);
  }
  if (failure !== undefined) {
    out(`  the vault batch did not report success: ${failure}`);
    // An error is not proof that nothing landed (a lost response or timeout looks the same): ask the chain.
    const check = () => readBatchState(provider, vaultId, vaultPublicKey, agentPublicKey);
    let state: BatchState = declined ? { kind: "not-landed" } : await check();
    if (state.kind === "not-landed") {
      out(`  ${vaultId} still holds only its full-access key: the batch has not landed (as of this check).`);
      let cleanup = `; ${keptBoth}`;
      try {
        if (await ask(`Delete ${vaultId} and return its balance to ${opts.ownerId}?`)) {
          await vault.deleteAccount(opts.ownerId);
          out(`  deleted ${vaultId}`);
          removeRecovery();
          cleanup = "";
        }
      } catch (ce) {
        // A batch still in flight races the delete; at most one of them succeeds. See which.
        state = await check();
        cleanup = `; deleting ${vaultId} failed: ${redact(ce)}; ${keptBoth}`;
      }
      if (state.kind === "not-landed") throw new Error(`setup failed: ${failure}${cleanup}`);
    }
    if (state.kind === "unknown") {
      throw new Error(
        `setup failed: ${failure}; could not tell whether the batch landed (${redactSecrets(state.reason, secretsAll)}), so nothing was deleted; ${keptBoth}`,
      );
    }
    out(`  the batch landed anyway: ${vaultId} holds exactly the agent's function-call key`);
  }
  out("  vault deployed, initialised, full-access key deleted");

  try {
    writePrivateFile(envPath, envText);
    if (readFileSync(envPath, "utf8") !== envText) throw new Error("it does not read back what was written");
  } catch (e) {
    throw new Error(
      `${vaultId} is set up, but writing ${envPath} failed: ${redact(e)}. The agent config is kept at ${recoveryEnv} (mode 0600): move it to ${envPath}. ${recoveryKey} only holds the deleted full-access key and can then be removed.`,
    );
  }
  out(`Wrote ${envPath} (mode 0600; contains the agent's key, which is not printed).`);

  // Verify after the key is safely on disk: if this throws, .env and the recovery files are all kept.
  const keys = (await provider.viewAccessKeyList({ accountId: vaultId })).keys;
  const problem = verifyVaultKeys(keys as unknown as AccessKeyEntry[], vaultId, agentPublicKey);
  if (problem) {
    throw new Error(`unexpected access keys on ${vaultId} after setup (${problem}); ${envPath}, ${recoveryEnv} and ${recoveryKey} were kept`);
  }
  removeRecovery();
  out("Keep COUNTERSIGN_OWNER_KEY (your full-access key) in your own shell or keychain for approve / deny / pause.");
  return { vaultId, agentPublicKey, envPath };
}

/** CLI entry: reads the owner key and registry from the environment. */
export async function setupCommand(opts: {
  network: string;
  owner: string;
  fund?: string;
  registry?: string;
  envFile?: string;
}): Promise<void> {
  if (opts.network === "mainnet") throw new MainnetSigningDisabledError("setup");
  if (opts.network !== "testnet") throw new InvalidInputError("network", "setup supports --network testnet");
  const ownerKey = process.env.COUNTERSIGN_OWNER_KEY?.trim();
  if (!ownerKey) throw new ConfigError("COUNTERSIGN_OWNER_KEY is not set (the owner's full-access key)", "COUNTERSIGN_OWNER_KEY");
  const registryId = opts.registry ?? process.env.COUNTERSIGN_REGISTRY_ID?.trim();
  if (!registryId) throw new ConfigError("COUNTERSIGN_REGISTRY_ID is not set (or pass --registry)", "COUNTERSIGN_REGISTRY_ID");
  const res = await runSetup({
    network: "testnet",
    rpcUrl: process.env.COUNTERSIGN_RPC_URL?.trim() || DEFAULT_RPC_URL,
    ownerId: opts.owner,
    ownerKey,
    registryId,
    fund: opts.fund,
    envPath: opts.envFile,
  });
  console.log(`Done. Vault ${res.vaultId}; run \`countersign status\` to check it.`);
}

/** One entry of RPC `view_access_key_list`. */
export interface AccessKeyEntry {
  public_key: string;
  access_key: {
    nonce: number;
    permission: "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
  };
}

/**
 * Setup's post-batch check. The vault must hold exactly one key: the agent's function-call key
 * (`agentPublicKey`), with receiver = the vault, method names exactly AGENT_METHODS (any order;
 * an empty list would allow every method) and allowance AGENT_ALLOWANCE. Returns null when that
 * holds, else what is wrong.
 */
export function verifyVaultKeys(keys: AccessKeyEntry[], vaultId: string, agentPublicKey: string): string | null {
  if (keys.length !== 1) return `${keys.length} keys, expected exactly 1`;
  const [key] = keys;
  if (key!.public_key !== agentPublicKey) return "the key is not the agent key";
  const perm = key!.access_key.permission;
  if (typeof perm !== "object" || !("FunctionCall" in perm)) return "the key is a full-access key";
  const fc = perm.FunctionCall;
  if (fc.receiver_id !== vaultId) return `receiver is ${fc.receiver_id}, expected ${vaultId}`;
  const methods = [...fc.method_names].sort();
  const want = [...AGENT_METHODS].sort();
  if (methods.length !== want.length || methods.some((m, i) => m !== want[i])) {
    return `methods are [${fc.method_names.join(", ")}], expected [${AGENT_METHODS.join(", ")}]`;
  }
  if (fc.allowance === null || BigInt(fc.allowance) !== BigInt(AGENT_ALLOWANCE)) {
    return `allowance is ${fc.allowance ?? "unlimited"}, expected ${AGENT_ALLOWANCE}`;
  }
  return null;
}

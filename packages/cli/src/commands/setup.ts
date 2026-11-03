import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  /** Where the vault's temporary full-access key is kept until the batch succeeds (default `.countersign/recovery`). */
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

/**
 * Creates `vault.<owner>`, deploys the vault, adds the agent's function-call key, deletes the
 * vault's full-access key (same batch), funds it, and writes `.env`. Two transactions, each
 * confirmed first. The owner key is never written to `.env` and no key is ever printed.
 */
export async function runSetup(opts: SetupOpts): Promise<SetupResult> {
  const out = opts.out ?? ((l: string) => console.log(l));
  if ((opts.network as string) === "mainnet") throw new MainnetSigningDisabledError("setup");
  const fund = parseNearAmount(opts.fund ?? "3");
  if (fund < MIN_FUND) {
    throw new InvalidInputError("fund", "must be at least 3 NEAR (the vault code alone locks ~1.95 NEAR, plus state and the gas the agent prepays)");
  }
  const envPath = opts.envPath ?? ".env";
  if (existsSync(envPath)) throw new Error(`${envPath} already exists; move it away first (setup never overwrites it)`);
  const ask = opts.confirm ?? promptYesNo;

  const vaultId = `vault.${opts.ownerId}`;
  const provider = new JsonRpcProvider({ url: opts.rpcUrl });
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

  // The vault's full-access key exists only in memory until the batch deletes it. Persist it first so an
  // abort or crash after funding cannot strand the funds. Never printed; only the path is.
  const recoveryPath = join(opts.recoveryDir ?? join(".countersign", "recovery"), `${vaultId}.key`);
  mkdirSync(dirname(recoveryPath), { recursive: true, mode: 0o700 });
  writeFileSync(recoveryPath, `${vaultKey.toString()}\n`, { mode: 0o600, flag: "wx" });

  out(`Setting up ${vaultId} on ${opts.network} (owner ${opts.ownerId}, registry ${opts.registryId})`);
  out(`Recovery key for ${vaultId} saved to ${recoveryPath} (mode 0600) until setup finishes.`);
  out("Step 1/2: create the vault account and fund it");
  if (!(await ask(`Send a transaction from ${opts.ownerId} creating ${vaultId} with ${formatNear(fund)} NEAR?`))) {
    rmSync(recoveryPath, { force: true }); // nothing was created yet
    throw new Error("aborted by the user; nothing was sent");
  }
  await owner.createAccount({
    newAccountId: vaultId,
    publicKey: vaultKey.getPublicKey(),
    nearToTransfer: NEAR.toUnits(formatNear(fund)),
  });
  out(`  created ${vaultId}`);

  out("Step 2/2: deploy the vault, run `new`, add the agent's function-call key, delete the full-access key (one batch)");
  const vault = new Account(vaultId, provider, vaultKey.toString() as KeyPairString);
  try {
    if (!(await ask(`Send ONE batched transaction from ${vaultId}? It deletes the vault's full-access key; the vault is then reachable only through the agent key and the owner.`))) {
      throw new Error("aborted by the user");
    }
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
  } catch (e) {
    const why = redactSecrets(e instanceof Error ? e.message : String(e), secretsAll);
    out(`  the vault batch did not complete: ${why}`);
    out(`  ${vaultId} still exists with a full-access key that only this process holds.`);
    let cleanup = `; the recovery key is kept at ${recoveryPath}`;
    try {
      if (await ask(`Delete ${vaultId} and return its balance to ${opts.ownerId}?`)) {
        await vault.deleteAccount(opts.ownerId);
        out(`  deleted ${vaultId}`);
        rmSync(recoveryPath, { force: true });
        cleanup = "";
      }
    } catch (ce) {
      cleanup = `; deleting ${vaultId} failed: ${redactSecrets(ce instanceof Error ? ce.message : String(ce), secretsAll)}${cleanup}`;
    }
    throw new Error(`setup failed: ${why}${cleanup}`);
  }
  out("  vault deployed, initialised, full-access key deleted");

  const lines = [
    "# Written by `countersign setup`. The agent's function-call key only; the owner key is not stored here.",
    `COUNTERSIGN_NETWORK=${opts.network}`,
    `COUNTERSIGN_RPC_URL=${opts.rpcUrl}`,
    `COUNTERSIGN_REGISTRY_ID=${opts.registryId}`,
    `COUNTERSIGN_VAULT_ID=${vaultId}`,
    `COUNTERSIGN_AGENT_KEY=${agentKey.toString()}`,
    `COUNTERSIGN_OWNER_ID=${opts.ownerId}`,
    "",
  ];
  writeFileSync(envPath, lines.join("\n"), { mode: 0o600, flag: "wx" });
  out(`Wrote ${envPath} (mode 0600; contains the agent's key, which is not printed).`);

  // Verify after the key is safely on disk: if this throws, .env and the recovery file are both kept.
  const keys = (await provider.viewAccessKeyList({ accountId: vaultId })).keys;
  const full = keys.filter((k) => (k.access_key.permission as unknown) === "FullAccess");
  if (keys.length !== 1 || full.length > 0) {
    throw new Error(`unexpected access keys on ${vaultId} after setup; ${envPath} and ${recoveryPath} were kept`);
  }
  rmSync(recoveryPath, { force: true });
  out("Keep COUNTERSIGN_OWNER_KEY (your full-access key) in your own shell or keychain for approve / deny / pause.");
  return { vaultId, agentPublicKey: agentKey.getPublicKey().toString(), envPath };
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

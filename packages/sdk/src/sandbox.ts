/**
 * Local sandbox for SDK tests and the attack suite (Task 10 reuses this).
 *
 * Starts near-sandbox and deploys the prebuilt contracts from `contracts/res/*.wasm`:
 * - `registry.sandbox` — the registry contract (no init needed).
 * - `owner.sandbox`    — the human owner, with its own full-access key.
 * - `vault.sandbox`    — the vault. Deploy + `new` + the agent key go in ONE batch signed by the vault
 *                        (`new` is #[private]); the same batch deletes the vault's full-access key, so,
 *                        as in production, the vault is reachable only through the agent key.
 * - every existing account in `fixtures/sandbox.json` (e.g. `acme-corp.sandbox`).
 *
 * Fixture approach: the fixture file is keyed by the real sandbox account IDs. The FixtureSource
 * that `createDataSource(config)` builds in sandbox mode reads that same file, so the verdicts
 * match the chain without passing a fixture map around. To add a scenario account, add it to
 * `fixtures/sandbox.json`; this helper creates it on chain.
 */
import "./sandbox-env.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures, type Config } from "@countersign/core";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { NEAR } from "near-api-js/tokens";
import type { Limits } from "./vaultClient.js";
import { vaultProvisionActions } from "./provision.js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";

const DEFAULT_CONTRACTS_DIR = fileURLToPath(new URL("../../../contracts/res/", import.meta.url));

/** Throws a clear error when the prebuilt contracts are missing (instead of a raw ENOENT mid-setup). */
export function assertPrebuiltContracts(dir: string = DEFAULT_CONTRACTS_DIR): void {
  const missing = ["registry", "vault"].filter((n) => !existsSync(join(dir, `${n}.wasm`)));
  if (missing.length) {
    throw new Error(
      `prebuilt contracts missing at contracts/res/ (${missing.map((n) => `${n}.wasm`).join(", ")} not found in ${dir}) — run \`pnpm build:contracts\` (needs Rust)`,
    );
  }
}


export interface SandboxOpts {
  /** NEAR given to the vault (default 20). */
  vaultBalance?: string;
  /** NEAR given to each fixture account (default 5). */
  accountBalance?: string;
  /** Vault limits (default: the contract defaults). */
  limits?: Limits;
  /** Accounts the owner trusts in the vault (default ["acme-corp.sandbox"]). */
  trusted?: string[];
  /** Where registry.wasm and vault.wasm live (default `<repo>/contracts/res`). */
  contractsDir?: string;
}

export interface VaultOpts {
  /** NEAR given to the vault (default: SandboxOpts.vaultBalance, else 20). */
  vaultBalance?: string;
  /** Vault limits (default: SandboxOpts.limits, else the contract defaults). */
  limits?: Limits;
  /** Accounts the owner trusts (default: SandboxOpts.trusted, else ["acme-corp.sandbox"]). */
  trusted?: string[];
}

export interface SandboxEnv {
  sandbox: Sandbox;
  provider: JsonRpcProvider;
  /** The genesis account (`sandbox`), with plenty of NEAR, for extra setup. */
  root: Account;
  owner: Account;
  ids: { owner: string; vault: string; registry: string };
  /** Accounts created from the fixture file. */
  accounts: string[];
  /** SDK config for this sandbox (agent and owner keys included). */
  config: Config;
  /** Create `id` (a sub-account of `sandbox`) with `near` NEAR. Returns its key. */
  createAccount(id: string, near?: string): Promise<KeyPairString>;
  /**
   * Create and provision another vault (same owner and registry, its own agent key), so callers
   * can isolate state such as the daily cap. Returns the SDK config for it.
   */
  provisionVault(vaultId: string, opts?: VaultOpts): Promise<Config>;
  /** A fixture account, signing with its full-access key (e.g. to file registry reports). */
  account(id: string): Account;
  /** Total balance in yoctoNEAR. */
  balance(id: string): Promise<bigint>;
  tearDown(): Promise<void>;
}

export async function startSandbox(opts: SandboxOpts = {}): Promise<SandboxEnv> {
  assertPrebuiltContracts(opts.contractsDir);
  const sandbox = await Sandbox.start({});
  try {
    return await setUp(sandbox, opts);
  } catch (e) {
    await sandbox.tearDown().catch(() => {});
    throw e;
  }
}

async function setUp(sandbox: Sandbox, opts: SandboxOpts): Promise<SandboxEnv> {
  const dir = opts.contractsDir ?? DEFAULT_CONTRACTS_DIR;
  const RES = (name: string) => join(dir, `${name}.wasm`);
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
  const ids = { owner: `owner.${DEFAULT_ACCOUNT_ID}`, vault: `vault.${DEFAULT_ACCOUNT_ID}`, registry: `registry.${DEFAULT_ACCOUNT_ID}` };

  const createAccount = async (id: string, near = "5"): Promise<KeyPairString> => {
    const key = KeyPair.fromRandom("ed25519");
    await root.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: NEAR.toUnits(near) });
    return key.toString() as KeyPairString;
  };

  // Fixture accounts (payees, look-alikes, reporters...). The registry is deployed separately below.
  const fixtures = loadFixtures();
  const accounts = Object.entries(fixtures.accounts)
    .filter(([id, a]) => a.exists !== false && id !== ids.registry && id.endsWith(`.${DEFAULT_ACCOUNT_ID}`))
    .map(([id]) => id);

  const [ownerKey, registryKey, ...fixtureKeys] = await Promise.all([
    createAccount(ids.owner, "10"),
    createAccount(ids.registry, "10"),
    ...accounts.map((id) => createAccount(id, opts.accountBalance ?? "5")),
  ]);
  const keys = new Map<string, KeyPairString>(accounts.map((id, i) => [id, fixtureKeys[i]!]));

  const registry = new Account(ids.registry, provider, registryKey);
  await registry.deployContract(readFileSync(RES("registry")));

  const owner = new Account(ids.owner, provider, ownerKey);

  const provisionVault = async (vaultId: string, vopts: VaultOpts = {}): Promise<Config> => {
    const vaultKey = await createAccount(vaultId, vopts.vaultBalance ?? opts.vaultBalance ?? "20");
    const agentKey = KeyPair.fromRandom("ed25519");
    const vault = new Account(vaultId, provider, vaultKey);
    await vault.signAndSendTransaction({
      receiverId: vaultId,
      actions: vaultProvisionActions({
        vaultId,
        wasm: readFileSync(RES("vault")),
        ownerId: ids.owner,
        registryId: ids.registry,
        limits: vopts.limits ?? opts.limits,
        agentPublicKey: agentKey.getPublicKey(),
        vaultPublicKey: KeyPair.fromString(vaultKey).getPublicKey(),
      }),
    });
    for (const id of vopts.trusted ?? opts.trusted ?? ["acme-corp.sandbox"]) {
      await owner.callFunction({ contractId: vaultId, methodName: "trust", args: { account_id: id }, deposit: 1n });
    }
    return {
      network: "sandbox",
      rpcUrl: sandbox.rpcUrl,
      nearblocksUrl: null,
      registryId: ids.registry,
      vaultId,
      agentKey: agentKey.toString(),
      ownerId: ids.owner,
      ownerKey: ownerKey!,
    };
  };

  const config = await provisionVault(ids.vault);

  const account = (id: string): Account => {
    const key = keys.get(id);
    if (!key) throw new Error(`${id} is not a fixture account of this sandbox`);
    return new Account(id, provider, key);
  };

  return {
    sandbox,
    provider,
    root,
    owner,
    ids,
    accounts,
    config,
    createAccount,
    provisionVault,
    account,
    balance: async (id) => (await provider.viewAccount({ accountId: id })).amount,
    tearDown: () => sandbox.tearDown(),
  };
}

/** Accounts of the demo sandbox. */
export interface DemoAccounts {
  owner: string;
  vault: string;
  registry: string;
  /** Fixture accounts created on chain (payees, look-alikes, reporters). */
  fixtures: string[];
}

/** The sandbox for demos and the CLI: contracts deployed, fixture accounts created, keys in `config`. */
export async function startDemoSandbox(opts: SandboxOpts = {}): Promise<{
  config: Config;
  accounts: DemoAccounts;
  /** See SandboxEnv.provisionVault. */
  provisionVault(vaultId: string, opts?: VaultOpts): Promise<Config>;
  /** See SandboxEnv.account. */
  account(id: string): Account;
  stop(): Promise<void>;
}> {
  const env = await startSandbox(opts);
  return {
    config: env.config,
    accounts: { ...env.ids, fixtures: env.accounts },
    provisionVault: env.provisionVault,
    account: env.account,
    stop: () => env.tearDown(),
  };
}

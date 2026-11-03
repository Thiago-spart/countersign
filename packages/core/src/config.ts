import type { Network } from "./types.js";

export interface Config {
  network: Network;
  rpcUrl: string;
  /** null in sandbox (account data comes from fixtures). */
  nearblocksUrl: string | null;
  /** "" on mainnet when no registry is configured (no reports are read). */
  registryId: string;
  vaultId?: string;
  agentKey?: string;
  ownerId?: string;
  ownerKey?: string;
  nearblocksApiKey?: string;
  /** Overrides the NearBlocks cache dir (`~/.cache/countersign`). */
  cacheDir?: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly variable: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

const NETWORKS: readonly Network[] = ["sandbox", "testnet", "mainnet"];
const DEFAULT_RPC: Record<Network, string | null> = {
  sandbox: null,
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};
const NEARBLOCKS: Record<Network, string | null> = {
  sandbox: null,
  testnet: "https://api-testnet.nearblocks.io/v1",
  mainnet: "https://api.nearblocks.io/v1",
};

/**
 * Builds a Config from COUNTERSIGN_* variables (see .env.example). Empty values count as unset.
 * Missing required variables throw a ConfigError naming the variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const opt = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  const req = (name: string, why: string): string => {
    const v = opt(name);
    if (!v) throw new ConfigError(`${name} is not set (${why})`, name);
    return v;
  };

  const raw = req("COUNTERSIGN_NETWORK", "sandbox | testnet | mainnet");
  if (!NETWORKS.includes(raw as Network)) {
    throw new ConfigError(`COUNTERSIGN_NETWORK must be sandbox, testnet or mainnet (got "${raw}")`, "COUNTERSIGN_NETWORK");
  }
  const network = raw as Network;

  const rpcUrl = opt("COUNTERSIGN_RPC_URL") ?? DEFAULT_RPC[network] ?? req("COUNTERSIGN_RPC_URL", "the sandbox RPC URL");
  const registryId =
    network === "mainnet" ? (opt("COUNTERSIGN_REGISTRY_ID") ?? "") : req("COUNTERSIGN_REGISTRY_ID", "the registry contract account");

  const cfg: Config = { network, rpcUrl, nearblocksUrl: NEARBLOCKS[network], registryId };
  const optional: [keyof Config, string][] = [
    ["vaultId", "COUNTERSIGN_VAULT_ID"],
    ["agentKey", "COUNTERSIGN_AGENT_KEY"],
    ["ownerId", "COUNTERSIGN_OWNER_ID"],
    ["ownerKey", "COUNTERSIGN_OWNER_KEY"],
    ["nearblocksApiKey", "NEARBLOCKS_API_KEY"],
    ["cacheDir", "COUNTERSIGN_CACHE_DIR"],
  ];
  for (const [key, name] of optional) {
    const v = opt(name);
    if (v !== undefined) (cfg as unknown as Record<string, string>)[key] = v;
  }
  return cfg;
}

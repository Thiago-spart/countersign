import type { Config } from "../config.js";
import { DiskCache } from "./cache.js";
import { FixtureSource, loadFixtures, type FixtureData } from "./fixture.js";
import { NearBlocksClient } from "./nearblocks.js";
import { RegistrySource } from "./registry.js";
import { EMPTY_CODE_HASH, RpcClient } from "./rpc.js";
import type { AccountInfo, CodeInfo, DataSource, FetchFn, RegistryReport, SleepFn } from "./types.js";

/** Account data from RPC (existence, code hash) and NearBlocks (age, tx count, deployments). */
export class LiveSource implements DataSource {
  constructor(
    private readonly rpc: RpcClient,
    private readonly nearblocks: NearBlocksClient,
    private readonly registry: Pick<DataSource, "getReports" | "getRebutted">,
  ) {}

  async accountExists(id: string): Promise<boolean> {
    return (await this.rpc.viewAccount(id)) !== null;
  }

  getAccountInfo(id: string): Promise<AccountInfo> {
    return this.nearblocks.getAccountInfo(id);
  }

  async getCodeInfo(id: string): Promise<CodeInfo> {
    const view = await this.rpc.viewAccount(id);
    if (!view || view.codeHash === EMPTY_CODE_HASH) return { isContract: false, lastDeployAt: null };
    return { isContract: true, lastDeployAt: await this.nearblocks.getLastDeployAt(id) };
  }

  getReports(target: string): Promise<RegistryReport[]> {
    return this.registry.getReports(target);
  }

  getRebutted(target: string): Promise<boolean> {
    return this.registry.getRebutted(target);
  }

  get hasRegistry(): boolean {
    return this.registry !== NO_REGISTRY;
  }
}

/** Mainnet without a configured registry: there are no reports to read. */
const NO_REGISTRY: Pick<DataSource, "getReports" | "getRebutted"> = {
  getReports: async () => [],
  getRebutted: async () => false,
};

export interface DataSourceOpts {
  fetch?: FetchFn;
  sleep?: SleepFn;
  cacheDir?: string;
  /** Sandbox only: fixture data instead of `<repo>/fixtures/sandbox.json`. */
  fixtures?: FixtureData;
  now?: () => Date;
}

/** sandbox → fixture account data + live registry reads; testnet/mainnet → RPC + NearBlocks + registry. */
export function createDataSource(cfg: Config, opts: DataSourceOpts = {}): DataSource {
  const http = { fetch: opts.fetch, sleep: opts.sleep };
  const rpc = new RpcClient({ url: cfg.rpcUrl, ...http });
  const registry = cfg.registryId ? new RegistrySource(rpc, cfg.registryId) : NO_REGISTRY;

  if (cfg.network === "sandbox") {
    const fx = new FixtureSource(opts.fixtures ?? loadFixtures(), opts.now);
    return {
      accountExists: (id) => fx.accountExists(id),
      getAccountInfo: (id) => fx.getAccountInfo(id),
      getCodeInfo: (id) => fx.getCodeInfo(id),
      getReports: (t) => registry.getReports(t),
      getRebutted: (t) => registry.getRebutted(t),
      hasRegistry: registry !== NO_REGISTRY,
    };
  }

  if (!cfg.nearblocksUrl) throw new Error(`no NearBlocks URL configured for ${cfg.network}`);
  const nearblocks = new NearBlocksClient({
    baseUrl: cfg.nearblocksUrl,
    apiKey: cfg.nearblocksApiKey,
    cache: new DiskCache({ dir: opts.cacheDir ?? cfg.cacheDir }),
    ...http,
  });
  return new LiveSource(rpc, nearblocks, registry);
}

export { DiskCache, defaultCacheDir, CACHE_TTL_MS } from "./cache.js";
export { FixtureSource, loadFixtures, type FixtureData } from "./fixture.js";
export { NearBlocksClient } from "./nearblocks.js";
export { RegistrySource } from "./registry.js";
export { EMPTY_CODE_HASH, RpcClient } from "./rpc.js";
export * from "./types.js";

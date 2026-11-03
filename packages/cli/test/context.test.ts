import { afterEach, describe, expect, it } from "vitest";
import { cliConfig } from "../src/context.js";

const VARS = [
  "COUNTERSIGN_NETWORK",
  "COUNTERSIGN_RPC_URL",
  "COUNTERSIGN_REGISTRY_ID",
  "COUNTERSIGN_VAULT_ID",
  "COUNTERSIGN_AGENT_KEY",
  "COUNTERSIGN_OWNER_ID",
  "COUNTERSIGN_OWNER_KEY",
];
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("cliConfig --network", () => {
  it("a different --network drops the env's network-specific variables so that network's defaults apply", () => {
    Object.assign(process.env, {
      COUNTERSIGN_NETWORK: "testnet",
      COUNTERSIGN_RPC_URL: "http://127.0.0.1:9",
      COUNTERSIGN_REGISTRY_ID: "x.testnet",
      COUNTERSIGN_VAULT_ID: "vault.x.testnet",
      COUNTERSIGN_AGENT_KEY: "ed25519:agent",
      COUNTERSIGN_OWNER_ID: "x.testnet",
      COUNTERSIGN_OWNER_KEY: "ed25519:owner",
    });
    const cfg = cliConfig("mainnet");
    expect(cfg.network).toBe("mainnet");
    expect(cfg.rpcUrl).toBe("https://free.rpc.fastnear.com");
    expect(cfg.registryId).toBe("");
    expect(cfg.vaultId).toBeUndefined();
    expect(cfg.agentKey).toBeUndefined();
    expect(cfg.ownerId).toBeUndefined();
    expect(cfg.ownerKey).toBeUndefined();
  });

  it("the same --network as the env keeps the env's variables", () => {
    Object.assign(process.env, {
      COUNTERSIGN_NETWORK: "testnet",
      COUNTERSIGN_RPC_URL: "http://127.0.0.1:9",
      COUNTERSIGN_REGISTRY_ID: "x.testnet",
    });
    const cfg = cliConfig("testnet");
    expect(cfg.rpcUrl).toBe("http://127.0.0.1:9");
    expect(cfg.registryId).toBe("x.testnet");
  });
});

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("names COUNTERSIGN_NETWORK when it is missing or empty", () => {
    expect(() => loadConfig({})).toThrow(/COUNTERSIGN_NETWORK/);
    expect(() => loadConfig({ COUNTERSIGN_NETWORK: "" })).toThrow(/COUNTERSIGN_NETWORK/);
    expect(() => loadConfig({ COUNTERSIGN_NETWORK: "devnet" })).toThrow(/COUNTERSIGN_NETWORK/);
  });

  it("testnet: default URLs, registry required", () => {
    expect(() => loadConfig({ COUNTERSIGN_NETWORK: "testnet" })).toThrow(/COUNTERSIGN_REGISTRY_ID/);
    const c = loadConfig({
      COUNTERSIGN_NETWORK: "testnet",
      COUNTERSIGN_REGISTRY_ID: "registry.testnet",
      COUNTERSIGN_VAULT_ID: "vault.alice.testnet",
      COUNTERSIGN_AGENT_KEY: "ed25519:agent",
      COUNTERSIGN_OWNER_ID: "alice.testnet",
      COUNTERSIGN_OWNER_KEY: "ed25519:owner",
      NEARBLOCKS_API_KEY: "nb",
    });
    expect(c).toMatchObject({
      network: "testnet",
      rpcUrl: "https://test.rpc.fastnear.com",
      nearblocksUrl: "https://api-testnet.nearblocks.io/v1",
      registryId: "registry.testnet",
      vaultId: "vault.alice.testnet",
      agentKey: "ed25519:agent",
      ownerId: "alice.testnet",
      ownerKey: "ed25519:owner",
      nearblocksApiKey: "nb",
    });
  });

  it("mainnet: registry optional, read-only defaults", () => {
    const c = loadConfig({ COUNTERSIGN_NETWORK: "mainnet" });
    expect(c).toMatchObject({
      rpcUrl: "https://free.rpc.fastnear.com",
      nearblocksUrl: "https://api.nearblocks.io/v1",
      registryId: "",
    });
    expect(c.vaultId).toBeUndefined();
    expect(c.nearblocksApiKey).toBeUndefined();
  });

  it("sandbox: needs COUNTERSIGN_RPC_URL; no NearBlocks", () => {
    expect(() => loadConfig({ COUNTERSIGN_NETWORK: "sandbox", COUNTERSIGN_REGISTRY_ID: "registry.sandbox" })).toThrow(
      /COUNTERSIGN_RPC_URL/,
    );
    const c = loadConfig({
      COUNTERSIGN_NETWORK: "sandbox",
      COUNTERSIGN_REGISTRY_ID: "registry.sandbox",
      COUNTERSIGN_RPC_URL: "http://127.0.0.1:3030",
    });
    expect(c).toMatchObject({ rpcUrl: "http://127.0.0.1:3030", nearblocksUrl: null });
  });

  it("COUNTERSIGN_RPC_URL overrides other networks; COUNTERSIGN_CACHE_DIR is passed through", () => {
    const c = loadConfig({
      COUNTERSIGN_NETWORK: "mainnet",
      COUNTERSIGN_RPC_URL: "https://rpc.example",
      COUNTERSIGN_CACHE_DIR: "/tmp/x",
    });
    expect(c.rpcUrl).toBe("https://rpc.example");
    expect(c.cacheDir).toBe("/tmp/x");
  });
});

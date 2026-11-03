import { describe, expect, it, vi } from "vitest";
import type { Config } from "@countersign/core";
import { KeyPair } from "near-api-js";
import { checkChainId, chainIdGuard, MainnetSigningDisabledError, NetworkMismatchError, VaultClient } from "../src/index.js";

describe("checkChainId", () => {
  it("refuses a node whose chain_id is mainnet, whatever the configured network", () => {
    for (const n of ["sandbox", "testnet", "mainnet"] as const) {
      expect(() => checkChainId(n, "mainnet", "pay")).toThrow(MainnetSigningDisabledError);
    }
  });
  it("testnet needs chain_id testnet; sandbox needs anything but mainnet/testnet", () => {
    expect(() => checkChainId("testnet", "testnet", "pay")).not.toThrow();
    expect(() => checkChainId("testnet", "localnet", "pay")).toThrow(NetworkMismatchError);
    expect(() => checkChainId("sandbox", "localnet", "pay")).not.toThrow();
    expect(() => checkChainId("sandbox", "testnet", "pay")).toThrow(NetworkMismatchError);
  });
});

describe("chainIdGuard", () => {
  it("fetches the chain id once and caches it", async () => {
    const fetchChainId = vi.fn(async () => "testnet");
    const guard = chainIdGuard("testnet", fetchChainId);
    await guard("pay");
    await guard("report");
    expect(fetchChainId).toHaveBeenCalledTimes(1);
  });
});

describe("VaultClient signs only after the node's chain_id matches", () => {
  const cfg: Config = {
    network: "testnet",
    rpcUrl: "http://127.0.0.1:9", // nothing listens: any real request would fail differently
    nearblocksUrl: null,
    registryId: "registry.testnet",
    vaultId: "vault.x.testnet",
    agentKey: KeyPair.fromRandom("ed25519").toString(),
    ownerId: "x.testnet",
    ownerKey: KeyPair.fromRandom("ed25519").toString(),
  };
  it("a 'testnet' config pointed at a mainnet node refuses every signing method before sending", async () => {
    const chainId = vi.fn(async () => "mainnet");
    const v = new VaultClient(cfg, { chainId });
    await expect(v.pay("bob.testnet", 1n, "")).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    await expect(v.requestApproval("bob.testnet", 1n, "", "r")).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    await expect(v.report("bob.testnet", "scam", "n")).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    await expect(v.approve("0")).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    await expect(v.deny("0")).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    await expect(v.pause()).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    await expect(v.unpause()).rejects.toBeInstanceOf(MainnetSigningDisabledError);
    expect(chainId).toHaveBeenCalledTimes(1);
  });
  it("a sandbox chain id under a testnet config is a NetworkMismatchError", async () => {
    const v = new VaultClient(cfg, { chainId: async () => "localnet" });
    await expect(v.pay("bob.testnet", 1n, "")).rejects.toBeInstanceOf(NetworkMismatchError);
  });
});

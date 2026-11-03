import { describe, expect, it } from "vitest";
import { verifyVaultKeys } from "../src/commands/setup.js";

const VAULT = "vault.owner.testnet";
const AGENT_PK = "ed25519:AgentPublicKey";
const ONE_NEAR = (10n ** 24n).toString();
const fc = (over: Partial<{ allowance: string | null; receiver_id: string; method_names: string[] }> = {}) => ({
  public_key: AGENT_PK,
  access_key: {
    nonce: 1,
    permission: {
      FunctionCall: { allowance: ONE_NEAR, receiver_id: VAULT, method_names: ["pay", "request_approval", "report"], ...over },
    },
  },
});

describe("verifyVaultKeys (setup's post-batch check)", () => {
  it("accepts exactly the agent's function-call key: receiver = vault, the 3 agent methods, 1 NEAR", () => {
    expect(verifyVaultKeys([fc()], VAULT, AGENT_PK)).toBeNull();
    // Method order doesn't matter.
    expect(verifyVaultKeys([fc({ method_names: ["report", "pay", "request_approval"] })], VAULT, AGENT_PK)).toBeNull();
  });

  it.each([
    ["no keys", []],
    ["two keys", [fc(), fc()]],
    ["a full-access key", [{ public_key: AGENT_PK, access_key: { nonce: 1, permission: "FullAccess" } }]],
    ["another public key", [{ ...fc(), public_key: "ed25519:Other" }]],
    ["receiver is not the vault", [fc({ receiver_id: "registry.testnet" })]],
    ["an extra method", [fc({ method_names: ["pay", "request_approval", "report", "withdraw"] })]],
    ["empty method list (= any method)", [fc({ method_names: [] })]],
    ["a missing method", [fc({ method_names: ["pay", "report"] })]],
    ["unlimited allowance", [fc({ allowance: null })]],
    ["a different allowance", [fc({ allowance: (5n * 10n ** 24n).toString() })]],
  ])("rejects %s", (_why, keys) => {
    expect(verifyVaultKeys(keys as never, VAULT, AGENT_PK)).toMatch(/.+/);
  });
});

import { actions, type PublicKey } from "near-api-js";
import { NEAR } from "near-api-js/tokens";
import type { Limits } from "./vaultClient.js";

const TGAS = 10n ** 12n;

/** Methods the agent's function-call key may call on the vault. */
export const AGENT_METHODS = ["pay", "request_approval", "report"];
/** Ruling R3: the agent key's allowance. */
export const AGENT_ALLOWANCE = NEAR.toUnits("1");

export interface ProvisionOpts {
  vaultId: string;
  /** Contents of `contracts/res/vault.wasm`. */
  wasm: Uint8Array;
  ownerId: string;
  registryId: string;
  /** Vault limits (null/undefined = the contract defaults). */
  limits?: Limits | null;
  /** The agent's function-call key. */
  agentPublicKey: PublicKey;
  /** The vault account's full-access key, deleted in the same batch. */
  vaultPublicKey: PublicKey;
}

/**
 * The ONE batch that turns a funded, empty vault account into a production vault. `new` is
 * #[private], so deploy + init must be signed by the vault account itself; the same batch adds the
 * agent's function-call key and deletes the full-access key, so no key with unrestricted access is
 * left. Send it with the vault account as signer and receiver. Shared by `countersign setup` and
 * the sandbox helper.
 */
export function vaultProvisionActions(o: ProvisionOpts) {
  return [
    actions.deployContract(o.wasm),
    actions.functionCall(
      "new",
      { owner_id: o.ownerId, registry_id: o.registryId, limits: o.limits ?? null },
      100n * TGAS,
      0n,
    ),
    actions.addFunctionCallAccessKey(o.agentPublicKey, o.vaultId, AGENT_METHODS, AGENT_ALLOWANCE),
    actions.deleteKey(o.vaultPublicKey),
  ];
}

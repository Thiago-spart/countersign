import type { Network } from "@countersign/core";
import { MainnetSigningDisabledError } from "./errors.js";

/** The RPC node's chain_id doesn't match the configured network. Nothing was signed. */
export class NetworkMismatchError extends Error {
  constructor(
    readonly network: Network,
    readonly chainId: string,
    what = "signing",
  ) {
    super(`${what} refused: COUNTERSIGN_NETWORK is ${network} but the RPC node reports chain_id "${chainId}"`);
    this.name = "NetworkMismatchError";
  }
}

/**
 * Throws unless a node with `chainId` is safe to sign on for `network`: never "mainnet"
 * (MainnetSigningDisabledError, whatever the label says); testnet needs "testnet"; sandbox accepts
 * any chain id except "mainnet" and "testnet".
 */
export function checkChainId(network: Network, chainId: string, what = "signing"): void {
  if (chainId === "mainnet" || network === "mainnet") throw new MainnetSigningDisabledError(what);
  const ok = network === "testnet" ? chainId === "testnet" : chainId !== "testnet";
  if (!ok) throw new NetworkMismatchError(network, chainId, what);
}

/**
 * A guard to await before every signing call: fetches the node's chain_id once (cached; a failed
 * fetch is retried next time) and runs checkChainId.
 */
export function chainIdGuard(network: Network, fetchChainId: () => Promise<string>): (what: string) => Promise<void> {
  let cached: Promise<string> | undefined;
  return async (what) => {
    if (network === "mainnet") throw new MainnetSigningDisabledError(what);
    cached ??= fetchChainId().catch((e: unknown) => {
      cached = undefined;
      throw e;
    });
    checkChainId(network, await cached, what);
  };
}

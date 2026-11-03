import { writeFileSync } from "node:fs";
import { startDemoSandbox } from "@countersign/sdk/sandbox";

/** Starts the demo sandbox, writes `.env.sandbox`, and keeps running until Ctrl-C / SIGTERM. */
export async function sandboxUpCommand(opts: { out?: string }): Promise<void> {
  const outPath = opts.out ?? ".env.sandbox";
  console.log("Starting the local sandbox (first run downloads the binary)...");
  const sb = await startDemoSandbox();
  const c = sb.config;
  // Sandbox-only throwaway keys. The owner key is included so `countersign approve` works in the demo;
  // never reuse this layout for a real vault.
  const lines = [
    "# Written by `countersign sandbox up`. Throwaway sandbox keys; valid only while it runs.",
    `COUNTERSIGN_NETWORK=${c.network}`,
    `COUNTERSIGN_RPC_URL=${c.rpcUrl}`,
    `COUNTERSIGN_REGISTRY_ID=${c.registryId}`,
    `COUNTERSIGN_VAULT_ID=${c.vaultId}`,
    `COUNTERSIGN_AGENT_KEY=${c.agentKey}`,
    `COUNTERSIGN_OWNER_ID=${c.ownerId}`,
    `COUNTERSIGN_OWNER_KEY=${c.ownerKey}`,
    "",
  ];
  writeFileSync(outPath, lines.join("\n"), { mode: 0o600 });
  console.log(`Sandbox running at ${c.rpcUrl}`);
  console.log(`vault ${sb.accounts.vault}, owner ${sb.accounts.owner}, registry ${sb.accounts.registry}`);
  console.log(`Wrote ${outPath} (mode 0600). Use it with: countersign --env-file ${outPath} status`);
  console.log("Press Ctrl-C to stop.");

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      console.log("\nStopping the sandbox...");
      sb.stop().then(resolve, (e: unknown) => {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        resolve();
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

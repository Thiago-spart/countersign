import { JsonRpcProvider } from "near-api-js";
import { VaultClient } from "@countersign/sdk";
import { cliConfig } from "../context.js";
import { formatStatus, STORAGE_BYTE_COST } from "../format.js";

export async function statusCommand(): Promise<void> {
  const config = cliConfig();
  const vault = new VaultClient(config);
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const [paused, limits, spentToday, pending, allowance, account] = await Promise.all([
    vault.isPaused(),
    vault.getLimits(),
    vault.getSpentToday(),
    vault.getPending(),
    vault.keyAllowance(),
    provider.viewAccount({ accountId: vault.vaultId }),
  ]);
  const freeBalance = BigInt(account.amount) - BigInt(account.storage_usage) * STORAGE_BYTE_COST;
  console.log(formatStatus({ vaultId: vault.vaultId, ownerId: config.ownerId, paused, limits, spentToday, pending, allowance, freeBalance }));
}

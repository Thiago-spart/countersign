export { guardedAgent, type GuardedAgent, type GuardedAgentOpts, type Outcome } from "./agent.js";
export {
  VaultClient,
  AGENT_GAS,
  type PayOutcome,
  type VaultCallResult,
  type PendingPayment,
  type Limits,
} from "./vaultClient.js";
export { parseNearAmount, formatNear } from "./amount.js";
export { ReceiptLog, DEFAULT_RECEIPTS_PATH, type Receipt } from "./receipts.js";
export {
  MainnetSigningDisabledError,
  InvalidAmountError,
  InvalidInputError,
  redactSecrets,
  redactError,
} from "./errors.js";
export { vaultProvisionActions, AGENT_METHODS, AGENT_ALLOWANCE, type ProvisionOpts } from "./provision.js";

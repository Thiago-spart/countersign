export type Network = "sandbox" | "testnet" | "mainnet";

export type SignalId =
  | "exists"
  | "lookalike"
  | "registry"
  | "age"
  | "activity"
  | "code_change"
  | "first_contact";

export interface Signal {
  id: SignalId;
  status: "ok" | "unknown";
  points: number;
  reason: string;
  data?: unknown;
}

export type Decision = "allow" | "warn" | "block";

export interface Verdict {
  target: string;
  score: number;
  decision: Decision;
  signals: Signal[];
  reasons: string[];
}

export interface CheckContext {
  network: Network;
  vaultId: string;
  trusted: string[];
  pastPayees: string[];
  now: Date;
}

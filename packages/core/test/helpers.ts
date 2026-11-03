import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SourceUnavailableError,
  type AccountInfo,
  type CodeInfo,
  type DataSource,
  type RegistryReport,
} from "../src/sources/types.js";
import type { CheckContext } from "../src/types.js";

export const NOW = new Date("2026-11-03T12:00:00Z");
export const DAY = 86_400_000;
export const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const fixtureText = (rel: string): string => readFileSync(join(FIXTURES, rel), "utf8");
export const fixtureJson = (rel: string): unknown => JSON.parse(fixtureText(rel));

export const tempCacheDir = (): string => mkdtempSync(join(tmpdir(), "countersign-cache-"));

export const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  network: "sandbox",
  vaultId: "vault.sandbox",
  trusted: [],
  pastPayees: [],
  now: NOW,
  ...over,
});

export interface MemAccount {
  exists?: boolean;
  createdAt: Date | null;
  txCount: number;
  isContract?: boolean;
  lastDeployAt?: Date | null;
}

/** In-memory DataSource. Accounts not listed throw SourceUnavailableError from every account method. */
export function memSource(opts: {
  accounts?: Record<string, MemAccount>;
  reports?: Record<string, RegistryReport[]>;
  rebutted?: string[];
}): DataSource {
  const acc = (id: string): MemAccount => {
    const a = opts.accounts?.[id];
    if (!a) throw new SourceUnavailableError(`mem: no data for ${id}`, { source: "mem" });
    return a;
  };
  return {
    accountExists: async (id) => acc(id).exists ?? true,
    getAccountInfo: async (id): Promise<AccountInfo> => {
      const a = acc(id);
      return { exists: a.exists ?? true, createdAt: a.createdAt, txCount: a.txCount };
    },
    getCodeInfo: async (id): Promise<CodeInfo> => {
      const a = acc(id);
      return { isContract: a.isContract ?? false, lastDeployAt: a.lastDeployAt ?? null };
    },
    getReports: async (t) => opts.reports?.[t] ?? [],
    getRebutted: async (t) => opts.rebutted?.includes(t) ?? false,
  };
}

export const report = (reporter: string, category = "scam"): RegistryReport => ({
  reporter,
  category,
  txHash: null,
  note: "scammed me",
  createdAt: ago(DAY),
});

/** A fetch stub that answers from a route table and records every request URL. */
export interface StubResponse {
  status?: number;
  body?: unknown;
  throws?: Error;
}
export function stubFetch(route: (url: string, init?: RequestInit) => StubResponse | StubResponse[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queues = new Map<string, StubResponse[]>();
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const key = `${url} ${typeof init?.body === "string" ? init.body : ""}`;
    let r: StubResponse;
    const routed = route(url, init);
    if (Array.isArray(routed)) {
      if (!queues.has(key)) queues.set(key, [...routed]);
      const q = queues.get(key)!;
      r = q.length > 1 ? q.shift()! : q[0]!;
    } else r = routed;
    if (r.throws) throw r.throws;
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fn as typeof fetch, calls };
}

export const noSleep = async (_ms: number): Promise<void> => {};

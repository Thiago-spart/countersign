import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import type { Config } from "../src/config.js";
import { loadPolicy } from "../src/policy.js";
import { createDataSource } from "../src/sources/index.js";
import { RegistrySource } from "../src/sources/registry.js";
import { RpcClient } from "../src/sources/rpc.js";
import { SourceUnavailableError } from "../src/sources/types.js";
import { ctx, fixtureJson, noSleep, stubFetch, tempCacheDir, type StubResponse } from "./helpers.js";

const RPC = "https://free.rpc.fastnear.com";
const RECENT = "u_28242dae5307e280.escrow.uprail.near";
const policy = loadPolicy();

interface RpcBody {
  method: string;
  params: { request_type: string; account_id: string; method_name?: string; args_base64?: string };
}
const bodyOf = (init?: RequestInit): RpcBody => JSON.parse(String(init?.body)) as RpcBody;

/** Serves the recorded view_account responses. */
function recordedRpc(_url: string, init?: RequestInit): StubResponse {
  const b = bodyOf(init);
  if (b.params.request_type !== "view_account") return { status: 500 };
  const name = b.params.account_id === "intents.near" ? "intents" : b.params.account_id === RECENT ? "recent" : "unknown";
  return { body: fixtureJson(`rpc/view_account.${name}.json`) };
}

const rpc = (f: typeof fetch) => new RpcClient({ url: RPC, fetch: f, sleep: noSleep });

describe("RpcClient.viewAccount (recorded fixtures)", () => {
  it("UNKNOWN_ACCOUNT -> null (exists: false)", async () => {
    const { fetch } = stubFetch(recordedRpc);
    expect(await rpc(fetch).viewAccount("no-such-account-countersign-zz9.near")).toBeNull();
  });

  it("returns the code hash for an existing account", async () => {
    const { fetch, calls } = stubFetch(recordedRpc);
    expect(await rpc(fetch).viewAccount("intents.near")).toEqual({
      codeHash: "BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk",
    });
    const b = bodyOf(calls[0]!.init);
    expect(b.method).toBe("query");
    expect(b.params).toMatchObject({ request_type: "view_account", finality: "final", account_id: "intents.near" });
  });

  it("legacy UNKNOWN_ACCOUNT shape (result.error string) -> null", async () => {
    const { fetch } = stubFetch(() => ({
      body: { jsonrpc: "2.0", id: "x", result: { error: "account gone.near does not exist while viewing", logs: [] } },
    }));
    expect(await rpc(fetch).viewAccount("gone.near")).toBeNull();
  });

  it("any other RPC error -> SourceUnavailableError", async () => {
    const { fetch } = stubFetch(() => ({
      body: { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNAVAILABLE_SHARD" }, code: -32000, message: "Server error" } },
    }));
    await expect(rpc(fetch).viewAccount("intents.near")).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it("retries 5xx, then gives up with SourceUnavailableError", async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 502 }));
    await expect(rpc(fetch).viewAccount("intents.near")).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(calls).toHaveLength(3);
  });
});

describe("RpcClient.callFunction", () => {
  it("decodes the byte-array JSON result (recorded)", async () => {
    const { fetch, calls } = stubFetch(() => ({ body: fixtureJson("rpc/call_function.wrap.json") }));
    const v = await rpc(fetch).callFunction<string>("wrap.near", "ft_total_supply", {});
    expect(v).toBe("34941811530129255289069186250074");
    const b = bodyOf(calls[0]!.init);
    expect(b.params).toMatchObject({ request_type: "call_function", account_id: "wrap.near", method_name: "ft_total_supply" });
    expect(Buffer.from(b.params.args_base64!, "base64").toString()).toBe("{}");
  });

  it("a contract error in result.error (recorded) -> SourceUnavailableError", async () => {
    const { fetch } = stubFetch(() => ({ body: fixtureJson("rpc/call_function.error.json") }));
    await expect(rpc(fetch).callFunction("wrap.near", "no_such_method", {})).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });
});

const jsonResult = (v: unknown) => ({
  body: { jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from(JSON.stringify(v))], logs: [] } },
});

describe("RegistrySource over RPC", () => {
  it("paginates get_reports until a short page, and parses fields", async () => {
    const all = Array.from({ length: 130 }, (_, i) => ({
      reporter: `r${i}.near`,
      category: "scam",
      tx_hash: i === 0 ? "abc" : null,
      note: "n",
      created_at: "1793713051611301600",
    }));
    const { fetch, calls } = stubFetch((_u, init) => {
      const b = bodyOf(init);
      const args = JSON.parse(Buffer.from(b.params.args_base64!, "base64").toString()) as {
        target: string;
        from_index: number;
        limit: number;
      };
      expect(b.params.account_id).toBe("registry.testnet");
      expect(args.target).toBe("bad.testnet");
      return jsonResult(all.slice(args.from_index, args.from_index + Math.min(args.limit, 100)));
    });
    const reports = await new RegistrySource(rpc(fetch), "registry.testnet").getReports("bad.testnet");
    expect(reports).toHaveLength(130);
    expect(calls).toHaveLength(2);
    expect(reports[0]).toEqual({
      reporter: "r0.near",
      category: "scam",
      txHash: "abc",
      note: "n",
      createdAt: new Date(1793713051611),
    });
  });

  it("getRebutted reads get_summary.rebutted", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResult({ reports: 2, first_seen: "1", last_seen: "2", rebutted: true }),
    );
    expect(await new RegistrySource(rpc(fetch), "registry.testnet").getRebutted("bad.testnet")).toBe(true);
    expect(bodyOf(calls[0]!.init).params.method_name).toBe("get_summary");
  });

  it("a malformed report -> SourceUnavailableError", async () => {
    const { fetch } = stubFetch(() => jsonResult([{ reporter: 5 }]));
    await expect(new RegistrySource(rpc(fetch), "r.testnet").getReports("x.testnet")).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });
});

describe("live DataSource (RPC + NearBlocks)", () => {
  const cfg: Config = {
    network: "mainnet",
    rpcUrl: RPC,
    nearblocksUrl: "https://api.nearblocks.io/v1",
    registryId: "",
  };

  const live = (nbAccount: unknown) =>
    stubFetch((url, init) => {
      if (url === RPC) return recordedRpc(url, init);
      if (url.endsWith("/txns/count")) return { body: { txns: [{ count: "1" }] } };
      if (url.endsWith("/contract/deployments")) return { body: { deployments: [] } };
      return { body: nbAccount };
    });

  it("code_hash 111...1 -> isContract: false, without asking NearBlocks for deployments", async () => {
    const { fetch, calls } = live(fixtureJson("nearblocks/recent.account.json"));
    const ds = createDataSource(cfg, { fetch, sleep: noSleep, cacheDir: tempCacheDir() });
    expect(await ds.getCodeInfo(RECENT)).toEqual({ isContract: false, lastDeployAt: null });
    expect(calls.some((c) => c.url.includes("/contract/deployments"))).toBe(false);
  });

  it("no registry configured -> hasRegistry false; the registry signal says 'no registry on this network'", async () => {
    const { fetch } = live(fixtureJson("nearblocks/recent.account.json"));
    const ds = createDataSource(cfg, { fetch, sleep: noSleep, cacheDir: tempCacheDir() });
    expect(ds.hasRegistry).toBe(false);
    expect(createDataSource({ ...cfg, registryId: "r.near" }, { fetch, sleep: noSleep, cacheDir: tempCacheDir() }).hasRegistry).toBe(true);
    const v = await check(RECENT, ctx({ network: "mainnet" }), ds, policy);
    expect(v.signals.find((s) => s.id === "registry")).toMatchObject({ status: "ok", points: 0, reason: "no registry on this network" });
  });

  it("UNKNOWN_ACCOUNT -> accountExists false", async () => {
    const { fetch } = live({ account: [] });
    const ds = createDataSource(cfg, { fetch, sleep: noSleep, cacheDir: tempCacheDir() });
    expect(await ds.accountExists("no-such-account-countersign-zz9.near")).toBe(false);
  });

  it("RPC finds the account but NearBlocks returns an empty array -> exists: true, age +30 (lag), activity unknown -> 45 warn", async () => {
    const { fetch } = live({ account: [] });
    const ds = createDataSource(cfg, { fetch, sleep: noSleep, cacheDir: tempCacheDir() });
    const v = await check(RECENT, ctx({ network: "mainnet" }), ds, policy);
    const by = Object.fromEntries(v.signals.map((s) => [s.id, s]));
    expect(by.exists).toMatchObject({ status: "ok", data: { exists: true } });
    expect(by.age).toMatchObject({ status: "ok", points: 30 });
    expect(by.age?.reason).toMatch(/not yet indexed/);
    expect(by.activity?.status).toBe("unknown");
    expect(by.activity?.reason).toMatch(/NearBlocks/);
    expect(v.score).toBe(45);
    expect(v.decision).toBe("warn");
  });

  it("a contract (per RPC) with no indexed deployment -> code_change +25", async () => {
    const { fetch } = live(fixtureJson("nearblocks/intents.account.json"));
    const ds = createDataSource(cfg, { fetch, sleep: noSleep, cacheDir: tempCacheDir() });
    expect(await ds.getCodeInfo("intents.near")).toEqual({ isContract: true, lastDeployAt: null });
    const v = await check("intents.near", ctx({ network: "mainnet", pastPayees: ["intents.near"] }), ds, policy);
    expect(v.signals.find((s) => s.id === "code_change")).toMatchObject({
      status: "ok",
      points: 25,
      reason: "contract deployment not yet indexed",
    });
  });

  it("a genesis contract (explicit null created.block_timestamp) with no deployment record -> code_change 0", async () => {
    const { fetch } = live({
      account: [{ account_id: "intents.near", created: { transaction_hash: null, block_timestamp: null } }],
    });
    const ds = createDataSource(cfg, { fetch, sleep: noSleep, cacheDir: tempCacheDir() });
    const v = await check("intents.near", ctx({ network: "mainnet", pastPayees: ["intents.near"] }), ds, policy);
    expect(v.signals.find((s) => s.id === "code_change")).toMatchObject({ status: "ok", points: 0 });
  });

  it("NearBlocks-only outage (RPC healthy) never allows", async () => {
    const { fetch } = stubFetch((url, init) => (url === RPC ? recordedRpc(url, init) : { status: 429 }));
    const ds = createDataSource(cfg, { fetch, sleep: noSleep, cacheDir: tempCacheDir() });
    const v = await check(RECENT, ctx({ network: "mainnet" }), ds, policy);
    expect(v.signals.find((s) => s.id === "age")?.status).toBe("unknown");
    expect(v.decision).toBe("warn");
    expect(v.score).toBeGreaterThanOrEqual(30);
    expect(v.reasons).toContain("some data sources were unavailable");
  });
});

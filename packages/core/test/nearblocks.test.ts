import { beforeEach, describe, expect, it } from "vitest";
import { DiskCache } from "../src/sources/cache.js";
import { NearBlocksClient } from "../src/sources/nearblocks.js";
import { EMPTY_CODE_HASH } from "../src/sources/rpc.js";
import { IndexerLagError, SourceUnavailableError } from "../src/sources/types.js";
import { fixtureJson, noSleep, stubFetch, tempCacheDir, type StubResponse } from "./helpers.js";

const BASE = "https://api.nearblocks.io/v1";
const RECENT = "u_28242dae5307e280.escrow.uprail.near";

/** Serves the recorded NearBlocks responses for intents.near and the recent account. */
function recorded(url: string): StubResponse {
  const m = url.match(/\/account\/([^/]+)(\/.*)?$/);
  if (!m) return { status: 404, body: {} };
  const id = decodeURIComponent(m[1]!);
  const name = id === "intents.near" ? "intents" : id === RECENT ? "recent" : null;
  if (!name) return { status: 200, body: fixtureJson("nearblocks/missing.account.json") };
  const kind = m[2] === "/txns/count" ? "txns-count" : m[2] === "/contract/deployments" ? "deployments" : "account";
  return { status: 200, body: fixtureJson(`nearblocks/${name}.${kind}.json`) };
}

const client = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof NearBlocksClient>[0]> = {}) =>
  new NearBlocksClient({ baseUrl: BASE, fetch: f, sleep: noSleep, cache: new DiskCache({ dir: tempCacheDir() }), ...extra });

describe("NearBlocksClient parsing (recorded fixtures)", () => {
  it("parses createdAt and txCount for intents.near", async () => {
    const { fetch } = stubFetch(recorded);
    const info = await client(fetch).getAccountInfo("intents.near");
    expect(info.exists).toBe(true);
    // block_timestamp 1730495327460329700 ns (a JSON number in the real response)
    expect(info.createdAt?.getTime()).toBe(1730495327460);
    expect(info.txCount).toBe(156796186);
  });

  it("parses the recent account", async () => {
    const { fetch } = stubFetch(recorded);
    const info = await client(fetch).getAccountInfo(RECENT);
    expect(info.createdAt?.getTime()).toBe(1793713051611);
    expect(info.txCount).toBe(1);
  });

  it("lastDeployAt is the max block_timestamp, whatever the order", async () => {
    const real = fixtureJson("nearblocks/intents.deployments.json") as { deployments: unknown[] };
    const { fetch } = stubFetch((url) =>
      url.endsWith("/contract/deployments")
        ? { body: { deployments: [...real.deployments].reverse() } }
        : recorded(url),
    );
    const last = await client(fetch).getLastDeployAt("intents.near");
    expect(last?.getTime()).toBe(1791402796754);
  });

  it("no deployments -> null", async () => {
    const { fetch } = stubFetch(recorded);
    expect(await client(fetch).getLastDeployAt(RECENT)).toBeNull();
  });

  it("genesis account (created.block_timestamp null) -> createdAt null", async () => {
    const { fetch } = stubFetch((url) =>
      url.endsWith("/account/near")
        ? { body: { account: [{ account_id: "near", created: { transaction_hash: null, block_timestamp: null } }] } }
        : { body: { txns: [{ count: "42" }] } },
    );
    const info = await client(fetch).getAccountInfo("near");
    expect(info.createdAt).toBeNull();
    expect(info.txCount).toBe(42);
  });
});

describe("NearBlocksClient retry and cache", () => {
  it("retries twice on 429 and then succeeds", async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.endsWith("/account/intents.near")
        ? [{ status: 429 }, { status: 429 }, recorded(url)]
        : recorded(url),
    );
    const slept: number[] = [];
    const nb = client(fetch, { sleep: async (ms) => void slept.push(ms) });
    const info = await nb.getAccountInfo("intents.near");
    expect(info.txCount).toBe(156796186);
    expect(calls.filter((c) => c.url.endsWith("/account/intents.near"))).toHaveLength(3);
    expect(slept).toEqual([250, 500]);
  });

  it("4 x 429 -> SourceUnavailableError", async () => {
    const { fetch, calls } = stubFetch(() => [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    const slept: number[] = [];
    const nb = client(fetch, { sleep: async (ms) => void slept.push(ms) });
    await expect(nb.getLastDeployAt("intents.near")).rejects.toBeInstanceOf(SourceUnavailableError);
    // At most 3 attempts in total (spec §6.2).
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([250, 500]);
  });

  it("retries 5xx and network errors too", async () => {
    const { fetch } = stubFetch((url) =>
      url.endsWith("/contract/deployments")
        ? [{ status: 503 }, { throws: new TypeError("fetch failed") }, recorded(url)]
        : recorded(url),
    );
    expect((await client(fetch).getLastDeployAt("intents.near"))?.getTime()).toBe(1791402796754);
  });

  it("a non-retryable 4xx fails at once", async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 403, body: { message: "forbidden" } }));
    await expect(client(fetch).getLastDeployAt("intents.near")).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it("a second call within the TTL makes no fetch", async () => {
    const { fetch, calls } = stubFetch(recorded);
    const cache = new DiskCache({ dir: tempCacheDir() });
    const nb = client(fetch, { cache });
    await nb.getAccountInfo("intents.near");
    const n = calls.length;
    expect(n).toBe(2);
    // A fresh client with the same cache dir: still served from disk.
    const nb2 = client(fetch, { cache: new DiskCache({ dir: cache.dir }) });
    expect((await nb2.getAccountInfo("intents.near")).txCount).toBe(156796186);
    expect(calls.length).toBe(n);
  });

  it("refetches after the TTL", async () => {
    const { fetch, calls } = stubFetch(recorded);
    let now = Date.parse("2026-11-03T12:00:00Z");
    const cache = new DiskCache({ dir: tempCacheDir(), now: () => now });
    const nb = client(fetch, { cache });
    await nb.getLastDeployAt("intents.near");
    now += 10 * 60_000 + 1;
    await nb.getLastDeployAt("intents.near");
    expect(calls).toHaveLength(2);
  });

  it("an empty account array -> SourceUnavailableError (indexer lag, not missing)", async () => {
    const { fetch } = stubFetch((url) =>
      url.includes("/txns/count") ? { body: { txns: [{ count: "0" }] } } : { body: { account: [] } },
    );
    await expect(client(fetch).getAccountInfo("fresh.near")).rejects.toBeInstanceOf(IndexerLagError);
  });

  it("the recorded unknown-account shape (no account_id) -> SourceUnavailableError, and is not cached", async () => {
    const { fetch, calls } = stubFetch(recorded);
    const nb = client(fetch);
    await expect(nb.getAccountInfo("nobody-here.near")).rejects.toBeInstanceOf(SourceUnavailableError);
    const n = calls.filter((c) => c.url.endsWith("/account/nobody-here.near")).length;
    await expect(nb.getAccountInfo("nobody-here.near")).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(calls.filter((c) => c.url.endsWith("/account/nobody-here.near")).length).toBe(n + 1);
  });

  it.each([
    ["no created key", { account_id: "x.near" }],
    ["created without block_timestamp", { account_id: "x.near", created: { transaction_hash: "h" } }],
  ])("shape change (%s) -> SourceUnavailableError, not genesis, and not cached", async (_l, row) => {
    const { fetch, calls } = stubFetch((url) =>
      url.includes("/txns/count") ? { body: { txns: [{ count: "50" }] } } : { body: { account: [row] } },
    );
    const nb = client(fetch);
    const err = await nb.getAccountInfo("x.near").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect(err).not.toBeInstanceOf(IndexerLagError);
    await nb.getAccountInfo("x.near").catch(() => {});
    expect(calls.filter((c) => c.url.endsWith("/account/x.near"))).toHaveLength(2);
  });

  it("an unparseable deployment block_timestamp -> SourceUnavailableError", async () => {
    const { fetch } = stubFetch(() => ({
      body: { deployments: [{ transaction_hash: "a", block_timestamp: "1791402796754974903" }, { transaction_hash: "b", block_timestamp: "soon" }] },
    }));
    await expect(client(fetch).getLastDeployAt("c.near")).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it("an empty deployments list is not cached", async () => {
    const { fetch, calls } = stubFetch(() => ({ body: { deployments: [] } }));
    const nb = client(fetch);
    expect(await nb.getLastDeployAt("c.near")).toBeNull();
    expect(await nb.getLastDeployAt("c.near")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("sends Authorization only when an API key is set", async () => {
    const a = stubFetch(recorded);
    await client(a.fetch).getLastDeployAt("intents.near");
    expect(new Headers(a.calls[0]!.init?.headers).get("authorization")).toBeNull();

    const b = stubFetch(recorded);
    await client(b.fetch, { apiKey: "k123" }).getLastDeployAt("intents.near");
    expect(new Headers(b.calls[0]!.init?.headers).get("authorization")).toBe("Bearer k123");
  });

  it("encodes the account id in the path", async () => {
    const { fetch, calls } = stubFetch(() => ({ body: { deployments: [] } }));
    await client(fetch).getLastDeployAt("a/../b.near");
    expect(calls[0]!.url).toBe(`${BASE}/account/a%2F..%2Fb.near/contract/deployments`);
  });
});

describe("NearBlocksClient.getLastDeployAt with the observed code hash", () => {
  const OBSERVED = new Date("2026-11-03T12:00:00Z");
  const OLD = new Date("2026-09-04T12:00:00Z"); // 60 days before OBSERVED
  const MID = new Date("2026-10-04T12:00:00Z"); // 30 days before OBSERVED
  const NEW = new Date("2026-11-03T11:55:00Z"); // just before OBSERVED
  const LATER = new Date("2026-11-03T12:30:00Z");
  const ns = (d: Date) => `${BigInt(d.getTime()) * 1_000_000n}`;

  /** NearBlocks whose deployments list can be changed between calls. */
  function indexer(initial: Date | null) {
    const state = { last: initial };
    const stub = stubFetch(() => ({
      body: { deployments: state.last ? [{ transaction_hash: "t", block_timestamp: ns(state.last) }] : [] },
    }));
    return { state, ...stub };
  }
  const clock = { now: OBSERVED };
  beforeEach(() => {
    clock.now = OBSERVED;
  });
  const hashClient = (f: typeof fetch, dir: string) =>
    client(f, { cache: new DiskCache({ dir, now: () => clock.now.getTime() }), now: () => clock.now });

  it("same hash: served from the cache within the TTL", async () => {
    const { fetch, calls } = indexer(OLD);
    const nb = hashClient(fetch, tempCacheDir());
    expect(await nb.getLastDeployAt("c.near", "A")).toEqual(OLD);
    expect(await nb.getLastDeployAt("c.near", "A")).toEqual(OLD);
    expect(calls).toHaveLength(1);
  });

  it("a changed hash bypasses the cached deployment time", async () => {
    const ix = indexer(OLD);
    const nb = hashClient(ix.fetch, tempCacheDir());
    expect(await nb.getLastDeployAt("c.near", "A")).toEqual(OLD);
    ix.state.last = LATER;
    expect(await nb.getLastDeployAt("c.near", "B")).toEqual(LATER);
    expect(ix.calls).toHaveLength(2);
  });

  it("a changed hash -> at least the observation time, even once the indexer shows a deploy just before it", async () => {
    const ix = indexer(OLD);
    const nb = hashClient(ix.fetch, tempCacheDir());
    await nb.getLastDeployAt("c.near", "A");
    expect(await nb.getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
    // Still lagging on the next check: the refetched old timestamp is not trusted.
    expect(await nb.getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
    // An indexed deploy can't be tied to B; the observation stays a lower bound.
    ix.state.last = NEW;
    expect(await nb.getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
  });

  it("a deploy indexed after the observed change supersedes it (after the cache TTL)", async () => {
    const ix = indexer(OLD);
    const nb = hashClient(ix.fetch, tempCacheDir());
    await nb.getLastDeployAt("c.near", "A");
    expect(await nb.getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
    ix.state.last = LATER;
    clock.now = new Date(LATER.getTime() + 11 * 60_000);
    expect(await nb.getLastDeployAt("c.near", "B")).toEqual(LATER);
  });

  it("an indexer advancing to a different, still-old deploy does not clear the observed change", async () => {
    const ix = indexer(OLD);
    const dir = tempCacheDir();
    const nb = hashClient(ix.fetch, dir);
    await nb.getLastDeployAt("c.near", "A");
    ix.state.last = MID;
    expect(await nb.getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
    expect(await nb.getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
    expect(await hashClient(ix.fetch, dir).getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
  });

  it("the hash change is remembered across client and cache recreation", async () => {
    const ix = indexer(OLD);
    const dir = tempCacheDir();
    await hashClient(ix.fetch, dir).getLastDeployAt("c.near", "A");
    expect(await hashClient(ix.fetch, dir).getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
    expect(await hashClient(ix.fetch, dir).getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
  });

  it("changing back to an earlier hash is still a change", async () => {
    const ix = indexer(OLD);
    const nb = hashClient(ix.fetch, tempCacheDir());
    await nb.getLastDeployAt("c.near", "A");
    ix.state.last = NEW;
    expect(await nb.getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
    // A redeployed later; the indexer still shows B's deploy as the latest.
    clock.now = LATER;
    expect(await nb.getLastDeployAt("c.near", "A")).toEqual(LATER);
  });

  it("A -> no code -> A is a change; the no-code check makes no NearBlocks request", async () => {
    const ix = indexer(OLD);
    const nb = hashClient(ix.fetch, tempCacheDir());
    expect(await nb.getLastDeployAt("c.near", "A")).toEqual(OLD);
    expect(await nb.getLastDeployAt("c.near", EMPTY_CODE_HASH)).toBeNull();
    expect(ix.calls).toHaveLength(1);
    clock.now = LATER;
    expect(await nb.getLastDeployAt("c.near", "A")).toEqual(LATER);
  });

  it("a hash change on a contract with no indexed deployment is not reported as null (genesis)", async () => {
    const ix = indexer(null);
    const nb = hashClient(ix.fetch, tempCacheDir());
    expect(await nb.getLastDeployAt("c.near", "A")).toBeNull();
    expect(await nb.getLastDeployAt("c.near", "B")).toEqual(OBSERVED);
  });

  it("the first observation of an account ignores a cached deployment time", async () => {
    const ix = indexer(OLD);
    const dir = tempCacheDir();
    await hashClient(ix.fetch, dir).getLastDeployAt("c.near"); // no hash: plain cached read
    ix.state.last = NEW;
    expect(await hashClient(ix.fetch, dir).getLastDeployAt("c.near", "B")).toEqual(NEW);
  });
});

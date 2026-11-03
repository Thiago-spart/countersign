import { fetchJson, type HttpOpts } from "./http.js";
import { SourceUnavailableError } from "./types.js";

const SOURCE = "RPC";
/** `view_account.code_hash` of an account with no contract. */
export const EMPTY_CODE_HASH = "11111111111111111111111111111111";

export interface RpcOpts extends HttpOpts {
  url: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const MISSING_RE = /does not exist while viewing/;

function isUnknownAccount(err: unknown): boolean {
  if (typeof err === "string") return MISSING_RE.test(err);
  if (!isObj(err)) return false;
  if (isObj(err.cause) && err.cause.name === "UNKNOWN_ACCOUNT") return true;
  return typeof err.data === "string" && MISSING_RE.test(err.data);
}

const describe = (err: unknown): string => {
  if (typeof err === "string") return err;
  if (isObj(err)) {
    const cause = isObj(err.cause) && typeof err.cause.name === "string" ? err.cause.name : undefined;
    return [cause ?? err.name, typeof err.data === "string" ? err.data : err.message].filter(Boolean).join(": ");
  }
  return JSON.stringify(err);
};

/** Minimal read-only NEAR JSON-RPC client (`query` view_account / call_function). No signing. */
export class RpcClient {
  constructor(private readonly opts: RpcOpts) {}

  private async query(params: Record<string, unknown>): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
    const body = await fetchJson(
      SOURCE,
      this.opts.url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "countersign", method: "query", params: { finality: "final", ...params } }),
      },
      this.opts,
    );
    if (!isObj(body)) throw new SourceUnavailableError(`${SOURCE}: malformed response`, { source: SOURCE });
    if (body.error !== undefined) return { error: body.error };
    if (!isObj(body.result)) throw new SourceUnavailableError(`${SOURCE}: response has no result`, { source: SOURCE });
    // Older nodes report query errors as `result.error` (a string).
    if (body.result.error !== undefined) return { error: body.result.error };
    return { result: body.result };
  }

  /** null when the account does not exist (UNKNOWN_ACCOUNT); throws SourceUnavailableError otherwise. */
  async viewAccount(accountId: string): Promise<{ codeHash: string } | null> {
    const { result, error } = await this.query({ request_type: "view_account", account_id: accountId });
    if (error !== undefined) {
      if (isUnknownAccount(error)) return null;
      throw new SourceUnavailableError(`${SOURCE}: view_account ${accountId} failed: ${describe(error)}`, { source: SOURCE });
    }
    const codeHash = result?.code_hash;
    if (typeof codeHash !== "string") throw new SourceUnavailableError(`${SOURCE}: view_account has no code_hash`, { source: SOURCE });
    return { codeHash };
  }

  /** Calls a view method with JSON args and parses the JSON return value. */
  async callFunction<T = unknown>(contractId: string, method: string, args: unknown): Promise<T> {
    const { result, error } = await this.query({
      request_type: "call_function",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (error !== undefined) {
      throw new SourceUnavailableError(`${SOURCE}: ${contractId}.${method} failed: ${describe(error)}`, { source: SOURCE });
    }
    const bytes = result?.result;
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      throw new SourceUnavailableError(`${SOURCE}: ${contractId}.${method} returned no bytes`, { source: SOURCE });
    }
    try {
      return JSON.parse(Buffer.from(bytes as number[]).toString("utf8")) as T;
    } catch (e) {
      throw new SourceUnavailableError(`${SOURCE}: ${contractId}.${method} returned invalid JSON`, { source: SOURCE, cause: e });
    }
  }
}

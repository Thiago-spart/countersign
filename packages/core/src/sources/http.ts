import { SourceUnavailableError, defaultSleep, type FetchFn, type SleepFn } from "./types.js";

/** Waits before each retry: 1 attempt + 3 retries. */
export const RETRY_BACKOFF_MS = [250, 500, 1000] as const;
const REQUEST_TIMEOUT_MS = 10_000;

export interface HttpOpts {
  fetch?: FetchFn;
  sleep?: SleepFn;
}

const retryable = (status: number) => status === 429 || status >= 500;

/**
 * Fetches and parses JSON. Retries on 429, 5xx and network errors with backoff 250/500/1000 ms,
 * then throws SourceUnavailableError. Other non-2xx statuses and bad JSON fail at once.
 */
export async function fetchJson(
  source: string,
  url: string,
  init: RequestInit,
  opts: HttpOpts = {},
): Promise<unknown> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  let last = "";
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await f(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      last = `network error: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (res) {
      if (res.ok) {
        const text = await res.text();
        try {
          return JSON.parse(text) as unknown;
        } catch (e) {
          throw new SourceUnavailableError(`${source}: invalid JSON from ${url}`, { source, cause: e });
        }
      }
      last = `HTTP ${res.status}`;
      if (!retryable(res.status)) break;
    }
    const wait = RETRY_BACKOFF_MS[attempt];
    if (wait === undefined) break;
    await sleep(wait);
  }
  throw new SourceUnavailableError(`${source}: ${last} (${url})`, { source });
}

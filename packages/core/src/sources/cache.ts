import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CACHE_TTL_MS = 10 * 60_000;

/** `$COUNTERSIGN_CACHE_DIR`, else `~/.cache/countersign`. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COUNTERSIGN_CACHE_DIR || join(homedir(), ".cache", "countersign");
}

interface Entry {
  url: string;
  storedAt: number;
  body: unknown;
}

/**
 * One JSON file per URL, valid for `ttlMs`. Cache failures (unwritable dir, corrupt file)
 * are treated as misses and never fail a request.
 */
export class DiskCache {
  readonly dir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { dir?: string; ttlMs?: number; now?: () => number } = {}) {
    this.dir = opts.dir ?? defaultCacheDir();
    this.ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  private file(url: string): string {
    return join(this.dir, `${createHash("sha256").update(url).digest("hex")}.json`);
  }

  /** `ttlMs` overrides the cache-wide TTL for this read (e.g. Infinity for state that must persist). */
  get(url: string, ttlMs: number = this.ttlMs): unknown {
    try {
      const e = JSON.parse(readFileSync(this.file(url), "utf8")) as Entry;
      const age = this.now() - e.storedAt;
      if (e.url !== url || !(age >= 0 && age <= ttlMs)) return undefined;
      return e.body;
    } catch {
      return undefined;
    }
  }

  set(url: string, body: unknown): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const path = this.file(url);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ url, storedAt: this.now(), body } satisfies Entry));
      renameSync(tmp, path);
    } catch {
      // best effort
    }
  }
}

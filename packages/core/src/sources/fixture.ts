import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  SourceUnavailableError,
  type AccountInfo,
  type CodeInfo,
  type DataSource,
  type RegistryReport,
} from "./types.js";

const SOURCE = "fixture";
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const RELATIVE_RE = /^-(\d+(?:\.\d+)?)([smhd])$/;

/** A fixture time: ISO-8601, or relative to now like "-2h", "-3d", "-90m". */
const TimeStr = z.string().refine((s) => RELATIVE_RE.test(s) || !Number.isNaN(Date.parse(s)), {
  message: 'expected ISO-8601 or a relative time like "-2h" / "-3d"',
});

const AccountSchema = z
  .object({
    exists: z.boolean().optional(),
    createdAt: TimeStr.nullable().optional(),
    txCount: z.number().int().nonnegative().optional(),
    isContract: z.boolean().optional(),
    lastDeployAt: TimeStr.nullable().optional(),
  })
  .strict()
  .refine((a) => a.exists === false || (a.createdAt !== undefined && a.txCount !== undefined), {
    message: "an existing account needs createdAt (null = genesis) and txCount",
  });

const ReportSchema = z
  .object({
    reporter: z.string(),
    category: z.string(),
    txHash: z.string().nullable().optional(),
    note: z.string(),
    createdAt: TimeStr,
  })
  .strict();

const FixtureSchema = z
  .object({
    $comment: z.string().optional(),
    accounts: z.record(z.string(), AccountSchema),
    reports: z.record(z.string(), z.array(ReportSchema)).optional(),
    rebutted: z.array(z.string()).optional(),
  })
  .strict();

export type FixtureData = z.input<typeof FixtureSchema>;
type Parsed = z.output<typeof FixtureSchema>;

const DEFAULT_FIXTURES = fileURLToPath(new URL("../../../../fixtures/sandbox.json", import.meta.url));

function validate(data: unknown, where: string): Parsed {
  const r = FixtureSchema.safeParse(data);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid fixtures ${where}: ${detail}`, { cause: r.error });
  }
  return r.data;
}

/** Load and validate a fixtures file (default `<repo>/fixtures/sandbox.json`). */
export function loadFixtures(path: string = DEFAULT_FIXTURES): FixtureData {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  validate(data, path);
  return data as FixtureData;
}

/**
 * Serves account data from recorded/handwritten fixtures (sandbox mode). The fixture is the whole
 * world: an account it does not list does not exist, and its info is unavailable.
 */
export class FixtureSource implements DataSource {
  private readonly data: Parsed;

  constructor(
    data: FixtureData,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.data = validate(data, "(inline)");
  }

  private time(s: string): Date {
    const m = RELATIVE_RE.exec(s);
    if (m) return new Date(this.now().getTime() - Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]);
    return new Date(s);
  }

  private account(id: string) {
    const a = this.data.accounts[id];
    if (!a || a.exists === false) {
      throw new SourceUnavailableError(`fixture: no account data for ${id}`, { source: SOURCE });
    }
    return a;
  }

  async accountExists(id: string): Promise<boolean> {
    const a = this.data.accounts[id];
    return a !== undefined && a.exists !== false;
  }

  async getAccountInfo(id: string): Promise<AccountInfo> {
    const a = this.account(id);
    return { exists: true, createdAt: a.createdAt ? this.time(a.createdAt) : null, txCount: a.txCount ?? 0 };
  }

  async getCodeInfo(id: string): Promise<CodeInfo> {
    const a = this.account(id);
    return { isContract: a.isContract ?? false, lastDeployAt: a.lastDeployAt ? this.time(a.lastDeployAt) : null };
  }

  async getReports(target: string): Promise<RegistryReport[]> {
    return (this.data.reports?.[target] ?? []).map((r) => ({
      reporter: r.reporter,
      category: r.category,
      txHash: r.txHash ?? null,
      note: r.note,
      createdAt: this.time(r.createdAt),
    }));
  }

  async getRebutted(target: string): Promise<boolean> {
    return this.data.rebutted?.includes(target) ?? false;
  }
}

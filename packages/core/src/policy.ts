import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const nonNeg = z.number().finite().nonnegative();

const PolicySchema = z
  .object({
    thresholds: z
      .object({ warn: nonNeg, block: nonNeg })
      .refine((t) => t.warn < t.block, {
        message: "thresholds.warn must be less than thresholds.block",
      }),
    unknownPoints: nonNeg,
    exists: z.object({ missingDecision: z.literal("block") }),
    lookalike: z.object({
      maxDistance: nonNeg,
      minLabelLength: nonNeg,
      points: nonNeg,
    }),
    registry: z.object({
      perReport: nonNeg,
      cap: nonNeg,
      rebuttalFactor: nonNeg,
      credibilityAgeDays: nonNeg,
      credibilityMinTx: nonNeg,
      lowActivityFactor: nonNeg,
    }),
    age: z.object({ under1dPoints: nonNeg, under7dPoints: nonNeg }),
    activity: z.object({ minTx: nonNeg, points: nonNeg }),
    codeChange: z.object({ withinDays: nonNeg, points: nonNeg }),
    firstContact: z.object({ points: nonNeg }),
    trustedSkips: z.array(
      z.enum(["exists", "lookalike", "registry", "age", "activity", "code_change", "first_contact"]),
    ),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

const DEFAULT_POLICY_PATH = fileURLToPath(new URL("../../../policy.json", import.meta.url));

/** Load and validate a policy file. Defaults to `<repo>/policy.json`, independent of cwd. */
export function loadPolicy(path: string = DEFAULT_POLICY_PATH): Policy {
  const json: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = PolicySchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid policy ${path}: ${detail}`, { cause: parsed.error });
  }
  return parsed.data;
}

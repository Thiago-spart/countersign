/** One row of the results table. */
export interface Row {
  id: string;
  title: string;
  expected: string;
  actual: string;
  pass: boolean;
  txHash?: string;
}

const HEADERS = ["#", "scenario", "expected", "actual", "PASS/FAIL", "tx"] as const;

/** Plain-text table `# | scenario | expected | actual | PASS/FAIL | tx` (spec §8). */
export function formatTable(rows: Row[]): string {
  const cells = rows.map((r) => [r.id, r.title, r.expected, r.actual, r.pass ? "PASS" : "FAIL", r.txHash ?? "-"]);
  const all = [[...HEADERS], ...cells];
  const widths = HEADERS.map((_, c) => Math.max(...all.map((row) => row[c]!.length)));
  const line = (row: string[]) => row.map((cell, c) => cell.padEnd(widths[c]!)).join(" | ").trimEnd();
  const sep = widths.map((w) => "-".repeat(w)).join("-|-");
  return [line(all[0]!), sep, ...cells.map(line)].join("\n");
}

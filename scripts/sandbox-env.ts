import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// near-sandbox downloads its binary to os.tmpdir() then rename()s it into node_modules, which
// fails with EXDEV when /tmp is a tmpfs. Point TMPDIR at the repo (same filesystem) before
// Sandbox.start(). Import this module first in any script that starts a sandbox.
const tmp = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "tmp");
mkdirSync(tmp, { recursive: true });
process.env.TMPDIR = tmp;

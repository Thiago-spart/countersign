import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// near-sandbox downloads its binary to os.tmpdir() then rename()s it into node_modules, which
// fails with EXDEV when /tmp is a tmpfs. Point TMPDIR at the repo (same filesystem) before
// Sandbox.start(). Import this module before `near-sandbox` (same as scripts/sandbox-env.ts).
const tmp = fileURLToPath(new URL("../../../../.cache/tmp", import.meta.url));
mkdirSync(tmp, { recursive: true });
process.env.TMPDIR = tmp;

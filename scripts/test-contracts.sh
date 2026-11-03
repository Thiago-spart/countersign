#!/usr/bin/env bash
# Runs the contract tests. The Rust sandbox tests download the near-sandbox binary to TMPDIR and
# rename() it into place, which fails with EXDEV when /tmp is a tmpfs. Point TMPDIR at the repo
# (same filesystem), as scripts/sandbox-env.ts does for the Node side.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
export TMPDIR="$root/.cache/tmp"
mkdir -p "$TMPDIR"
cd "$root/contracts" && cargo test "$@"

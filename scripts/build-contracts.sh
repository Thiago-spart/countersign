#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/contracts/res"
for c in registry vault; do
  (cd "$root/contracts/$c" && cargo near build non-reproducible-wasm)
  cp "$root/contracts/target/near/$c/$c.wasm" "$root/contracts/res/$c.wasm" 2>/dev/null \
    || cp "$root/contracts/$c/target/near/$c.wasm" "$root/contracts/res/$c.wasm"
done

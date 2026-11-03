#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/contracts/res"
# Panic strings embed source paths. Remap the cargo home (registry and git
# checkouts) and the repo root so the wasm holds no local path or username.
# cargo-near's --env RUSTFLAGS replaces its default `-C link-arg=-s` (it keeps
# `--cfg near`), so that flag is repeated here. Paths must not contain spaces.
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
rustflags="-C link-arg=-s --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$root=/countersign"
for c in registry vault; do
  (cd "$root/contracts/$c" && cargo near build non-reproducible-wasm --env "RUSTFLAGS=$rustflags")
  cp "$root/contracts/target/near/$c/$c.wasm" "$root/contracts/res/$c.wasm" 2>/dev/null \
    || cp "$root/contracts/$c/target/near/$c.wasm" "$root/contracts/res/$c.wasm"
done

#!/usr/bin/env bash
# Build the compile-only MicroHs WASM slice + its artifacts (PLAN.md Phase 0).
# Run inside the pinned toolchain:
#   nix-shell nix/shell.nix --run ./nix/build-mhs-wasm.sh
#
# Produces (under nix/out/, git-ignored — vendored as a hosted release asset per
# ADR 0007, NOT committed to git history):
#   - mhs-compile.wasm + mhs-compile.js   the compile-only slice (compileToComb)
#   - base.pkg                            the serialized primitive-free Prelude
#   - examples/*.hs                       curated primitive-free programs
#   - check                              the differential-oracle reducer (iota/check)
#
# Prerequisite: the MicroHs fork at $MHS has the changes in nix/FORK-CHANGES.md
# (compileToComb entry point, char-literal -> Scott Nat desugaring, primitive-free
# Prelude). This script is the reproducible runner around that fork.
set -euo pipefail

MHS="${MHS:-../MicroHs}"
OUT="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$OUT/examples"

[ -d "$MHS" ] || { echo "MicroHs fork not found at $MHS (set \$MHS)"; exit 1; }
command -v emcc >/dev/null || { echo "emcc not in PATH — run inside nix-shell nix/shell.nix"; exit 1; }

echo "==> 1. GHC-built compiler (for combinator dumps / bootstrap)"
make -C "$MHS" bin/gmhs

echo "==> 2. differential-oracle reducer (iota/check)"
ghc -O0 -o "$OUT/check" "$MHS/iota/Check.hs"

echo "==> 3. compile-only WASM slice via Emscripten"
# MicroHs already has an emscripten/web target; the fork trims it to the compiler
# (no REPL/FFI) and exposes compileToComb. Adjust the target name to the fork's
# Makefile (e.g. web-mhs / mhs-embed). The slice + base.pkg are the vendored blob.
make -C "$MHS" CC="emcc" mhs-wasm || {
  echo "NOTE: 'mhs-wasm' target not present in the fork yet — see nix/FORK-CHANGES.md."
  echo "      Once the fork exposes a compile-only emscripten target, this step emits the blob."
  exit 2
}
cp "$MHS"/generated/mhs-compile.{wasm,js} "$OUT/" 2>/dev/null || true
cp "$MHS"/generated/base.pkg "$OUT/" 2>/dev/null || true

echo "==> 4. curated primitive-free example programs"
cp "$MHS"/iota-examples/programs/*.hs "$OUT/examples/" 2>/dev/null || true

echo "==> done. Artifacts in $OUT (host these; do not commit — ADR 0007)."

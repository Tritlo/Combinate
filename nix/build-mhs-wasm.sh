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

echo "==> 3. the in-browser compiler artifact"
# The browser compiler is the MicroHs compiler cross-compiled to JS (the same
# compiler as gmhs, so it supports -ddump-combinator). The prebuilt
# web-mhs/mhs-embed.js IS that artifact — vendor it. A fresh `make mhs.js`
# (bin/mhs -temscripten MicroHs.Main) self-hosts the whole compiler and needs ~GB
# of RAM (it OOMs on small machines / this sandbox), so we don't run it here; on a
# beefy box `make -C $MHS mhs.js` (or via gmhs) regenerates it.
if [ -f "$MHS/web-mhs/mhs-embed.js" ]; then
  cp "$MHS/web-mhs/mhs-embed.js" "$OUT/"
  echo "    vendored web-mhs/mhs-embed.js ($(wc -c < "$OUT/mhs-embed.js") bytes)"
else
  echo "    NOTE: no prebuilt mhs-embed.js; build it (needs ~GB RAM): make -C $MHS mhs.js"
fi

echo "==> 4. curated primitive-free example programs"
cp "$MHS"/iota-examples/programs/*.hs "$OUT/examples/" 2>/dev/null || true

echo "==> done. Artifacts in $OUT (host these; do not commit — ADR 0007)."

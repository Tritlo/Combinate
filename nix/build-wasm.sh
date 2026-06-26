#!/usr/bin/env bash
# Build the headless MicroHs → WASM *batch* compiler blob from the vendored fork
# (vendor/microhs), for Combinate's in-browser live Haskell→ι compile (ADR 0007).
# Run inside the pinned toolchain:
#
#   nix-shell nix/shell.nix --run ./nix/build-wasm.sh
#
# Produces (git-ignored — public/vendor/ is a hosted asset, NOT committed):
#   public/vendor/mhs/mhs-batch.js   one-shot batch compiler for a browser Worker,
#                                    with the base-package SOURCE embedded at /lib.
#
# Approach ("path 2"): the GHC-built front-end `gmhs` does everything. We deliberately
# avoid the self-hosted `bin/mhs` and its two runtime-only features, because in this
# environment they don't work:
#   - bin/mhs OOMs on *any* program (eval.c mmalloc fails) — a runtime portability bug.
#   - `-z` (compress) and `.pkg` serialization are eval-runtime features absent from
#     the GHC build ("not available with ghc"), so gmhs can't use --embed-packages/-z.
# Instead: build with gmhs WITHOUT -z (emcc handles the uncompressed combinator array
# fine — the old `make mhs.js` OOM was always bin/mhs, not emcc), and ship base as
# SOURCE embedded in the WASM filesystem (emcc --embed-file lib@/lib) rather than as a
# serialized package. The worker compiles `Ex.hs` against it with `-i. -i/lib`.
#
# The batch emscripten target is what makes a HEADLESS compile work: MEMFS
# (FORCE_FILESYSTEM) + EXIT_RUNTIME (so stdout flushes on main's return — the stock
# [emscripten_web] playground build lacks this, which is why its dump was lost) and
# NO ASYNCIFY / USE_WEB_INPUT.
#
# NOTE (open, runtime side): `MicroHs.Main` defaults to the interactive REPL; driving
# the blob to *batch*-compile headless (the right callMain/args + search path) is the
# remaining work on the worker side — it is not a build problem.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MHS="$ROOT/vendor/microhs"
OUT="$ROOT/public/vendor/mhs"

command -v emcc >/dev/null || { echo "emcc not found — run inside: nix-shell nix/shell.nix"; exit 1; }
command -v ghc  >/dev/null || { echo "ghc not found — run inside: nix-shell nix/shell.nix"; exit 1; }
command -v cc   >/dev/null || { echo "cc not found — run inside: nix-shell nix/shell.nix"; exit 1; }
[ -d "$MHS/src" ] || { echo "submodule empty — run: git submodule update --init vendor/microhs"; exit 1; }

mkdir -p "$OUT"
cd "$MHS"

echo "==> 1. build the GHC-driven MicroHs front-end (gmhs)"
make bin/gmhs

echo "==> 2. ensure the headless batch target (MEMFS + EXIT_RUNTIME) embeds base at /lib"
if ! grep -q "emscripten_batch\b" mhs.conf 2>/dev/null; then
  cat >> mhs.conf <<'CONF'

-- Headless one-shot batch compile in a browser Worker (Combinate live compile):
-- MEMFS + EXIT_RUNTIME (flush stdout on exit), no ASYNCIFY / USE_WEB_INPUT, and the
-- base-package SOURCE embedded at /lib (gmhs can't serialize a .pkg).
[emscripten_batch]
cc = "emcc"
ccflags = "-O3 --embed-file lib@/lib -sEXPORTED_RUNTIME_METHODS=['FS','callMain'] -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH -sTOTAL_STACK=5MB -sSINGLE_FILE -sEXIT_RUNTIME -Wno-address-of-packed-member"
cclibs = "-lm"
conf = "unix"
CONF
  echo "    added [emscripten_batch]"
fi

echo "==> 3. compile MicroHs.Main → mhs-batch.js (gmhs, no -z, base from -ilib + embedded /lib)"
./bin/gmhs -temscripten_batch -i -imhs -isrc -ilib MicroHs.Main -o "$OUT/mhs-batch.js"

echo "==> done. $OUT/mhs-batch.js ($(wc -c < "$OUT/mhs-batch.js") bytes)."
echo "    git-ignored (public/vendor/). The worker compiles Ex.hs with: -ddump-combinator -i. -i/lib Ex"

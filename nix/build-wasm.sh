#!/usr/bin/env bash
# Build the headless MicroHs → WASM *batch* compiler blob from the vendored fork
# (vendor/microhs), for Combinate's in-browser live Haskell→ι compile (ADR 0007).
# Run inside the pinned toolchain:
#
#   nix-shell nix/shell.nix --run ./nix/build-wasm.sh
#
# Produces (git-ignored — public/vendor/ is a hosted asset, NOT committed):
#   public/vendor/mhs/mhs-batch.js   one-shot batch compiler for a browser Worker
#
# Why a *batch* blob, not the stock interactive web blob: the playground build
# (`[emscripten_web]`) links ASYNCIFY + USE_WEB_INPUT and NO EXIT_RUNTIME — so a
# headless `-ddump-combinator` produces the dump but never flushes stdout on main's
# return (the dump is lost). The batch target below uses MEMFS (FORCE_FILESYSTEM),
# EXIT_RUNTIME (flush + exit), no ASYNCIFY/USE_WEB_INPUT. `-z` compresses the
# program so emcc doesn't OOM on the combinator array; `--embed-packages base`
# bakes the Prelude in so the worker needs no package filesystem.
#
# Builds the toolchain FRESH in the clean submodule (a stale self-hosted bin/mhs
# OOMs on everything; a fresh `make` from consistent source is correct). A big eval
# heap (MHS_HEAP) covers compiling the compiler's own source; run with full system
# memory.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MHS="$ROOT/vendor/microhs"
OUT="$ROOT/public/vendor/mhs"
MHS_HEAP="${MHS_HEAP:-4G}" # eval-runtime heap for the self-host compile

command -v emcc >/dev/null || { echo "emcc not found — run inside: nix-shell nix/shell.nix"; exit 1; }
command -v ghc  >/dev/null || { echo "ghc not found — run inside: nix-shell nix/shell.nix"; exit 1; }
command -v cc   >/dev/null || { echo "cc not found — run inside: nix-shell nix/shell.nix"; exit 1; }
[ -d "$MHS/src" ] || { echo "submodule empty — run: git submodule update --init vendor/microhs"; exit 1; }

mkdir -p "$OUT"
cd "$MHS"

echo "==> 1. build the MicroHs toolchain fresh (bin/mhs, cpphs, mcabal)"
make

echo "==> 2. build + install the base package (so --embed-packages can find it)"
make generated/base.pkg
VERSION="$(./bin/mhs --numeric-version)"
PKGDIR="$HOME/.mcabal-user/mhs-$VERSION"
mkdir -p "$PKGDIR"
./bin/mhs +RTS -H"$MHS_HEAP" -RTS -Q generated/base.pkg "$PKGDIR"

echo "==> 3. ensure the headless batch emscripten target is in mhs.conf"
if ! grep -q "emscripten_batch" mhs.conf 2>/dev/null; then
  cat >> mhs.conf <<'CONF'

-- Headless one-shot batch compile in a browser Worker (Combinate live compile):
-- MEMFS + EXIT_RUNTIME (flush stdout on exit), no ASYNCIFY / USE_WEB_INPUT.
[emscripten_batch]
cc = "emcc"
ccflags = "-O3 -sEXPORTED_RUNTIME_METHODS=['FS','callMain'] -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH -sTOTAL_STACK=5MB -sSINGLE_FILE -sEXIT_RUNTIME -Wno-address-of-packed-member"
cclibs = "-lm"
conf = "unix"
CONF
  echo "    added [emscripten_batch]"
fi

echo "==> 4. compile MicroHs.Main → mhs-batch.js (base embedded; -z dodges the emcc OOM)"
./bin/mhs +RTS -H"$MHS_HEAP" -RTS -temscripten_batch -z -i -imhs -isrc MicroHs.Main -o "$OUT/mhs-batch.js" --embed-packages base

echo "==> done. $OUT/mhs-batch.js ($(wc -c < "$OUT/mhs-batch.js") bytes)."
echo "    git-ignored (public/vendor/). Point src/view/mhs/worker.ts at it, or host on a CDN."

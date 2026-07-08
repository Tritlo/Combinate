#!/usr/bin/env bash
# PGO build for minimal-forms (~20% over plain release; rustc's codegen leaves branch
# layout on the table for the reducer's hot loops). Profiles on the 17ι validation
# harness + a 22ι DP run for depth-representative branches.
set -euo pipefail
cd "$(dirname "$0")"
PGO=$(mktemp -d)
RUSTFLAGS="-Cprofile-generate=$PGO" cargo build --release
./target/release/minimal-forms --dp --dp-arity 8 --max-iotas 17 --out "$PGO/w17.json" >/dev/null
./target/release/minimal-forms --dp --dp-arity 8 --dp-slim --max-iotas 22 --out "$PGO/w22.json" >/dev/null
"$(rustc --print sysroot)"/lib/rustlib/x86_64-unknown-linux-gnu/bin/llvm-profdata merge -o "$PGO/merged.profdata" "$PGO"/*.profraw
RUSTFLAGS="-Cprofile-use=$PGO/merged.profdata" cargo build --release
rm -rf "$PGO"
echo "PGO build done → target/release/minimal-forms"

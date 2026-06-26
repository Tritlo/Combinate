#!/usr/bin/env bash
# Vendor the runtime WASM/blob deps into public/vendor/ (git-ignored), so the app
# serves them from its own origin instead of a third-party CDN. Host these on a
# real CDN later and point the loaders there; nothing here is committed.
#
#   ./scripts/vendor-wasm.sh
#
# Copies:
#   - DuckDB-WASM engine (eh + mvp .wasm and browser workers) from node_modules
#   - the stock MicroHs in-browser compiler blob from $MHS/web-mhs (if present),
#     for the live-compile path (the gallery uses pre-compiled dumps and needs none)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MHS="${MHS:-$ROOT/../MicroHs}"
DUCK="$ROOT/node_modules/@duckdb/duckdb-wasm/dist"
OUT="$ROOT/public/vendor"

mkdir -p "$OUT/duckdb" "$OUT/mhs"

echo "==> DuckDB-WASM engine -> public/vendor/duckdb/"
for f in duckdb-mvp.wasm duckdb-eh.wasm duckdb-browser-mvp.worker.js duckdb-browser-eh.worker.js; do
  cp "$DUCK/$f" "$OUT/duckdb/" && echo "    $f ($(wc -c < "$OUT/duckdb/$f") bytes)"
done

echo "==> MicroHs in-browser compiler blob -> public/vendor/mhs/ (live-compile path)"
if [ -f "$MHS/web-mhs/mhs-embed.js" ]; then
  cp "$MHS/web-mhs/mhs-embed.js" "$OUT/mhs/" && echo "    mhs-embed.js ($(wc -c < "$OUT/mhs/mhs-embed.js") bytes)"
else
  echo "    (no $MHS/web-mhs/mhs-embed.js — live compile disabled; the gallery still works)"
fi

echo "==> done. public/vendor/ is git-ignored; regenerate gallery dumps with scripts/gen-mhs-examples.ts."

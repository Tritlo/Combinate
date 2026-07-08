#!/usr/bin/env bash
set -euo pipefail

# Build the MicroHs rust web dist into public/vendor/mhs/ (git-ignored).
# Thin wrapper over upstream's own dist script (rust-only, no emcc — the
# C-comparison bench is a separate opt-in upstream). Usage:
#   scripts/build-mhs-rust.sh [SRC_DIR]   # default: the vendor/microhs submodule
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="${1:-$here/vendor/microhs}"
out="$here/public/vendor/mhs"

"$src/rust/microhs-runtime/tools/wasm/browser/build-web-dist.sh" "$out"

# Sanity: a real wasm and a manifest whose entries exist.
head -c4 "$out/microhs_runtime.wasm" | od -An -tx1 | grep -q "00 61 73 6d" || { echo "bad wasm magic" >&2; exit 1; }
node -e "
const fs = require('fs'), m = JSON.parse(fs.readFileSync('$out/manifest.json', 'utf8'));
for (const p of Object.keys(m.includeFiles)) if (!fs.existsSync('$out/' + p)) { console.error('missing ' + p); process.exit(1); }
for (const p of m.packages || []) if (!fs.existsSync('$out/' + p.dist)) { console.error('missing package ' + p.dist); process.exit(1); }
console.log('dist ok:', Object.keys(m.includeFiles).length, 'lib files,', (m.packages||[]).length, 'packages');
"

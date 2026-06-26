# CLAUDE.md

Guidance for Claude Code working in this repo. (User-level conventions in
`~/.claude/CLAUDE.md` still apply; this file adds project specifics.)

## What this is

**Combinate** — a TypeScript + Pixi.js interactive ι (iota) / SKI combinator-calculus
sandbox. A static SPA (vite) deployed to GitHub Pages. You drag ι, snap trees, and
they reduce on their own; discover named combinators; compile Haskell to combinator
trees; golf; etc.

## Commands

- `npm run dev` — vite dev server (http://localhost:5173).
- `npm run build` — `tsc --noEmit && vite build` → `dist/`.
- `npm run typecheck` — `tsc --noEmit`. Run before finishing.
- `npm run build:wasm` — gen rules from the catalog, then `wasm-pack build` the
  `crates/refold` crate → `crates/refold/pkg/` (built from source, never committed).
- No unit-test runner. Verify with throwaway `playwright-core` scripts against the
  dev server (use the `__combinate` dev seam in `app.ts`). `e2e.local.mjs` is the
  live-compile seam harness (git-ignored). Don't commit tests unless asked.

## Architecture

- **Functional core** `src/core/` — pure, no DOM/Pixi/wasm (ADR 0001):
  `term.ts` (the `Node` model: ι, app, comb, free), `reduce.ts` (tree reducer),
  `graph.ts` (call-by-need graph reducer with sharing, drawn as a DAG),
  `catalog.ts` (combinator laws, the hotbar pages incl. Char), `types.ts`/`infer.ts`
  (value read-back + HM types), `refold.ts` (re-sugaring), `mhs.ts` (post-process a
  stock MicroHs `-ddump-combinator` dump into an ι tree), `layout.ts`, `permalink.ts`,
  `authoring.ts`, `probe.ts`.
- **View** `src/view/` — Pixi + DOM: `tree.ts`, `hotbar.ts`, `zoo.ts`, `toast.ts`,
  `sound.ts`, `challenge.ts`, `theme.ts` (light/dark, `currentMode`/`onThemeChange`),
  and `mhs/` (`panel.ts` the Haskell panel, `compiler.ts`, `worker.ts`, `highlight.ts`,
  `examples.ts`).
- **`src/app.ts`** — the orchestrator that wires the core to the Pixi scene (left
  rail, hotbar, drag/snap, auto-reduce, camera, the `__combinate` dev seam). Large file.
- **`src/store/`** — a `Store` port; `LocalStore` (default) + `DuckdbStore`
  (`?store=duckdb`, lazy, DuckDB-WASM from the jsDelivr CDN).
- **`crates/refold/`** — Rust → wasm re-folder (egg), built in CI from source.
- **`src/splash.ts`** boot splash; **`src/vendorUrl.ts`** base-aware URLs for vendored
  public assets.

## Conventions

- Keep it simple, minimal deps, functional-core / imperative-shell. Match the
  surrounding style. Add haddock-style doc comments to new functions/types.
- Significant decisions → an ADR in `docs/adr/NNNN-slug.md` (terse). The PR/commit
  should carry the "why".
- Releases: one integer major per release (`vN.0`). Bump `package.json`, add a
  `CHANGELOG.md` section, `--no-ff` merge the feature branch into `main`, tag `vN.0`.
- Branch before starting work. **Never push/deploy unless explicitly asked.**
- Run nix/Haskell builds inside `nix-shell` (see below).

## Deploy & vendored assets — IMPORTANT

Pushing `main` triggers `.github/workflows/deploy.yml` → build + deploy to GitHub
Pages (private repo, custom domain **github.mpg.is/Combinate/**, a `/Combinate/`
subpath).

- **Base-aware URLs.** vite `base: "./"`. Runtime-fetched public assets (the vendored
  wasm/blobs/font) must go through `src/vendorUrl.ts` — a bare `/vendor/...` resolves
  against the origin root and **404s on the `/Combinate/` subpath**. The live-compile
  worker has no `document`, so it receives the blob's absolute URL via `postMessage`.
- **`public/vendor/` is git-ignored.** The runtime assets we host are on the
  **`vendor-assets` GitHub Release**, fetched by CI (`gh release download`, authed by
  the workflow's `GITHUB_TOKEN` / `contents: read`):
  - `mhs-vendor.tar.gz` = MicroHs blob (`mhs-batch.js`) + prewarmed cache
    (`base.mhscache`) + gallery dumps (`examples/*.comb`).
  - `IoskeleyMono-Regular.woff2` = the Haskell editor webfont.
- **DuckDB is NOT vendored** (~76 MB, third-party) — loaded from the jsDelivr CDN via
  `getJsDelivrBundles()`.

### Rebuilding the MicroHs blob and uploading to the Release

When the MicroHs fork (`vendor/microhs` submodule) or the custom Prelude changes,
rebuild the runtime and re-host it (heavy; needs nix + a browser):

```sh
# 1. Build the batch blob (gmhs + emscripten; path-2, no bin/mhs — it OOMs here).
nix-shell nix/shell.nix --run ./nix/build-wasm.sh        # → public/vendor/mhs/mhs-batch.js
# 2. Regenerate the prewarmed Prelude cache (self-serves + drives the blob headless).
node scripts/gen-mhs-cache.mjs                           # → public/vendor/mhs/base.mhscache
# 3. Regenerate the gallery dumps (needs the GHC-built gmhs).
MHS=vendor/microhs npx tsx scripts/gen-mhs-examples.ts   # → public/vendor/mhs/examples/*.comb
# 4. Bundle + upload to the Release. gh is snap-confined here (can't read /tmp) —
#    keep the tarball under $HOME (the repo dir is fine).
tar czf mhs-vendor.tar.gz -C public/vendor/mhs mhs-batch.js base.mhscache examples
gh release upload vendor-assets mhs-vendor.tar.gz --clobber
# Font (rarely changes):
gh release upload vendor-assets public/vendor/fonts/IoskeleyMono-Regular.woff2 --clobber
```

The next push to `main` redeploys with the new assets — no app code change needed.

## Lessons learned (this environment)

- **`gh` is a snap** (`~/snap/gh/...`) and **cannot read `/tmp`** (incl. the Claude
  scratchpad). Staging a file there for `gh release upload/create` fails with a
  misleading `no matches found for <path>`. Stage under `$HOME` first.
- **`bin/mhs` (the self-hosted MicroHs) OOMs here** on any program. Use the GHC-built
  **`gmhs`**; it can't serialize a `.pkg` (`-z`), so the WASM build embeds base as
  source (`emcc --embed-file`) and the worker compiles with `-i. -i/lib`.
- **Live-compile timing is environmental on WSL2** — it has ballooned from ~30 s to
  >180 s with no CPU/memory pressure, reproducing on the committed baseline and the
  standalone harness alike. It is **not** a code regression; re-verify on a fresh
  session rather than chasing it.

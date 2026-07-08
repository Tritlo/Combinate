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
- `npm run build:wasm` — gen rules from the catalog, then `wasm-pack build` both Rust
  crates (`crates/refold` re-folder + `crates/reduce` Turbo reducer) → `crates/*/pkg/`
  (built from source, never committed).
- `npm run check:reduce-wasm` — build the reduce crate (nodejs) + cross-check it against
  the TS reducer (the parity oracle); the closest thing to a test suite.
- No unit-test runner. Verify with throwaway `playwright-core` scripts against the
  dev server (use the `__combinate` dev seam in `app.ts`). `e2e.local.mjs` is the
  live-compile seam harness (git-ignored). Don't commit tests unless asked.

## Architecture

- **Functional core** `src/core/` — pure, no DOM/Pixi/wasm (ADR 0001), ~21 modules.
  Terms & reduction: `term.ts` (the `Node` model: ι, app, comb, free), `reduce.ts`
  (tree reducer), `graph.ts` (call-by-need graph reducer with sharing, drawn as a
  DAG), `native.ts`/`kernels.ts`/`church.ts` (native-value peephole + the kernel
  registry, ADR 10/11). Reading: `catalog.ts` (combinator laws, the hotbar pages
  incl. Char), `value.ts` (Scott value matchers), `types.ts`/`infer.ts` (value
  read-back + HM types), `refold.ts` (re-sugaring), `probe.ts`. Layout:
  `layout.ts`/`layout3d.ts` (2D/3D H-tree + radial). Sharing/authoring:
  `permalink.ts`, `authoring.ts`, `challenges.ts` (golf). The Quest:
  `quest.ts` + `skiq/` (the SKI-Quest puzzle data + engine), `goals.ts`. Haskell
  compile: `mhs.ts` (post-process a stock MicroHs `-ddump-combinator` dump into an
  ι tree), `wasmCodec.ts` (the `Node` ⇄ Turbo wire codec).
- **View** `src/view/` — Pixi + DOM chrome, grouped: canvas/tree (`tree.ts`,
  `hotbar.ts`, `edgeBuffer.ts`), 3D (`sphere3d.ts`, `sphereController.ts`,
  `layoutControls.ts`), input (`keymap.ts`, `gamepad.ts`, `gameInput.ts`,
  `inputDevice.ts`, `camera.ts`, `dragController.ts`), chrome/modals (`menubar.ts`,
  `modal.ts`, `optimize.ts`, `zoo.ts`, `toast.ts`, `discovery.ts`), the Quest
  (`quest.ts`, `questTracker.ts`), transport/reduction (`transportBar.ts`,
  `reduction.ts`), plus `sound.ts`, `challenge.ts`, `theme.ts` (light/dark,
  `currentMode`/`onThemeChange`), and `mhs/` (`panel.ts` the Haskell panel,
  `compiler.ts`, `worker.ts`, `highlight.ts`, `examples.ts`).
- **`src/app.ts`** — the orchestrator that wires the core to the Pixi scene (menu
  bar, hotbar, drag/snap, auto-reduce, camera, the `__combinate` dev seam). Large
  file (the left rail folded into the menu bar in v10).
- **`src/store/`** — a `Store` port; `LocalStore` (default) + `DuckdbStore`
  (`?store=duckdb`, lazy, DuckDB-WASM from the jsDelivr CDN).
- **`crates/refold/`** — Rust → wasm re-folder (egg), built in CI from source.
- **`crates/reduce/`** — Rust → wasm combinator reducer, the "Turbo" engine (a call-by-need
  graph reducer with native kernels + catalog rules, ADR 16/19); built in CI from source.
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
- The Rust → wasm builds (refold/reduce crates, the MicroHs dist) build from source
  with `cargo`/`wasm-pack` — no nix (see below).

## Deploy & vendored assets — IMPORTANT

Pushing `main` triggers `.github/workflows/deploy.yml` → build + deploy to GitHub
Pages (private repo, custom domain **combinate.app**, served at the domain root).

- **Base-aware URLs.** vite `base: "./"` (relative). Runtime-fetched public assets (the
  vendored wasm/dist/font) must go through `src/vendorUrl.ts`, not a bare `/vendor/...` —
  keeping them base-relative so the app stays portable (it deployed on a `/Combinate/`
  subpath historically). The live-compile worker has no `document`, so it receives the
  dist's absolute asset URLs via `postMessage`.
- **`public/vendor/` is git-ignored, built from source in CI.** `deploy.yml` checks out
  the `vendor/microhs` submodule and builds the MicroHs Rust dist + gallery closures (see
  below) — nothing prebuilt is committed or fetched for it. The dist + closures are
  cached by inputs (`mhs-dist-v1-…` key: submodule pin, build/gen scripts, examples,
  `src/core`) since running the compiler wasm costs ~5 min; bump the key's `v1` to force
  a rebuild, and `scripts/check-mhs-dist.ts` gates every deploy (built or restored). The one hosted asset is the
  editor webfont on the **`vendor-assets` GitHub Release** (`IoskeleyMono-Regular.woff2`),
  fetched by CI (`gh release download`, authed by the workflow's `GITHUB_TOKEN` /
  `contents: read`).
- **DuckDB is NOT vendored** (~76 MB, third-party) — loaded from the jsDelivr CDN via
  `getJsDelivrBundles()`.

### Rebuilding the MicroHs dist (local)

CI builds it from source on every deploy, so you rarely need this. When the MicroHs
fork (`vendor/microhs` submodule) or the custom Prelude changes, rebuild locally
(needs the Rust toolchain + the `wasm32-unknown-unknown` target; no nix, no emcc):

```sh
git submodule update --init vendor/microhs   # pin lives in .gitmodules (branch rust-js-ffi)
scripts/build-mhs-rust.sh                     # cargo → public/vendor/mhs/ (wasm, compiler.mjs, mhs.comb, base.pkg, lib)
npx tsx scripts/gen-mhs-examples.ts           # → public/vendor/mhs/examples/*.json (the gallery closures)
```

That's the whole live + gallery runtime — no Release upload needed. The webfont is the
only Release asset (`gh release upload vendor-assets public/vendor/fonts/IoskeleyMono-Regular.woff2 --clobber`;
gh is snap-confined here — stage under `$HOME`, not `/tmp`).

## Lessons learned (this environment)

- **`gh` is a snap** (`~/snap/gh/...`) and **cannot read `/tmp`** (incl. the Claude
  scratchpad). Staging a file there for `gh release upload/create` fails with a
  misleading `no matches found for <path>`. Stage under `$HOME` first.
- **Live compile is ~13 s** with `base.pkg` (the pre-typechecked base loads as a package
  instead of recompiling the Prelude each time). Browser compiles can still run slower on
  WSL2 under load, but it's no longer the old ~1–2 min recompile — the node path
  (`gen-mhs-examples`, the parity oracle) is the fast way to re-verify.

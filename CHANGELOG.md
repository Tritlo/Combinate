# Changelog

All notable changes to **Combinate** — an interactive ι (iota) / SKI combinator-calculus
sandbox. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses a single integer major per release (`vN.0`).

## [8.0.0] — 2026-06-26

### Added

- **Live in-browser Haskell compile** — the Haskell panel can now compile
  free-typed source, not just the curated gallery. A stock MicroHs **batch blob**
  (`mhs-batch.js`, built from a pinned `nix-shell` via `nix/build-wasm.sh`) runs the
  whole compiler in a Web Worker and emits a `-ddump-combinator` dump, which the
  existing pure `core/mhs.ts` post-processes into an ι tree (no MicroHs fork). A
  prewarmed Prelude module cache (`base.mhscache`, read with `-CR`) halves the
  compile time (~65s cold → ~30s). The MicroHs fork is vendored as a git submodule.
- **Boot splash** — a startup screen (in `index.html`, painting before any module
  loads) with the Combinate wordmark, the **Y combinator's SKI tree** rendered as an
  inline SVG (the canvas's radial layout + function/argument edge colours), and a
  progress bar driven by four real startup milestones (renderer · catalog · lenses ·
  compiler). The re-folding lens wasm and the live-compile blob + cache are preloaded
  here, so they're instant on first use. Themed via `prefers-color-scheme`.

### Changed

- **DuckDB loads from the jsDelivr CDN** (`getJsDelivrBundles()`) instead of being
  vendored from our own origin — a third-party ~76 MB engine isn't ours to host.
- **Base-aware vendor URLs** (`src/vendorUrl.ts`): runtime-fetched public assets now
  resolve `BASE_URL + path` against `document.baseURI`, so the vendored wasm/blobs
  serve correctly on GitHub Pages' `/Combinate/` subpath (a bare `/vendor/...` would
  404 there). The deploy workflow fetches the MicroHs runtime (blob + cache + gallery
  dumps) from the **`vendor-assets` GitHub Release** at build time — too heavy to
  build in CI, never committed (ADR 0007).

## [7.0.0] — 2026-06-26

### Added

- **Graph reduction with sharing** — an opt-in **`graph`** toggle backed by a
  self-contained call-by-need graph reducer (`src/core/graph.ts`). A duplicated
  subterm is one cell, forced at most once, its result shared in place — so Scott
  `×` (repeated addition) stops recomputing recursive calls. `fac` becomes linear
  (`fac 5/6 = 120/720`), where the cloning tree reducer couldn't reach `fac 4`.
- **Sharing made visible** — in graph mode the live reduction renders as a **DAG**:
  a shared subterm is one node with several incoming edges, and reducing it once
  updates it everywhere. The reduction is lazy and produces the same normal forms
  as the tree reducer (`K a Ω → a`).

### Notes

- The toggle's OFF path is byte-identical: the pure tree reducer and the view's
  tree path are untouched; DAG-awareness is added by visited-guards that are
  provable no-ops on a single-parent tree. Graph mode is permalink-encoded (mode
  key `graph`) and on the dev seam. Pedagogy is clearest on small terms; big
  programs (gallery `fac`) complete via a higher step cap (fast-forward to skip
  ahead).

## [6.0.0] — 2026-06-26

Shareability, authoring, local storage, and the in-browser Haskell compiler — the
v6–v8 roadmap (ADRs 0005–0008), landed together.

### Added

- **Permalinks & sharing** (ADR 0005): a versioned codec round-trips a tree + active
  modes through the URL; a solution / leaderboard entry *is* a permalink.
- **Golf challenges & leaderboards** (ADR 0005): a challenge layer (target predicate,
  best-metric) with **verify-by-replay** leaderboards — the store is dumb and
  append-only; clients re-run and re-verify each entry.
- **Sonification** (ADR 0005): a WebAudio layer plays a tone per reduction (one per
  combinator family, from the rule that fires), gated by a toggle.
- **Authoring** (ADR 0006): **Define** a settled subtree into a named hotbar block,
  and **Abstract** one hole out of a tree as a free variable (bracket abstraction).
- **DuckDB-WASM storage** (ADR 0008): a lazy `Store` adapter (discovered set, user
  definitions, bests, leaderboard) behind a port; `LocalStore` is the default,
  `?store=duckdb` opts into DuckDB.
- **In-browser Haskell → ι** (ADR 0007), the *wow*: a "haskell" panel compiles real
  Haskell to combinators and drops the tree on the canvas to reduce. Implemented by
  **post-processing a stock MicroHs `-ddump-combinator` dump — no fork**: literals →
  Scott numerals/strings, `primInt*`/`primChar*` → catalog Scott combinators (a Char
  is its ASCII numeral), basis → SKI; rejects IO/FFI/Float by reachability. Ships a
  curated, wasm-free **gallery** (arithmetic, `map`, `foldr`, `filter`, string
  `reverse`, `factorial`), pre-compiled by stock `gmhs` at build time.
- **Scott comparison/ordering combinators**: `(==) (/=) (<) (<=) (>) (>=) compare`
  and the `Ordering` constructors `LT/EQ/GT`, each with an SKI definition and an
  optimize-mode rule, on the Arithmetic page.
- **Char support**: a Char page in the Zoo/hotbar and a Char/String **reading lens**
  (a Scott numeral renders as its glyph, a list of them as a string).
- `scripts/vendor-wasm.sh` and `scripts/gen-mhs-examples.ts` to regenerate vendored
  assets and gallery dumps.

### Changed

- **WASM deps vendored locally**: the DuckDB engine (and the MicroHs blob) are served
  from `public/vendor/` (git-ignored) instead of jsDelivr — our own origin, CDN-
  swappable later.

### Known limitations

- **No graph sharing in the reducer**: it clones rather than shares, so Scott `×`
  (repeated addition) makes multiplication-*recursion* exponential — `fac 3` runs,
  `fac 4+` blows up. The gallery is curated to linear/structural programs; graph
  reduction is the planned follow-up.
- **Live free-typing is experimental**: the vendored MicroHs blob is the interactive
  playground build, whose base package isn't wired for a headless batch compile, so
  free-typed source degrades to an honest message. The gallery compiles offline.

## [5.0.0] — 2026-06-26

### Added

- **Optimize mode** (opt-in, off by default): a saturated named combinator reduces by
  its catalog *rule* (the law / Scott recursion) in one step, instead of unfolding its
  SKI definition and grinding ι/S/K/I — 8–10× fewer steps on arithmetic. Raw SKI play
  is preserved exactly when the toggle is off.

## [4.0.0] — 2026-06-26

### Added

- **Pause / Play / Fast-Forward** transport over auto-reduction (FF = 3×).

### Changed

- **GPU-instanced renderer**: tree nodes draw as one Pixi `ParticleContainer` with
  glyph level-of-detail; edges are viewport-culled while animating — smooth on huge
  (16k-node) trees.

## [3.0.0] — 2026-06-26

### Added

- **Type lens** (ADR 0003): a rail toggle badges a term's principal **Hindley–Milner**
  simple type, or marks it untypable (self-application / the fixpoint `Y`) — the
  typed/untyped boundary as the lesson.
- **Type-guided value reader**: sibling propagation (one element fixes an ambiguous
  list) and combinator routing; the read-as mode follows the hotbar page
  (Arithmetic → Int, Booleans → Bool, Lists → List).

### Changed

- **Switched data encoding from Church to MicroHs Scott** (ADR 0004): Nat/list/bool/
  pair as Scott data; the structural matchers and read-back follow.

## [2.0.0] — 2026-06-25

### Added

- **Re-folding lens** (ADRs 0001–0002): a Phase-1 value reader shows compact data
  values (numbers, lists, booleans, pairs) in the read-out, and a Phase-2
  **egg-via-WASM** re-folder names combinators by behaviour — built from source in
  CI, never committed.
- **Expand view** (every combinator rendered as its full ι-tree), the root ring, a
  left button rail with the Pokédex logo, a responsive (master-detail) Zoo,
  pinch-to-zoom, and device-pixel-ratio rendering.

## [1.0.0] — 2026-06-25

Initial release.

### Added

- **The ι sandbox**: a canvas, a hotbar, drag-to-snap construction, and normal-order
  reduction with tweened steps and fn/arg edge colouring; radial and top-down layouts.
- **Behavioural discovery**: probe a built tree against the combinator catalog →
  toast + hotbar unlock, collapsing the recognised tree into a named node.
- **The Zoo**: a Pokédex of every combinator — Smullyan bird names, each combinator's
  ι-tree picture, an iota-count stat, lore-rich blurbs, and "next to discover" hints.
- **Combinator catalog**: SKI plus the bird zoo (B, C, W, M, V, Y, …) and Church
  arithmetic / Boolean / list combinators, over shared Programs / Booleans /
  Arithmetic / Lists pages.
- Light/dark theme, arrow-key Zoo navigation, and a GitHub Pages deploy.

# 7. In-browser MicroHs Haskell→combinator compiler (v8, the wow feature)

**Status:** accepted — **implemented via post-processing a *stock* dump (no fork)**, superseding the original "vendor a forked compile-only slice" decision. Gallery path shipped and verified; live free-typing works via a batch blob (route 2) but is slow. See *Revised decision* and *Live compile* below; the original decision/context is kept beneath them as history.

## Revised decision (2026-06-26): post-process a stock dump, don't fork

The original plan forked MicroHs (a `compileToComb` entry point + an invasive
char/`Integer` → Scott-`Nat` desugar in flagless `dsExpr`) and cross-compiled the
fork to WASM — which we deferred when `make mhs.js` OOM'd self-hosting. The insight
that unblocked it: **we don't need to fork.** Inspecting real `gmhs` dumps showed

- integer **and char** literals are already a clean `#n` token (`'B'` → `#66`) — so
  the invasive char desugar we feared **is already done by stock MicroHs**; and
- arithmetic/comparison bottom out in a small, enumerable set of `Primitives.prim*`
  leaves inside the `Num`/`Ord` dictionaries.

So a **pure-TS post-processor** (`src/core/mhs.ts`) rewrites a stock
`-ddump-combinator` dump into pure ι: `#n` → Scott numeral, `"…"` → Scott list of
char codes, `primIntAdd/EQ/LT/…` → the catalog Scott combinator (Char ops map to the
Int ones — a Char *is* its ASCII numeral), basis `S K I B C …` → SKI (MicroHs's list
cons `(:)` is the `O` combinator = catalog `cons`). It **rejects by reachability**:
a primitive with no ι form (IO/FFI/Float/bitwise/negation) is a sentinel that's only
fatal if it *survives a bounded reduction* — dead dictionary fields (every `Num`
dict's `primIntNeg`) drop out. New catalog combinators `(==) (/=) (<) (<=) (>) (>=)
compare` (+ `Ordering`) cover the comparison primitives; a Char page + reading lens
render Scott numerals as glyphs/strings.

**What shipped (this is the live decision):**

- **No MicroHs fork.** Stock `gmhs` (build-time) / the stock web blob (live).
- **Gallery (reliable, wasm-free):** six curated primitive-free programs are
  pre-compiled by `gmhs` at build time (`scripts/gen-mhs-examples.ts`), pruned to
  the reachable defs, vendored as small `.comb` assets, and post-processed +
  reduced in-browser. Verified end-to-end: `2*2`→4, `map (+1) [1,2,3]`→[2,3,4],
  `foldr (+) 0`→15, `filter (<3)`→[1,2], `reverse "abc"`→"cba", `fac 3`→6.
- **Live free-typing:** compiles in-browser via a dedicated **batch** MicroHs blob
  (`nix/build-wasm.sh`, "route 2" — see *Live compile* below). Functional and
  verified, but **slow** (~1–2 min: it recompiles the Prelude from embedded source
  each time). The gallery is the instant path.
- **Vendoring (ADR 0008-adjacent):** `scripts/vendor-wasm.sh` copies the DuckDB
  engine + the MicroHs blob into `public/vendor/` (git-ignored); served from our own
  origin, CDN-swappable later.

**Graph sharing — resolved (v7.0).** The sandbox reducer cloned rather than shared,
making Scott `×`-recursion exponential (`fac 4+` blew up). An opt-in `graph` toggle
now adds **call-by-need graph reduction** (`src/core/graph.ts`): `fac` is linear,
and the live reduction renders as a **DAG** (sharing made visible). OFF parity is
byte-identical. (See the thesis cross-check in *Live compile* below.)

This **supersedes ADR 0002's** "build the WASM in CI" rule only for the *blob* (a
vendored prebuilt, hosted later); the post-processor itself is ordinary CI-built TS.

## Live compile (route 2) — batch blob + a thesis cross-check (2026-06-26)

The live path is a real, reproducible build, gated only on speed:

- **Build (`nix/build-wasm.sh` + `nix/shell.nix` + the `vendor/microhs` submodule,
  pinned to nixpkgs 25.11 → ghc 9.10.3 + emcc 4.0.12).** The stock playground blob
  *can't* be driven headless: it's `[emscripten_web]` (ASYNCIFY + USE_WEB_INPUT,
  **no EXIT_RUNTIME**), so a headless `-ddump-combinator` produces the dump but
  never flushes stdout. The fix is a `[emscripten_batch]` target (MEMFS +
  EXIT_RUNTIME, no ASYNCIFY/USE_WEB_INPUT). The blob is built **entirely with the
  GHC-built `gmhs`** because, in our Linux/nix env, the self-hosted `bin/mhs` OOMs
  on *any* program (its eval-heap `mmalloc` fails) and `gmhs` lacks the eval-only
  `-z` (compress) and `.pkg` serialization. So: no `-z` (emcc handles the
  uncompressed array — the old `make mhs.js` OOM was always `bin/mhs`), and `base`
  shipped as **source embedded in the WASM FS** (`emcc --embed-file lib@/lib`)
  rather than as a serialized package.
- **Driving (`src/view/mhs/worker.ts`).** In a browser Worker: `Module.arguments`
  + auto-run (`callMain` re-enters and blows the JS stack), `preRun` writes `Ex.hs`,
  compile with `-i. -i/lib`, report from `postRun`/`onExit`. Verified to produce the
  exact `-ddump-combinator` form the post-processor consumes.
- **The cost.** Because there's no precompiled `base.pkg` (gmhs can't serialize),
  every compile recompiles the Prelude from source in the wasm evaluator (~1–2 min).
  **Fast live compile needs a precompiled base**, which needs an upstream MicroHs
  fix (a working self-hosted `bin/mhs`, or `.pkg` serialization in the GHC build).

**Thesis cross-check.** Apoorva Anand, *Towards a WebAssembly Backend for MicroHs*
(Utrecht U. MSc, 2025), attempts a native **WasmGC** backend and **could not run any
Haskell program** — porting MicroHs's runtime (50+ primitive tags; even Church
numerals pull in the Prelude) proved too much — confirming the **C/Emscripten path
we use is the working one**. It also independently validates our v7.0 reducer: its
SK machine is exactly `src/core/graph.ts` — `appNode(left,right)` ≡ our app cell,
the "left ancestor stack (LAS)" ≡ our spine unwind, and a "table" whose definitions
"might or might not have already been reduced" ≡ our `ind`-based sharing. And it
confirms the primitive wall (`main = print 42` → **466** definitions) — which
Combinate sidesteps by *visualising* the ι-encodable fragment rather than *running*
programs.

---

**Original status:** accepted (finalised in a grill-with-docs pass; remaining open items are implementation defaults). *Kept below as history — the fork/slice approach it describes was superseded by the post-process approach above.*

## Context

The flagship "wow": type a real Haskell program, watch it **compile to ι and
reduce** in the sandbox. The earlier MicroHs deep-dive (ADR-adjacent notes)
*deferred* this — the compile-only WASM slice is ~1.5–2.5 MB and needs an
emscripten/Haskell toolchain, ~8× the egg adapter and a second CI toolchain. The
maintainer now wants it as the headline feature, accepting that cost. The boundary:
the **closed, encodable fragment** — Scott/Peano data, numbers (Scott `Nat`), and
**`Char`/`String` (ASCII codes as Scott `Nat`)** — has a combinatory form and
compiles to pure ι; the residual wall is `IO` / FFI / `Float`, which has no ι form.

## Decision

Vendor a **compile-only MicroHs WASM slice** as a lazy, off-main-bundle driven
adapter (mirrors the egg lens, ADR 0002), behind a pure port in `src/core/`:

- Expose `compileToComb(source) → combinator dump` (+ `typeOf`) — MicroHs already
  factors these stages (`Interactive.compile`, the pure `compileToCombinators`);
  the fork adds a thin entry point.
- Convert the combinator dump → Barker bit-code (the `iota/Iota.hs` SKI-expansion
  step, ported to TS or compiled into the slice), then load via `decode()`.
- **Make the wow land on the first program (c + d + honest reject):**
  - **(c) Lead with curated examples.** The Haskell panel opens on working,
    primitive-free programs (a quicksort over Peano `Nat`, etc.) so the first
    experience is "watch *this* become ι and run." Free-typing is a labelled power
    feature, not the cold-start.
  - **(d) Ship a primitive-free Prelude.** Numeric literals map to **Scott `Nat`**
    (via `fromInteger`); **`Char` literals map to the Scott `Nat` of their ASCII
    code** (a char-literal desugaring tweak in the MicroHs fork, since `Char` is not
    class-overloaded like numeric literals) — so `String = [Nat]` and **text
    manipulation becomes pure ι**; and `+`/`*`/`-`/comparisons/list ops are the Scott
    versions. A large fragment of *natural* arithmetic / recursion / list / string
    Haskell (the `fac`/`fib`/`sort`/string programs people actually type) compiles to
    **pure ι and runs**. Char/string terms make *enormous* ι-trees (a char ≈ 65
    nested `Succ`), but the **optimize mode** (named-combinator reduction, v5) recovers
    usability exactly as it did for `2*2`, and a **Char display lens** can render a
    Scott `Nat` back to its glyph.
  - **Reject only the genuinely-primitive residue** — `IO` / FFI / `Float` (and other
    machine/world primitives with no ι form) — with a clear teaching message. Never
    silently box a primitive (that would break "it's all ι").
- Lazy-load in a Web Worker; the compiler bytes are fetched only when the Haskell
  panel is opened.

## Why

The headline "real Haskell becomes birds" feature; MicroHs is mature prior art
that already emits exactly the bit-code `decode()` ingests; reuses the bit-code
bridge end-to-end. Worth the weight *because* it is the wow, not maintenance
reduction.

## Consequences

- ~1.5–2.5 MB lazy artifact (vs 310 KB egg) — must be gated/lazy/off by default.
- A second WASM toolchain (emscripten/clang) — kept **out of CI** by vendoring a
  pinned prebuilt blob (hosted release asset, not in git history), rebuilt manually
  on the infrequent MicroHs bumps. Accept the version-lock to `base.pkg` and
  re-verify the iota mapping on each bump. (Explicit exception to ADR 0002.)
- The primitive wall is mitigated by the Scott-`Nat`/`Char` Prelude + curated
  examples, so natural arithmetic/recursion/text *works*; the residual wall is
  `IO`/FFI/`Float`, which the UI rejects with a teaching message. The custom Prelude
  + literal remapping (incl. char-literal desugaring) is real extra scope — it is
  what turns the wow on.

## Open questions (for the grill)

- ~~Vendor vs build-in-CI?~~ **Resolved: vendor a pinned prebuilt (hosted release
  asset, not in git history); rebuilt manually on the infrequent MicroHs bumps. An
  explicit, recorded exception to ADR 0002's build-in-CI rule — the emscripten +
  self-hosting-Haskell build is far heavier than `wasm-pack`.**
- ~~Primitive handling?~~ **Resolved: curated examples + a Scott-`Nat` primitive-free
  Prelude (numbers + `Char`/`String` as ASCII Scott `Nat`, so arithmetic/recursion/
  text run as pure ι) + honest reject of the `IO`/FFI/`Float` residue. No silent
  boxing. Char/string ι-trees are huge but recovered by the optimize mode.**
- Forking MicroHs to expose `compileToComb` + the char-literal/Prelude tweaks —
  fork burden / upstream tracking.
- Where the SKI-expansion (`Iota.hs`) step runs: TS port vs in the WASM slice.
  *(Default: port to TS — ~40 lines, keeps the WASM slice a pure compiler and the
  bit-code boundary clean.)*
- ~~Subsume or coexist with the offline gallery + oracle?~~ **Resolved: coexist with
  roles split — the curated examples become editable live-compiled source (the live
  compiler subsumes the baked-bitcode import path), and the differential oracle
  survives as separate dev/CI correctness infra (`reduce.ts` vs MicroHs `iota/check`
  on random terms).**

## Deployment & vendoring (implemented, v8.0)

The runtime assets are **not in git** (ADR 0002 exception, above) and are **not built
in CI** (the emscripten + self-hosting-Haskell build is too heavy for the Pages
workflow). Instead:

- **MicroHs runtime** — `mhs-batch.js` (the batch blob), `base.mhscache` (prewarmed
  Prelude cache), and the gallery `examples/*.comb` are bundled into
  `mhs-vendor.tar.gz` and hosted on the **`vendor-assets` GitHub Release**. The Pages
  workflow pulls it with `gh release download` (the repo is private; the workflow's
  `GITHUB_TOKEN`/`contents: read` authorises it), extracts it into `public/vendor/mhs/`,
  and `vite build` copies it into `dist/`. Re-upload with `--clobber` on the
  infrequent MicroHs bumps.
- **DuckDB** (ADR 0008) — a third-party ~76 MB engine, **not our responsibility to
  host**: loaded from the **jsDelivr CDN** at runtime via `getJsDelivrBundles()`. Not
  vendored at all.
- **IoskeleyMono webfont** (the syntax-highlighted Haskell editor) is also on the
  `vendor-assets` Release (`IoskeleyMono-Regular.woff2`), fetched by the same CI step
  and `@font-face`'d via a base-aware `vendorUrl`.
- **Base-aware URLs** — the SPA is built with vite `base: "./"` so it hosts from the
  `/Combinate/` Pages subpath. Runtime-fetched public assets (which vite does *not*
  rewrite) go through `src/vendorUrl.ts` (`BASE_URL + path` resolved against
  `document.baseURI`), so a `/vendor/...` asset resolves on the subpath, not the
  origin root. The live-compile worker gets the blob's absolute URL by message (it
  has no `document` to resolve against).
- **Splash preload** — the boot splash warms the blob + cache (and the refold lens
  wasm) up front, so the panel's first compile doesn't pay the 3 MB download.

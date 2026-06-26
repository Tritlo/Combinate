# 7. In-browser MicroHs Haskell→combinator compiler (v8, the wow feature)

**Status:** accepted — **implemented via post-processing a *stock* dump (no fork)**, superseding the original "vendor a forked compile-only slice" decision. Gallery path shipped and verified; live free-typing is experimental. See *Revised decision* below; the original decision/context is kept beneath it as history.

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
- **Live free-typing:** wired through the stock blob in a Web Worker, but the
  vendored blob is the *interactive playground* build whose base package isn't set
  up for a headless batch compile — so it degrades to an honest message for now.
  A clean live path needs a batch blob (or a `compileToComb` export, or replicating
  the playground's package FS). The gallery is the headline either way.
- **Vendoring (ADR 0008-adjacent):** `scripts/vendor-wasm.sh` copies the DuckDB
  engine + the MicroHs blob into `public/vendor/` (git-ignored); served from our own
  origin, CDN-swappable later.

**Known limitation — no graph sharing.** The sandbox reducer clones rather than
shares, so Scott `×` (repeated addition) makes multiplication-*recursion*
exponential: `fac 3` is fine (~3 s), `fac 4+` blows up. The gallery is curated to
linear/structural programs; **graph reduction (sharing) is the follow-up** that
unlocks factorial-scale programs (and would speed every existing reduction).

This **supersedes ADR 0002's** "build the WASM in CI" rule only for the *blob* (a
vendored prebuilt, hosted later); the post-processor itself is ordinary CI-built TS.

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

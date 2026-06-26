# 7. In-browser MicroHs Haskell→combinator compiler (v8, the wow feature)

**Status:** accepted (finalised in a grill-with-docs pass; remaining open items are implementation defaults)

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

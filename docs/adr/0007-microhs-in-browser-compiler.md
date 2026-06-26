# 7. In-browser MicroHs Haskell→combinator compiler (v8, the wow feature)

**Status:** proposed (draft — to be finalised by a grill-with-docs pass)

## Context

The flagship "wow": type a real Haskell program, watch it **compile to ι and
reduce** in the sandbox. The earlier MicroHs deep-dive (ADR-adjacent notes)
*deferred* this — the compile-only WASM slice is ~1.5–2.5 MB and needs an
emscripten/Haskell toolchain, ~8× the egg adapter and a second CI toolchain. The
maintainer now wants it as the headline feature, accepting that cost. The hard
boundary is unchanged: only the **closed, primitive-free fragment** (Scott/Peano
data, no `Int`/`IO`/`Char`/FFI literals) has a combinatory form; everything else
is an opaque primitive with no ι.

## Decision

Vendor a **compile-only MicroHs WASM slice** as a lazy, off-main-bundle driven
adapter (mirrors the egg lens, ADR 0002), behind a pure port in `src/core/`:

- Expose `compileToComb(source) → combinator dump` (+ `typeOf`) — MicroHs already
  factors these stages (`Interactive.compile`, the pure `compileToCombinators`);
  the fork adds a thin entry point.
- Convert the combinator dump → Barker bit-code (the `iota/Iota.hs` SKI-expansion
  step, ported to TS or compiled into the slice), then load via `decode()`.
- **Reject** programs that hit a primitive with a clear "this needs a runtime
  value with no ι form — use Peano/Scott data" message (do not silently box
  primitives — that would break "it's all ι").
- Lazy-load in a Web Worker; the compiler bytes are fetched only when the Haskell
  panel is opened.

## Why

The headline "real Haskell becomes birds" feature; MicroHs is mature prior art
that already emits exactly the bit-code `decode()` ingests; reuses the bit-code
bridge end-to-end. Worth the weight *because* it is the wow, not maintenance
reduction.

## Consequences

- ~1.5–2.5 MB lazy artifact (vs 310 KB egg) — must be gated/lazy/off by default.
- A second WASM toolchain (emscripten/clang). Strongly prefer **vendoring a pinned
  prebuilt blob** over adding emscripten to CI; accept the version-lock to
  `base.pkg` and re-verify the iota mapping on each bump.
- The primitive wall means the *first* program many users type (with a literal `3`
  or `putStrLn`) is rejected — UX must teach the primitive-free fragment up front.

## Open questions (for the grill)

- Vendor a pinned prebuilt blob vs build the slice in CI (emscripten cost).
- Forking MicroHs to expose `compileToComb` — fork burden / upstream tracking.
- Primitive handling: hard-reject vs opaque boxes vs a "values" lens — how to keep
  the wow without the first program failing.
- Where the SKI-expansion (`Iota.hs`) step runs: TS port vs in the WASM slice.
- Does this subsume or coexist with the curated offline gallery + differential
  oracle (the earlier, cheaper v8)?

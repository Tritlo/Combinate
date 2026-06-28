# `reduce` — wasm raw combinator reducer (verified capability, **not wired**)

A flat-arena raw reducer (ι/I/K/S + definition-unfold) that mirrors `src/core/reduce.ts` in
its NON-fast ("plain pure-ι") mode **exactly**. The combinator definitions are supplied by
TS (`catalog.ts`'s `def()`) via the wire format, so there is **zero** catalog-rule / native-
kernel duplication here — the only rules baked into Rust are ι/I/K/S.

## Status: built + verified, then shelved

Proven correct (`npm run check:reduce-wasm` — 213/0 against the TS reducer) and fast in
isolation (42× the JS reducer), but **deliberately not integrated**: the end-to-end win
(encode → wasm → decode) is only 2–3× on already-sub-10ms terms because the JS-side codec
dominates, and the heavy arithmetic/data paths are already handled by native kernels + graph
sharing. See `docs/perf-spike-findings.md` for the full rationale. Revisit only if a
visibly-slow (>100 ms) raw-reduction product path appears.

## Build + check

```sh
npm run build:reduce-wasm   # wasm-pack → crates/reduce/pkg-node (git-ignored)
npm run check:reduce-wasm   # build, then cross-check wasm NF == TS non-fast NF
```

The wire format is documented at the top of `src/lib.rs`; the TS codec is
`src/core/wasmCodec.ts`.

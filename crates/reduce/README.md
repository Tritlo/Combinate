# `reduce` — wasm raw combinator reducer (the "Turbo" engine)

A flat-arena raw reducer (ι/I/K/S + definition-unfold) that mirrors `src/core/reduce.ts` in
its NON-fast ("plain pure-ι") mode **exactly**. The combinator definitions are supplied by
TS (`catalog.ts`'s `def()`) via the wire format, so there is **zero** catalog-rule / native-
kernel duplication here — the only rules baked into Rust are ι/I/K/S.

## What it powers

The **Turbo (wasm)** optimization (Optimizations modal): a resident `Session` keeps the term
+ def trees in linear memory so the playback loop runs thousands of contractions per frame
without marshalling, snapshotting the current term out only for display. This makes big raw
trees — MicroHaskell-compiled programs — reduce in ~1 s instead of minutes. Turbo is raw-only
(it ignores the rules/native/graph options); the TS reducer stays canonical for normal play.

## API

- `reduce_to_nf(data, cap) -> nf` — one-shot (the cross-check oracle).
- `Session::new(data)` / `step_budget(n)` / `snapshot()` / `is_done()` / `node_count()` /
  `free()` — the resident reduction. `snapshot()` compacts the arena while preserving the
  immutable def-tree prefix (`def_len`), so `def_root` indices stay valid across snapshots.

The wire format is documented at the top of `src/lib.rs`; the TS codec is
`src/core/wasmCodec.ts`; the browser adapter is `src/view/wasmReducer.ts`.

## Build + check

```sh
npm run build:wasm          # builds refold + reduce (web target) into pkg/ (git-ignored)
npm run check:reduce-wasm   # build (nodejs target) + cross-check vs the TS reducer
```

Cross-check: **213/0** (one-shot + session) against the TS non-fast reducer, over the full
catalog + a 160-case arithmetic grid + church numerals, plus **session invariance 3/0**
(def-survives-compaction + batch-invariance). Built from source, artifacts git-ignored.

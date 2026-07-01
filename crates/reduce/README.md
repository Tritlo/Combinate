# `reduce` — wasm combinator reducer (the "Turbo" engine)

A flat-arena combinator reducer that mirrors `src/core/reduce.ts` + `graph.ts`, with two entry
points:

- **`reduce_to_nf(data, cap)`** — a one-shot RAW reducer (ι/I/K/S + definition-unfold for saturated
  named combinators). This is the non-fast "plain pure-ι" mirror of `reduce.ts`, kept as the
  cross-check **oracle**; it ignores rules/native.
- **`GraphSession`** — a resident call-by-need GRAPH engine (sharing, so Scott arithmetic / fac-scale
  computations never materialise the blown-up tree). It does native KERNELS (clean Scott numbers /
  lists / booleans) and, in FAST mode, RULE-based reduction: a saturated named combinator reduces by
  its catalog law in one step instead of def-unfolding the Y/SKI recursion (ADR 19).

All def trees, kernel gates, and rule templates are supplied by TS (`catalog.ts`) over the wire
(`wasmCodec.ts`), so there is **zero** rule/kernel *logic* in Rust — the engine just instantiates a
template it was handed (the same mechanism for a rule as for a def-unfold). Only the ι/I/K/S dispatch
+ the graph machinery are baked into Rust.

## What it powers

The **Turbo** optimization (Optimizations menu). Turbo forwards the current options into the resident
session, so `wasm + rules + native + sharing` is the fastest reduction tier (ADR 19): fewest steps
via rules, no blow-up via sharing, fast wall-clock via wasm. Big raw trees — MicroHaskell-compiled
programs — reduce in ~1 s instead of minutes. Turbo steps aside for Graph mode (which drives its own
loop); the TS reducer stays canonical for normal play.

## API

- `reduce_to_nf(data, cap) -> nf` — one-shot raw reducer (the cross-check oracle).
- `GraphSession::new(data)` / `step_budget(n)` / `snapshot()` / `is_done()` / `total_steps()` /
  `node_count()` — the resident graph reduction. `snapshot()` reads back the live DAG and compacts
  the arena while preserving the immutable def/rule-template prefix (`def_len`), so template indices
  stay valid across snapshots.

The wire format is documented at the top of `src/lib.rs`; the TS codec is
`src/core/wasmCodec.ts`; the browser adapter is `src/view/wasmReducer.ts`.

## Build + check

```sh
npm run build:wasm          # builds refold + reduce (web target) into pkg/ (git-ignored)
npm run check:reduce-wasm   # build (nodejs target) + cross-check vs the TS reducer
```

The cross-check runs the RAW `reduce_to_nf` oracle against the TS non-fast reducer over the full
catalog + an arithmetic grid + church numerals (plus session-invariance: def-survives-compaction +
batch-invariance), and FAST-mode parity (`wasm+rules+native` vs the TS fast path) over hundreds of
cases + the vendored MicroHs example dumps — see ADR 19 for the current counts. Built from source;
artifacts git-ignored.

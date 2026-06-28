# Performance deep-cut — spike findings (reorg-perf branch)

Measured this session (WSL2; wall-clock is noisy here, so these are throughput ratios on
identical workloads, which are stable).

## Reducer throughput — `church(N) I x` (pure SKI, leftmost-outermost, identical step counts)

| impl | steps/sec | vs JS |
|------|-----------|-------|
| JS `reduce.ts` (persistent, JS objects + GC) | ~1.9M | 1× |
| Rust arena → **wasm** (`reduce-spike`, term built in-wasm) | ~80M | **42×** |
| Rust arena → native | ~157M | 82× |

Step counts match exactly across all three (1202 / 3002 / 6002 for N=200/500/1000) →
correctness cross-checked. The wasm number is the boundary-free best case (only a u32
crosses); a real adapter pays marshaling on the way in + (for tree results) out.

## Native value kernels (already shipped, ADR 10/11)

`(*) 12 12`: Scott recursion 31/s vs native kernel 8189/s = **264×**. Kernels compute
`a*b` in JS and emit the canonical Scott tree directly. The residual cost on heavy compute
is **tree materialization** (`(*) 80 80` OOMs building a 6400-deep Scott numeral as JS
objects — a GC/heap failure, not arithmetic).

## Rendering

ParticleContainer (batched) + viewport culling + glyph LOD (drop >300 nodes) + jump-cut
(>600 nodes). Holds ~60fps on a 400-node static tree (rAF caps at 60 headless, so
sub-frame headroom isn't visible). Per-frame hot path is `drawEdges` (full `Graphics`
clear + geometry rebuild over the edge list, dashed segments multiplying geometry on small
trees) — **GPU/geometry-bound, not JS-math-bound**, so wasm position math wouldn't help.

## Decision (consensus with Codex)

1. **Narrow wasm `readValue` / `reduceToNF` adapter** — wasm reduces raw ι/S/K/I + unfolds
   named combinators via **def trees imported from TS** (zero catalog/kernel duplication;
   rules come from `catalog.ts`'s `def()`). TS reducer stays canonical for animated
   single-step play; wasm is used for value-read + skip-to-NF + graph-headroom. Strongest
   fit: value-read returns a primitive (no tree marshaling). Cross-checked against the
   answer-key + native-grid (wasm NF must structurally equal TS NF).
2. **Pure-TS edge-rendering** optimization (`drawEdges` geometry caching / edge LOD).
3. Deferred: TS arena/pooling; a full wasm core / Rust-ported catalog rules (needs a
   shared rule-spec generator to avoid drift — not worth it yet).

`crates/reduce-spike/` is the throwaway proof (build artifacts git-ignored).

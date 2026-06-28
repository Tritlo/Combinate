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

## Built + verified, then SHELVED (consensus with Codex)

The narrow wasm reducer was **built and verified**, then deliberately **not wired** — the
end-to-end win doesn't justify the surface.

- `crates/reduce` (Rust→wasm): flat-arena raw reducer (ι/I/K/S + def-unfold). Defs are
  imported from TS (`catalog.ts`'s `def()`), so there is **zero** catalog-rule / kernel
  duplication — it mirrors TS `normalize(_, cap, false)` exactly.
- `src/core/wasmCodec.ts`: pure `Node ↔ Int32Array` codec (closes over each reachable
  combinator's def tree).
- `scripts/wasm-reduce-check.mts` (`npm run check:reduce-wasm`): the regression net —
  **213 pass / 0 fail** (full catalog on free vars + 160-case arithmetic grid + church;
  13 divergent correctly bail). wasm NF structurally == TS non-fast NF.

**Why shelved, not wired:** raw reduction in isolation is 42×, but **end-to-end (encode +
wasm + decode) is only 2–3×** on moderate terms — the JS-side codec dominates (encode walks
the whole term; decode rebuilds JS `Node`s), and those operations are already sub-10ms
(church(600): TS 4.5 ms → wasm+codec 1.6 ms). The 42× only survives if the term stays
*resident* in wasm across operations (no per-call marshal) — which needs opaque handles for
spawn/snap/delete/authoring/permalink/readout, i.e. a second runtime + a view rewrite, not a
narrow adapter. The heavy *arithmetic/data* paths are already covered by native kernels +
graph sharing, so the only niche left (hand-built raw SKI that takes >100 ms or OOMs) is
rare in an educational sandbox.

**Decision:** keep `crates/reduce` + the codec + the cross-check as a verified, documented
capability (built from source, artifacts git-ignored — like `refold`); revisit only if a
visibly-slow (>100 ms) raw-reduction product path appears. Put the effort into the two wins
that do land:

1. **Pure-TS edge-rendering** — DONE: cache edge endpoint refs so the per-frame draw skips
   the `objs` Map lookups (the unavoidable floor is the `Graphics` geometry + GPU upload).
2. **app.ts reorg** + the `redexAt` O(D²)→O(D) NF-scan fix (DONE) — the real maintainability
   and hot-path wins.

Deferred: TS arena/pooling; a full wasm core (needs a shared rule-spec generator to avoid
drift).

## Auto-switch cutoff (TS ↔ wasm graph) — measured

The Turbo engine engages by size (small → TS per-step animation, big → wasm). Measured
TS-`normalize` vs the full wasm pipeline (encode + GraphSession + snapshot + decode), median
of 7, raw mode:

| workload | nodes | TS | wasm | winner |
|----------|-------|-----|------|--------|
| `S K K x` (overhead floor) | 7 | 0.006 ms | 0.039 ms | TS (wasm fixed cost ~0.03 ms) |
| `church(60) I x` | 607 | 0.43 | 0.22 | wasm 2.0× |
| `church(250) I x` | 2507 | 1.12 | 0.89 | wasm 1.3× |
| `church(500) I x` | 5007 | 1.96 | 3.16 | **TS 1.6×** (encode dominates) |
| `(*) 2 2` (Scott, raw) | 13 init | 9.8 | 0.2 | **wasm 54×** |
| `(*) 3 3` | 17 init | 114 (capped) | 0.2 | **wasm 700×** |
| `(*) 4 4` | 21 init | 1234 (capped) | 0.4 | **wasm 3350×** |

Takeaways: (1) cheap reductions are sub-3 ms either way — a wash — and wasm even *loses* past
~5000 nodes (its encode is O(size)); (2) the expensive cases that wasm crushes (50-3350×)
start TINY and balloon — so the *initial* tree size is a poor predictor. The right trigger is
the tree GROWING during reduction (the mid-reduction upgrade) plus a struggling-step backstop.
Cutoff: `TURBO_MIN_NODES = 600` (the view's jump-cut threshold — no animation lost above it,
and perf is a wash there) OR `TURBO_MIN_STEPS = 1200` (a grinding reduction hands off to wasm
rather than pausing at the 2000-step cap).

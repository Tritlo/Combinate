# Incremental reflow plan (deeper-perf)

> **Status: SHIPPED** as ADR 0018. Kept as the design record; see
> `docs/adr/0018-incremental-reflow.md` for the accepted decision.

Goal: make the per-step tree reflow **O(changed)**, not O(n), by exploiting that a reduction step
leaves ~93% of nodes unchanged (the reducer already preserves their ids). Drafted with the Magi
council (Codex).

## Where we are (baseline, on `no-lag`)
The freeze is fixed at the *pacing* level: a heavy raw/optimize term reduces in budgeted background
batches (`stepHeavyTs`) and only reflows once it's small enough to draw in a frame; a ballooning raw
term pauses cleanly (`BALLOON_CAP`). Plus cheap wins: skip the place() for persisting nodes whose
position is unchanged (diff), and skip sub-pixel edges (LOD). Measured on quicksort: worst frame gap
**496ms → 87ms**, frames >80ms **65 → 1**.

This branch goes after the reflows that *do* happen: make them touch only what changed.

## Measured facts
- Trees are huge (14k–44k nodes) and ~93% of node ids PERSIST per contraction (avg ~900 enter, ~550
  leave). Particles already reuse by id.
- Each reflow still redoes the FULL layout walk, `collectNodes`, and `drawEdges` (one `Graphics` path).
- **top-down / radial** layouts position by GLOBAL leaf order → a change ripples widely (leave them on
  full recompute).
- The **H-tree** layout is path-local: a node's position = f(path from root) × a global initial arm
  `L0`, where `L0 = f(max depth)`. An unchanged subtree keeps its exact positions **iff `L0` is
  stable**.

## Architecture (Codex-reviewed)
1. **Reducer seam — a structural patch.** Add `stepWithPatch()` → `{ root, sym, path, oldRedex,
   replacement }`. The reducer already finds the single leftmost-outermost redex and rebuilds the
   preserved spine by id-preserving copies, so exposing the redex path + the replaced subtree is nearly
   free. The VIEW derives the dirty id-set from `oldRedex` + `replacement` **after `expandDisplay`** —
   do NOT return view-specific ids from core (undiscovered-combinator expansion is a view concern).
2. **Dirty set ≠ fresh/removed only.** 93% of *ids* persist, but not 93% of *positions*: `K x y → x`
   and `S` can move a large *preserved* subtree to a new path/depth. Dirty = every node whose
   path/depth changed. Algorithm: recompute H-tree positions for the replacement subtree from its
   parent anchor + depth; compare to cached positions; mark moved ids + their incident edges dirty.
3. **Freeze / quantize `L0` per tree (THE critical fix).** If `L0` tracks max depth, a depth change
   rescales *every* position — exactly the ripple we're escaping, and it'll show as intermittent
   whole-tree jumps that are miserable to debug. So: fix `L0` per tree in heavy/reducing mode until an
   explicit full refit (e.g. on settle, or a manual re-frame); treat any `L0` change as a full
   relayout, not an incremental step. Remove the "rescale is rare" assumption before committing to
   O(changed).
4. **Retained edges.** Replace the single `Graphics` path with a small number of `Mesh`/geometry
   buffers by style/tier. `edgeKey = parentAppId + side`, `nodeId → incident edge ranges`, freelist /
   tombstone compaction. Update only the ranges incident to moved/changed nodes. Keep the size +
   viewport LOD. (Do NOT create one Pixi object per edge.)
5. **A separate heavy H-tree renderer path.** `layoutCache: id → {x, y, depth, pathHash}`, a node
   index, a retained `EdgeBuffer`, and `applyPatch(patch)`. Keep the existing `TreeView.animateTo` for
   small trees and non-H layouts. Switch to H-tree heavy mode only above the node threshold. Graph/DAG
   sharing falls back initially (one node / many paths conflicts with path-local layout unless an owner
   path is defined).
6. **Make H-tree the default** for big/reducing trees — it enables O(changed) updates and reads well
   when dense.

## Order of work
1. Quantize/freeze `L0` in the H-tree layout for reducing trees (kills the rescale ripple first).
2. `stepWithPatch()` on the reducer (path + oldRedex + replacement).
3. Retained `EdgeBuffer` (dirty-range updates), behind the existing draw path.
4. Incremental `applyPatch` in a heavy H-tree renderer: dirty-set from the patch, move only changed
   particles, dirty only incident edges.
5. Default big/reducing trees to the H-tree; verify O(changed) with the frame-gap + CPU profile
   harness (`playwright-core` + CDP, `__combinate.haskell.run('quicksort')`).

## Verification
Same harness as `no-lag`: measure worst frame gap + `>80ms` frame count during `quicksort`, and confirm
`drawEdges`/layout self-time drops with tree size held constant (O(changed), not O(n)).

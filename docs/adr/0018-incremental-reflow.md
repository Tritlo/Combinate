# 18. O(changed) incremental H-tree reflow

**Status:** accepted

## Context

A reduction step leaves ~93% of node ids unchanged (the reducer preserves them), yet the view
redid the FULL layout walk + `collectNodes` + a single-`Graphics` `drawEdges` every step — O(n). On a
14k–44k-node quicksort intermediate that froze the UI, so the earlier `no-lag` work simply *hid* big
trees (reduce in the background, reflow only when small). We want to actually *show* the reduction.

## Decision

Make the per-step reflow scale with the CHANGED node set, not tree size, on the H-tree (the only
path-local layout — a node's position is a function of its path from root × a per-tree-frozen arm
`L0`, so an unchanged subtree keeps its exact place).

- **`reduce.stepWithPatch`** returns `{ root, sym, path, oldRedex, replacement }` — the redex location
  plus the old/new subtrees — gathered as a by-product of the existing search (no extra traversal).
  `step`/`redexAt` are unchanged.
- **`TreeView.applyPatch`** re-places only the replacement subtree from its unchanged anchor + depth
  (`layoutHTreeSubtree`), moves only the particles that moved (K/S can shift a *preserved* subtree, so
  dirty ≠ fresh/removed — it's every node whose path/depth changed), and removes/upserts only incident
  edges. Particle removal recycles into a pool (Pixi `removeParticle` is O(n)).
- **`EdgeBuffer`** — two resident line-list meshes (one per depth tier), each edge pinned to a fixed
  slot keyed by `parentId+side`; an update writes four floats, a removal collapses + frees the slot.
  So edges are O(changed), not an O(n) re-tessellation. Solid 1px, heavy path only; small/animated
  trees keep the Graphics renderer (dashes, width, LOD).
- Big/reducing trees default to the H-tree (`layoutAuto`, compiled programs), reducing live in
  budgeted batches. A ballooning intermediate past a render cap hands back to the background path
  (frozen snapshot stays up). Small trees, non-H layouts, and graph/DAG sharing keep the full
  `animateTo` recompute.

## Consequences

Measured: `applyPatch` grows 2.3× over a 16× tree-size range (a full recompute grows 17.8× — O(n)),
i.e. a 31×→234× speedup that widens with size — O(changed + path depth). Incremental layout matches a
full recompute exactly (0 parity mismatches). quicksort's reduction-phase p99 frame gap dropped
40→32ms. The remaining worst frame is a one-time boot / first-render cost (~82ms), unchanged from the
baseline and orthogonal to the reflow. `L0` must stay frozen per tree (step 1) or a depth change
rescales everything and defeats the whole scheme.

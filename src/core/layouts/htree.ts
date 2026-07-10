import { type Node, type NodeId } from "../term";
import { type Layout, type Pos, bounds, countNodes, HTREE_MIN_ARM, HTREE_SHRINK } from "./types";
import { layoutTopDown } from "./topdown";

/**
 * H-tree layout: each application places its two children symmetrically offset from the node, the
 * split direction ROTATING a quarter-turn clockwise per depth — arg → right, down, left, up (fn
 * opposite), so the split axis still alternates horizontal/vertical, but one level deeper is a true
 * 90° rotation of the same layout, not a mirror. A subterm therefore draws as a rotated copy of its
 * standalone picture (expanded S visibly contains expanded K turned a quarter-turn) — the 2D analog
 * of the 3D H-tree, whose X→Y→Z axis cycle is already a rotation (ADR 25). The arm length shrinks
 * geometrically per level (`HTREE_SHRINK`), so a deep spine coils into a shrinking rectangular
 * spiral with the leaves fringing off it. Because the shrink stays below 1/√2 sibling subtrees
 * never overlap (the extent bound is per split axis, so the sign of the direction doesn't matter).
 * The initial arm scales with the node count (bigger terms start with a longer arm). Root at (0, 0).
 */
export function layoutHTree(root: Node, frozen?: { l0?: number }): Layout {
  // Modest initial arm, scaled by node count — the tree stays COMPACT (no giant span / zoom-out); deep
  // tips stay legible by shrinking the NODES to their arm (the `scale` map below), NOT by inflating L0.
  // FROZEN across a reduction (deeper-perf, ADR 18): a reducing tree passes its cached L0 so a changing
  // node count doesn't rescale every node each step — which would defeat the incremental O(changed)
  // reflow. Re-fit only on an explicit event (fresh tree, layout switch, discovery).
  const L0 = frozen?.l0 ?? (80 + 40 * Math.log2(countNodes(root) + 2));
  const pos = new Map<NodeId, Pos>();
  const scale = new Map<NodeId, number>();
  placeHTree(root, 0, 0, 0, L0, pos, scale);
  return { pos, scale, l0: L0, ...bounds(pos) };
}

/** The H-tree placement recursion, shared by {@link layoutHTree} and {@link layoutHTreeSubtree} so
 *  the incremental reflow re-places a subtree with the exact same geometry as a full relayout. Fills
 *  `pos` / `scale` / `depthOut` for `node` and its descendants, hung from (`x`, `y`) at `d`. */
function placeHTree(node: Node, x: number, y: number, d: number, L0: number, pos: Map<NodeId, Pos>, scale: Map<NodeId, number>, depthOut?: Map<NodeId, number>): void {
  if (pos.has(node.id)) return; // DAG (graph mode): position each shared node once — a no-op on a tree
  pos.set(node.id, { x, y });
  depthOut?.set(node.id, d); // only layoutHTreeSubtree needs the depth map back (edge tiering); full layout skips it
  // Shrink a node toward its shortest adjacent arm so it never overwhelms the structure (the "gray
  // blob" on deep spines): full-size while arms are long, then scaling in PROPORTION to the arm —
  // no floor, so dots/glyphs shrink exactly like the distances between them and a deep spiral
  // converges to a point instead of a blob (zoom recovers the detail).
  const childArm = L0 * HTREE_SHRINK ** d;
  const minArm = node.kind === "app" ? childArm : L0 * HTREE_SHRINK ** Math.max(0, d - 1); // leaf → its parent arm
  scale.set(node.id, Math.min(1, minArm / HTREE_MIN_ARM));
  if (node.kind !== "app") return;
  const [dx, dy] = HTREE_DIRS[d % 4]!; // arg → +dir, fn → −dir; dir rotates 90° cw per level
  placeHTree(node.fn, x - dx * childArm, y - dy * childArm, d + 1, L0, pos, scale, depthOut);
  placeHTree(node.arg, x + dx * childArm, y + dy * childArm, d + 1, L0, pos, scale, depthOut);
}

/** The arg-side split direction per depth (mod 4): right, down, left, up — a clockwise quarter-turn
 *  each level, so nested subtrees stay rotationally congruent to their standalone layouts. */
const HTREE_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * Re-place just `subtreeRoot` and its descendants as an H-tree hung from (`x`, `y`) at depth `d`,
 * reusing the frozen arm scale `l0`. For the incremental reflow (deeper-perf, ADR 18): the anchor
 * slot + depth come from the unchanged spine, so the subtree lands EXACTLY where a full relayout
 * would put it — letting the view recompute only the changed neighbourhood. Cost is O(subtree).
 */
export function layoutHTreeSubtree(subtreeRoot: Node, x: number, y: number, d: number, l0: number): { pos: Map<NodeId, Pos>; scale: Map<NodeId, number>; depth: Map<NodeId, number> } {
  const pos = new Map<NodeId, Pos>();
  const scale = new Map<NodeId, number>();
  const depth = new Map<NodeId, number>();
  placeHTree(subtreeRoot, x, y, d, l0, pos, scale, depth);
  return { pos, scale, depth };
}

/** Past this top-down span (px) a tree is too wide/tall for a typical screen, so it gets
 *  the more compact H-tree layout instead. */
const COMPACT_SPAN = 1400;

function autoLayoutProbe(root: Node): { key: "topdown" | "htree"; topdown: Layout } {
  const topdown = layoutTopDown(root);
  return { key: topdown.width > COMPACT_SPAN || topdown.height > COMPACT_SPAN ? "htree" : "topdown", topdown };
}

/** Auto layout: top-down while a tree fits, the compact H-tree once it grows too big. The H-tree is
 *  path-local, so a big reducing tree reflows in O(changed) per step; it threads the frozen arm scale so
 *  a node-count change mid-reduction doesn't rescale everything (deeper-perf, ADR 18). */
export function layoutAuto(root: Node, frozen?: { l0?: number }): Layout {
  // A frozen arm scale means the tree is already an H-tree mid-reduction — stay H-tree and skip the O(n)
  // top-down probe on every full recompute. A fresh tree (no frozen l0) probes to pick a layout.
  if (frozen?.l0 !== undefined) return layoutHTree(root, frozen);
  const probe = autoLayoutProbe(root);
  return probe.key === "htree" ? layoutHTree(root, frozen) : probe.topdown;
}

import { type Node, type NodeId } from "./term";

/** Top-down grid spacing. */
const XS = 56;
const YS = 64;
/** Radius added per depth level in the radial layout. */
const RING = 84;

export interface Pos {
  x: number;
  y: number;
}

export interface Layout {
  /** Node positions in local coordinates, with the root anchored at (0, 0). */
  pos: Map<NodeId, Pos>;
  /** Optional per-node glyph-scale (0–1). A layout with a wide range of edge lengths (H-tree) uses
   *  this to shrink nodes toward their local arm so they don't overwhelm the structure; a node
   *  without an entry (or a layout that omits the map) renders at full size. */
  scale?: Map<NodeId, number>;
  /** The H-tree arm scale used (px). The view caches this and passes it back while a tree reduces, so a
   *  changing max depth doesn't rescale the whole layout every step (see {@link layoutHTree}'s `frozen`);
   *  it also flags a layout as an H-tree (the incremental-reflow eligibility marker). */
  l0?: number;
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A layout algorithm: term → node positions. `frozen` carries the previous layout's frozen scale (the
 *  H-tree's L0) so a reducing tree keeps a stable arm length across steps; layouts that don't need it
 *  ignore it. */
export type LayoutFn = (root: Node, frozen?: { l0?: number }) => Layout;

function bounds(pos: Map<NodeId, Pos>): Omit<Layout, "pos"> {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const { x, y } of pos.values()) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { width: maxX - minX, height: maxY - minY, minX, maxX, minY, maxY };
}

/**
 * Tidy top-down layout (port of `treedraw.annotate`, §5.1): leaves on a regular
 * in-order grid, each application hung at the midpoint of its two children;
 * depth grows downward. Root offset to (0, 0).
 */
export function layoutTopDown(root: Node): Layout {
  const gridX = new Map<NodeId, number>();
  const depth = new Map<NodeId, number>();
  let leafIndex = 0;

  const walk = (n: Node, d: number): void => {
    if (depth.has(n.id)) return; // DAG (graph mode): position each shared node once — a no-op on a tree
    depth.set(n.id, d);
    if (n.kind === "app") {
      walk(n.fn, d + 1);
      walk(n.arg, d + 1);
      gridX.set(n.id, 0.5 * (gridX.get(n.fn.id)! + gridX.get(n.arg.id)!));
    } else {
      gridX.set(n.id, leafIndex++);
    }
  };
  walk(root, 0);

  const rootGridX = gridX.get(root.id)!;
  const pos = new Map<NodeId, Pos>();
  for (const [id, gx] of gridX) {
    pos.set(id, { x: (gx - rootGridX) * XS, y: depth.get(id)! * YS });
  }
  return { pos, ...bounds(pos) };
}

/**
 * Root-centered radial layout (port of `treedraw.svg_radial`, §5.1 radial mode):
 * the root sits at the center, depth maps to radius, the in-order leaves spread
 * evenly around the full circle, and each application takes the midpoint angle
 * of its two children — so the tree fans out from the center.
 */
export function layoutRadial(root: Node): Layout {
  const depth = new Map<NodeId, number>();
  let leafCount = 0;
  const measure = (n: Node, d: number): void => {
    if (depth.has(n.id)) return; // DAG (graph mode): count each shared node once — a no-op on a tree
    depth.set(n.id, d);
    if (n.kind === "app") {
      measure(n.fn, d + 1);
      measure(n.arg, d + 1);
    } else {
      leafCount++;
    }
  };
  measure(root, 0);

  const angle = new Map<NodeId, number>();
  const total = Math.max(1, leafCount);
  let leafIndex = 0;
  const setAngle = (n: Node): void => {
    if (angle.has(n.id)) return; // DAG (graph mode): angle each shared node once — a no-op on a tree
    if (n.kind === "app") {
      setAngle(n.fn);
      setAngle(n.arg);
      angle.set(n.id, 0.5 * (angle.get(n.fn.id)! + angle.get(n.arg.id)!));
    } else {
      angle.set(n.id, (2 * Math.PI * leafIndex) / total);
      leafIndex++;
    }
  };
  setAngle(root);

  const pos = new Map<NodeId, Pos>();
  for (const [id, d] of depth) {
    const r = d * RING;
    const a = angle.get(id)!;
    pos.set(id, { x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return { pos, ...bounds(pos) };
}

/** H-tree shrink factor. Held below 1/√2 ≈ 0.707, which keeps sibling subtrees from ever
 *  overlapping — a subtree's extent along the split axis is `e·s²/(1−s²)`, which is `< e` exactly
 *  when `s < 1/√2`, so the two children (placed `±e` apart) can't collide, for any tree shape. */
export const HTREE_SHRINK = 0.68;

/** Count distinct nodes (DAG-safe) — used to scale a layout's initial arm length. */
export function countNodes(root: Node): number {
  const seen = new Set<NodeId>();
  const walk = (n: Node): void => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    if (n.kind === "app") {
      walk(n.fn);
      walk(n.arg);
    }
  };
  walk(root);
  return seen.size;
}

/**
 * H-tree layout: each application places its two children symmetrically offset from the node, the
 * split direction ROTATING a quarter-turn clockwise per depth — arg → right, down, left, up (fn
 * opposite), so the split axis still alternates horizontal/vertical, but one level deeper is a true
 * 90° rotation of the same layout, not a mirror. A subterm therefore draws as a rotated copy of its
 * standalone picture (expanded S visibly contains expanded K turned a quarter-turn) — see ADR 25
 * (and ADR 26 for the 3D H-tree's signed cousin of this cycle). The arm length shrinks
 * geometrically per level (`HTREE_SHRINK`), so a deep spine coils into a shrinking rectangular
 * spiral with the leaves fringing off it. Because the shrink stays below 1/√2 sibling subtrees
 * never overlap (the extent bound is per split axis, so the sign of the direction doesn't matter).
 * The initial arm scales with the node count (bigger terms start with a longer arm). Root at (0, 0).
 */
/** The arm length (px) at which a node's glyph reaches full size; where arms are shorter (deep in the
 *  tree) the node shrinks WITH its arm, so a short arm never looks unnatural next to the glyph.
 *  Shared with the 3D H-tree so 2D and 3D shrink in lockstep. */
export const HTREE_MIN_ARM = 42;

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

/** The explicit layout Auto would choose for a fresh tree. */
export function resolveAutoLayout(root: Node): "topdown" | "htree" {
  return autoLayoutProbe(root).key;
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

import { type Node, type NodeId } from "./term";

/** Top-down grid spacing. */
export const XS = 56;
export const YS = 64;
/** Radius added per depth level in the radial layout. */
export const RING = 84;

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
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A layout algorithm: term → node positions. */
export type LayoutFn = (root: Node) => Layout;

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
 * Root-centred radial layout (port of `treedraw.svg_radial`, §5.1 radial mode):
 * the root sits at the centre, depth maps to radius, the in-order leaves spread
 * evenly around the full circle, and each application takes the midpoint angle
 * of its two children — so the tree fans out from the centre.
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
 * H-tree layout: each application places its two children symmetrically offset from the node,
 * ALTERNATING the split axis by depth — even depth splits horizontally (fn left, arg right), odd
 * depth vertically (fn up, arg down). The arm length shrinks geometrically per level
 * (`HTREE_SHRINK`), so the term draws as a nested "square antenna" whose edges get progressively
 * shorter; a deep left spine becomes a shrinking staircase with the leaves fringing off it. Because
 * the shrink stays below 1/√2 sibling subtrees never overlap, so no subtree-spacing pass is needed.
 * The initial arm scales with the node count (bigger terms start with a longer arm). Root at (0, 0).
 */
/** The arm length (px) at which a node's glyph reaches full size; where arms are shorter (deep in the
 *  tree) the node shrinks WITH its arm, so a short arm never looks unnatural next to the glyph. */
export const HTREE_MIN_ARM = 42;
/** Floor on the per-node glyph scale so a very deep tip never vanishes entirely. */
export const HTREE_MIN_NODE_SCALE = 0.28;

export function layoutHTree(root: Node): Layout {
  // Modest initial arm, scaled by node count — the tree stays COMPACT (no giant span / zoom-out).
  // Deep tips are kept legible by shrinking the NODES to their arm (the `scale` map below), NOT by
  // inflating L0, so we make our peace with tiny-but-proportional deep detail.
  const L0 = 80 + 40 * Math.log2(countNodes(root) + 2);
  const pos = new Map<NodeId, Pos>();
  const scale = new Map<NodeId, number>();
  const place = (node: Node, x: number, y: number, depth: number): void => {
    if (pos.has(node.id)) return; // DAG (graph mode): position each shared node once — a no-op on a tree
    pos.set(node.id, { x, y });
    // Shrink a node toward its shortest adjacent arm so it never overwhelms the structure (the "grey
    // blob" on big/clamped trees): full-size while arms are long, scaling down once an arm drops
    // below a node's span. Only bites when L0 clamps — small trees keep full-size nodes.
    const childArm = L0 * HTREE_SHRINK ** depth;
    const minArm = node.kind === "app" ? childArm : L0 * HTREE_SHRINK ** Math.max(0, depth - 1); // leaf → its parent arm
    scale.set(node.id, Math.max(HTREE_MIN_NODE_SCALE, Math.min(1, minArm / HTREE_MIN_ARM)));
    if (node.kind !== "app") return;
    if (depth % 2 === 0) {
      place(node.fn, x - childArm, y, depth + 1); // fn → left
      place(node.arg, x + childArm, y, depth + 1); // arg → right
    } else {
      place(node.fn, x, y - childArm, depth + 1); // fn → up
      place(node.arg, x, y + childArm, depth + 1); // arg → down
    }
  };
  place(root, 0, 0, 0);
  return { pos, scale, ...bounds(pos) };
}

/** Past this top-down span (px) a tree is too wide/tall for a typical screen, so it gets
 *  the more compact radial layout instead. */
export const RADIAL_SPAN = 1400;

/** Auto layout: top-down for normal trees, radial once a tree gets too big to fit. */
export function layoutAuto(root: Node): Layout {
  const td = layoutTopDown(root);
  return td.width > RADIAL_SPAN || td.height > RADIAL_SPAN ? layoutRadial(root) : td;
}

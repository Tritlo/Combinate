/**
 * Shared layout vocabulary (functional core, ADR 0001): the position/layout types, the bounds
 * helper, and the small tree measures (node/leaf counts) every layout builds on. No DOM/Pixi/Three.
 * The individual layout algorithms live in sibling modules and are re-exported from `./index`.
 */
import { type Node, type NodeId } from "../term";

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
   *  changing max depth doesn't rescale the whole layout every step (see {@link import("./htree").layoutHTree}'s
   *  `frozen`); it also flags a layout as an H-tree (the incremental-reflow eligibility marker). */
  l0?: number;
  /** Edge-drawing hint. `"beam"` (Mobile) draws each parent as a horizontal balance beam with
   *  vertical drops to its children instead of straight parent→child lines; absent = straight edges. */
  edgeStyle?: "beam";
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A 2D layout algorithm: term → node positions. `frozen` carries the previous layout's frozen scale (the
 *  H-tree's L0) so a reducing tree keeps a stable arm length across steps; layouts that don't need it
 *  ignore it. */
export type LayoutFn = (root: Node, frozen?: { l0?: number }) => Layout;

/** A point in the 3D layout (root anchored at the origin). */
export interface Pos3 {
  x: number;
  y: number;
  z: number;
}

export interface Layout3 {
  pos: Map<NodeId, Pos3>;
  /** Distance from the origin to the farthest node — what the camera frames. */
  radius: number;
  /** Optional per-node size multiplier (H-tree: nodes shrink with their arm, exactly as in 2D, so
   *  a deep spine converges to a point instead of a blob of full-size spheres). Absent = all 1. */
  scale?: Map<NodeId, number>;
}

/** A 3D layout algorithm: term → node positions in 3-space. */
export type Layout3Fn = (root: Node) => Layout3;

/** Bounding box of a set of positions, packaged as the non-`pos` fields of a {@link Layout}. */
export function bounds(pos: Map<NodeId, Pos>): Pick<Layout, "width" | "height" | "minX" | "maxX" | "minY" | "maxY"> {
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

/** H-tree shrink factor. Held below 1/√2 ≈ 0.707, which keeps sibling subtrees from ever
 *  overlapping — a subtree's extent along the split axis is `e·s²/(1−s²)`, which is `< e` exactly
 *  when `s < 1/√2`, so the two children (placed `±e` apart) can't collide, for any tree shape. */
export const HTREE_SHRINK = 0.68;

/** The arm length (px) at which a node's glyph reaches full size; where arms are shorter (deep in the
 *  tree) the node shrinks WITH its arm, so a short arm never looks unnatural next to the glyph.
 *  Shared by the 2D and 3D H-trees (and the other tapering layouts) so they shrink in lockstep. */
export const HTREE_MIN_ARM = 42;

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

/** Per-node subtree leaf count (DAG-safe, memoised by id) — the split weight the botanical / mobile /
 *  hyperbolic layouts use to size a branch, balance a beam, or allocate an angular wedge. */
export function leafCounts(root: Node): Map<NodeId, number> {
  const m = new Map<NodeId, number>();
  const go = (n: Node): number => {
    const hit = m.get(n.id);
    if (hit !== undefined) return hit;
    const c = n.kind === "app" ? go(n.fn) + go(n.arg) : 1;
    m.set(n.id, c);
    return c;
  };
  go(root);
  return m;
}

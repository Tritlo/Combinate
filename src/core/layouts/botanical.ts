import { type Node, type NodeId } from "../term";
import { type Layout, type Pos, bounds, countNodes, HTREE_MIN_ARM, leafCounts } from "./types";

/** Sibling half-angle (radians) and per-level arm shrink for the botanical canopy. */
const ALPHA = 0.42;
const SHRINK = 0.76;

/**
 * Botanical (Pythagoras-canopy) layout: each application branches its two children off at ±`ALPHA`
 * from the parent's growth direction, the arm shrinking geometrically per level — so the term draws
 * as a self-similar growing tree (combinator expansion as a real branching plant). The root sits at
 * the base (0, 0) growing upward; the split is nudged by the leaf balance so the heavier subtree
 * opens a little wider. Nodes taper with their arm (the `scale` map), like the H-tree, so a deep
 * twig converges to a point instead of a blob. DAG-safe: a shared node is placed once, on first visit.
 */
export function layoutBotanical(root: Node): Layout {
  const leaf = leafCounts(root);
  const L0 = 120 + 30 * Math.log2(countNodes(root) + 2); // initial arm, scaled by node count
  const pos = new Map<NodeId, Pos>();
  const scale = new Map<NodeId, number>();
  // dir: 0 = straight up (screen y grows down, so a child is at y − cos·len).
  const place = (n: Node, x: number, y: number, dir: number, len: number): void => {
    if (pos.has(n.id)) return; // DAG: place a shared node once, on first visit
    pos.set(n.id, { x, y });
    scale.set(n.id, Math.min(1, len / HTREE_MIN_ARM));
    if (n.kind !== "app") return;
    const cl = len * SHRINK;
    const lf = leaf.get(n.fn.id)!;
    const rf = leaf.get(n.arg.id)!;
    const bias = (rf - lf) / (lf + rf); // >0 ⇒ heavier arg → open the fn side a touch wider
    const fd = dir + ALPHA * (1 - 0.4 * bias);
    const gd = dir - ALPHA * (1 + 0.4 * bias);
    place(n.fn, x + Math.sin(fd) * cl, y - Math.cos(fd) * cl, fd, cl);
    place(n.arg, x + Math.sin(gd) * cl, y - Math.cos(gd) * cl, gd, cl);
  };
  place(root, 0, 0, 0, L0);
  return { pos, scale, ...bounds(pos) };
}

import { type Node, type NodeId } from "../term";
import { type Layout, type Pos, bounds, countNodes, HTREE_MIN_ARM, leafCounts } from "./types";

/** Per-level beam shrink and the constant vertical drop between beam levels. */
const BEAM_SHRINK = 0.62;
const DROP = 56;

/**
 * Calder-mobile layout: every application is a horizontal balance beam that hangs its two children
 * below, the arm lengths chosen so the beam balances by subtree MASS (leaf count) — the heavier
 * child hangs closer to the pivot. Beams shrink per level so the sculpture nests. The view draws it
 * with {@link Layout.edgeStyle} `"beam"`: a horizontal bar at the parent's level with vertical drops
 * to each child, rather than straight parent→child lines. DAG-safe: a shared node is placed once.
 */
export function layoutMobile(root: Node): Layout {
  const leaf = leafCounts(root);
  const B0 = 200 + 60 * Math.log2(countNodes(root) + 2); // root beam half-span, scaled by node count
  const pos = new Map<NodeId, Pos>();
  const scale = new Map<NodeId, number>();
  const place = (n: Node, x: number, y: number, d: number): void => {
    if (pos.has(n.id)) return; // DAG: place a shared node once, on first visit
    pos.set(n.id, { x, y });
    const beam = B0 * BEAM_SHRINK ** d;
    scale.set(n.id, Math.min(1, Math.max(beam, DROP) / HTREE_MIN_ARM)); // taper deep nodes with their (shrinking) beam
    if (n.kind !== "app") return;
    const mL = leaf.get(n.fn.id)!;
    const mR = leaf.get(n.arg.id)!;
    const tot = mL + mR;
    const cy = y + DROP;
    place(n.fn, x - (beam * mR) / tot, cy, d + 1); // torque balance: heavier child ⇒ shorter arm
    place(n.arg, x + (beam * mL) / tot, cy, d + 1);
  };
  place(root, 0, 0, 0);
  return { pos, scale, edgeStyle: "beam", ...bounds(pos) };
}

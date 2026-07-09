import { type Node, type NodeId } from "../term";
import { type Layout, type Pos, bounds, countNodes, leafCounts } from "./types";

/** How fast depth pushes a node toward the disk rim (the hyperbolic radial rate). */
const RATE = 0.14;

/**
 * Hyperbolic (Poincaré-disk) layout: the root sits at the disk centre and depth maps to radius
 * through `r = tanh(RATE·depth)·R`, so successive levels crowd toward the boundary — a focus+context
 * view where the whole term fits in a finite disk (ADR 21's answer for big/deep trees). Each node
 * holds an angular WEDGE that its children split by leaf weight, exactly like the radial layout but
 * with the hyperbolic radial scale. Boundary nodes taper (the `scale` map). DAG-safe: a shared node
 * is placed once, on first visit. (Straight chords for edges; true geodesics are boundary-orthogonal
 * arcs — a later refinement.)
 */
export function layoutHyperbolic(root: Node): Layout {
  const leaf = leafCounts(root);
  const R = 360 + 30 * Math.log2(countNodes(root) + 2);
  const pos = new Map<NodeId, Pos>();
  const scale = new Map<NodeId, number>();
  const place = (n: Node, a0: number, a1: number, d: number): void => {
    if (pos.has(n.id)) return; // DAG: place a shared node once, on first visit
    const ang = (a0 + a1) / 2;
    const r = Math.tanh(d * RATE) * R;
    pos.set(n.id, { x: r * Math.cos(ang), y: r * Math.sin(ang) });
    scale.set(n.id, Math.max(0.18, 1 - r / R)); // nodes shrink toward the rim
    if (n.kind !== "app") return;
    const mid = a0 + (a1 - a0) * (leaf.get(n.fn.id)! / leaf.get(n.id)!); // split the wedge by leaf weight
    place(n.fn, a0, mid, d + 1);
    place(n.arg, mid, a1, d + 1);
  };
  place(root, 0, 2 * Math.PI, 0);
  return { pos, scale, ...bounds(pos) };
}

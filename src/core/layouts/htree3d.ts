/**
 * 3D H-tree: the volumetric generalization of {@link import("./htree").layoutHTree}. No DOM/Pixi/Three
 * (functional core, ADR 0001); the Three.js view renders the positions.
 */
import { type Node, type NodeId } from "../term";
import { type Layout3, type Pos3, countNodes, HTREE_MIN_ARM, HTREE_SHRINK } from "./types";

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];

/** The three split axes the 3D H-tree cycles through, one per depth level. */
const AXES3: V[] = [
  [1, 0, 0], // X — left / right
  [0, 1, 0], // Y — up / down
  [0, 0, 1], // Z — in / out
];

/**
 * 3D H-tree: each application places its two children symmetrically offset from the node, CYCLING the
 * split axis by depth — X (left/right), then Y (up/down), then Z (in/out), then back to X … The arm
 * shrinks geometrically per level (`HTREE_SHRINK` < 1/√2 ⇒ sibling subtrees never overlap), so the
 * term fills a shrinking cubic lattice. Initial arm scales with the node count. Root at the origin.
 *
 * Deep spines march outward along the (1,1,1) diagonal — DELIBERATE (ADR 26): the cycle is a
 * proper rotation about that diagonal, which is what keeps every subterm a true rotated copy of
 * its standalone layout. The inward-coiling alternative (signed ±axis 6-cycle) was tried and
 * rejected — in 3D it necessarily mirrors nested subterms (det −1 per level).
 */
export function layoutHTree3D(root: Node): Layout3 {
  const L0 = 70 + 34 * Math.log2(countNodes(root) + 2);
  const pos = new Map<NodeId, Pos3>();
  const nodeScale = new Map<NodeId, number>();
  let radius = 0;
  const place = (n: Node, p: V, depth: number): void => {
    if (pos.has(n.id)) return; // DAG: position a shared node once, on first visit
    pos.set(n.id, { x: p[0], y: p[1], z: p[2] });
    radius = Math.max(radius, Math.hypot(p[0], p[1], p[2]));
    // Same rule as the 2D H-tree: shrink a node with its shortest adjacent arm, no floor, so
    // node size tracks node spacing and deep spines taper instead of blobbing.
    const childArm = L0 * HTREE_SHRINK ** depth;
    const minArm = n.kind === "app" ? childArm : L0 * HTREE_SHRINK ** Math.max(0, depth - 1); // leaf → its parent arm
    nodeScale.set(n.id, Math.min(1, minArm / HTREE_MIN_ARM));
    if (n.kind !== "app") return;
    const off = vscale(AXES3[depth % 3]!, childArm);
    place(n.fn, add(p, vscale(off, -1)), depth + 1); // fn → negative along the axis
    place(n.arg, add(p, off), depth + 1); // arg → positive along the axis
  };
  place(root, [0, 0, 0], 0);
  return { pos, radius, scale: nodeScale };
}

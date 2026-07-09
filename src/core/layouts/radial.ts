import { type Node, type NodeId } from "../term";
import { type Layout, type Pos, bounds } from "./types";

/** Radius added per depth level in the radial layout. */
const RING = 84;

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

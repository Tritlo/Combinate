import { type Node, type NodeId } from "../term";
import { type Layout, type Pos, bounds } from "./types";

/** Top-down grid spacing. */
const XS = 56;
const YS = 64;

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

import { type Node, type NodeId } from "./term";

/** Horizontal leaf spacing and vertical depth spacing, from `treedraw.py`. */
export const XS = 56;
export const YS = 64;

export interface Pos {
  x: number;
  y: number;
}

export interface Layout {
  /** Node positions in local coordinates, with the root anchored at (0, 0). */
  pos: Map<NodeId, Pos>;
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Tidy top-down layout (port of `treedraw.annotate`, §5.1): leaves sit on a
 * regular in-order grid (indices 0, 1, 2, …) and each application hangs at the
 * midpoint of its two children; depth grows downward from the root.
 *
 * Positions are returned in local coordinates offset so the root is at (0, 0),
 * which lets the view position a whole tree by its root anchor and move it as a
 * rigid unit.
 */
export function layout(root: Node): Layout {
  const gridX = new Map<NodeId, number>();
  const depth = new Map<NodeId, number>();
  let leafIndex = 0;

  const walk = (n: Node, d: number): void => {
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
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const [id, gx] of gridX) {
    const x = (gx - rootGridX) * XS;
    const y = depth.get(id)! * YS;
    pos.set(id, { x, y });
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { pos, width: maxX - minX, height: maxY - minY, minX, maxX, minY, maxY };
}

import { type Node, type NodeId } from "./term";

/** Radius added per depth level (each ring out from the root). */
export const RING = 84;

export interface Pos {
  x: number;
  y: number;
}

export interface Layout {
  /** Node positions in local coordinates, with the root at the centre (0, 0). */
  pos: Map<NodeId, Pos>;
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Root-centred radial layout (port of `treedraw.svg_radial`, §5.1 radial mode):
 * the root sits at the centre, depth maps to radius, and the in-order leaves
 * spread evenly around the full circle; each application takes the midpoint
 * angle of its two children. The tree fans out from the centre.
 *
 * Positions are local with the root at (0, 0), so the view can anchor a whole
 * tree by its root and move it as a rigid unit.
 */
export function layout(root: Node): Layout {
  const depth = new Map<NodeId, number>();
  let leafCount = 0;

  const measure = (n: Node, d: number): void => {
    depth.set(n.id, d);
    if (n.kind === "app") {
      measure(n.fn, d + 1);
      measure(n.arg, d + 1);
    } else {
      leafCount++;
    }
  };
  measure(root, 0);

  // Assign angles post-order: leaves spread evenly in in-order, each app node
  // takes the midpoint angle of its two children.
  const angle = new Map<NodeId, number>();
  const total = Math.max(1, leafCount);
  let leafIndex = 0;
  const setAngle = (n: Node): void => {
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
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const [id, d] of depth) {
    const r = d * RING;
    const a = angle.get(id)!;
    const x = r * Math.cos(a);
    const y = r * Math.sin(a);
    pos.set(id, { x, y });
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { pos, width: maxX - minX, height: maxY - minY, minX, maxX, minY, maxY };
}

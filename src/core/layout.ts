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

/** Past this top-down span (px) a tree is too wide/tall for a typical screen, so it gets
 *  the more compact radial layout instead. */
export const RADIAL_SPAN = 1400;

/** Auto layout: top-down for normal trees, radial once a tree gets too big to fit. */
export function layoutAuto(root: Node): Layout {
  const td = layoutTopDown(root);
  return td.width > RADIAL_SPAN || td.height > RADIAL_SPAN ? layoutRadial(root) : td;
}

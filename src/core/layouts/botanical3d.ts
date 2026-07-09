/**
 * 3D botanical: the volumetric generalization of {@link import("./botanical").layoutBotanical}. Each
 * application forks its two children off the parent's growth direction by a fixed ±α, the arm shrinking
 * geometrically per level; the split PLANE is twisted by the golden angle each level so the branchings
 * fan into 3-space instead of staying coplanar (the same trick the packed sphere uses, ADR 20). The
 * heavier subtree tilts a little less (leaf-weighted bias), so a lopsided term still grows naturally.
 * Nodes taper with their arm (the shared `scale` map). No DOM/Pixi/Three (functional core, ADR 0001);
 * the Three.js view renders the positions. Root at the origin, growing up (+Y).
 */
import { type Node, type NodeId } from "../term";
import { type Layout3, type Pos3, countNodes, leafCounts, HTREE_MIN_ARM } from "./types";

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => {
  const m = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / m, a[1] / m, a[2] / m];
};
/** Rotate unit `dir` toward unit `side` (⟂ dir) by θ, staying in their plane. */
const tilt = (dir: V, side: V, theta: number): V => norm(add(vscale(dir, Math.cos(theta)), vscale(side, Math.sin(theta))));
/** Re-orthogonalise `side` against the new `dir`, then spin it around `dir` by `angle` — a fresh split
 *  plane for the child (Rodrigues). Guards `side` ∥ `dir` by picking any perpendicular. */
const twist = (side: V, dir: V, angle: number): V => {
  const proj = add(side, vscale(dir, -dot(side, dir)));
  let s = proj;
  if (Math.hypot(proj[0], proj[1], proj[2]) < 1e-6) s = cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  s = norm(s);
  return norm(add(vscale(s, Math.cos(angle)), vscale(cross(dir, s), Math.sin(angle))));
};

const ALPHA = 0.42; // branch half-angle off the growth direction (radians) — matches the 2D botanical
const SHRINK = 0.76; // arm length ratio per level
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ≈137.5° — twist the split plane each level → 3D fill

/** Lay out a term as a 3D bush: positions in 3-space, root at the origin. */
export function layoutBotanical3D(root: Node): Layout3 {
  const leaf = leafCounts(root);
  const L0 = 90 + 26 * Math.log2(countNodes(root) + 2);
  const pos = new Map<NodeId, Pos3>();
  const scale = new Map<NodeId, number>();
  let radius = 0;
  const place = (n: Node, p: V, dir: V, side: V, len: number): void => {
    if (pos.has(n.id)) return; // DAG: position a shared node once, on first visit
    pos.set(n.id, { x: p[0], y: p[1], z: p[2] });
    radius = Math.max(radius, Math.hypot(p[0], p[1], p[2]));
    scale.set(n.id, Math.min(1, len / HTREE_MIN_ARM));
    if (n.kind !== "app") return;
    const cl = len * SHRINK;
    const lf = leaf.get(n.fn.id)!;
    const rf = leaf.get(n.arg.id)!;
    const bias = (rf - lf) / (lf + rf); // heavier arg → +bias → arg tilts more, fn less
    const dirF = tilt(dir, side, -ALPHA * (1 - 0.4 * bias));
    const dirG = tilt(dir, side, ALPHA * (1 + 0.4 * bias));
    place(n.fn, add(p, vscale(dirF, cl)), dirF, twist(side, dirF, GOLDEN), cl);
    place(n.arg, add(p, vscale(dirG, cl)), dirG, twist(side, dirG, GOLDEN), cl);
  };
  place(root, [0, 0, 0], [0, 1, 0], [1, 0, 0], L0);
  return { pos, radius, scale };
}

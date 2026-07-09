/**
 * The 3D "packed sphere" layout (ADR 20) — a pure 3D generalization of {@link import("./radial").layoutRadial}.
 * No DOM/Pixi/Three here (functional core, ADR 0001): term → node positions in 3-space, which
 * the Three.js view renders.
 *
 * It's a binary spherical cone-tree (Robertson et al. 1991, adapted): the root sits at the
 * center, depth maps to radius (concentric shells, exactly like the 2D radial), and each
 * application fans its two children — `fn` and `arg` — into opposite lobes tilted off the
 * parent's growth direction. The split is leaf-weighted (the heavier subtree stays nearer the
 * parent's axis, the lighter one is pushed out), and the splitting plane is rotated by the
 * golden angle at every level so successive branchings fill the ball in 3D instead of staying
 * coplanar (which would just reproduce the flat radial disk). DAG sharing is handled exactly as
 * the 2D layouts: a shared node is placed once, on first visit.
 */
import { type Node, type NodeId } from "../term";
import { type Layout3, type Pos3 } from "./types";

/** Radius added per depth level (the shell spacing). */
const RING3 = 92;
const SPREAD0 = 1.0; // root fan half-angle (radians, ~57°)
const SPREAD_DECAY = 0.5; // how fast the fan narrows with depth (so deep subtrees don't overlap)
const MAX_TILT = 1.2; // ~69° — cap a child's tilt well under 90° so a lopsided split never folds a child backward (and keeps the split axis from collapsing onto the growth axis)
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ≈137.5° — twist the split plane each level → 3D fill

// ---- tiny vec3 helpers (kept local; the core has no math dep) ----
type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => {
  const m = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / m, a[1] / m, a[2] / m];
};

/** Rotate unit `dir` toward unit `side` (⟂ dir) by angle θ, staying in their plane. */
const tilt = (dir: V, side: V, theta: number): V => norm(add(vscale(dir, Math.cos(theta)), vscale(side, Math.sin(theta))));

/** Re-orthogonalise `side` against the new `dir`, then spin it around `dir` by `angle` — gives
 *  the child a fresh split axis in a rotated plane (Rodrigues; the parallel term drops out
 *  after re-orthogonalisation). Guards the degenerate case where `side` came out ∥ `dir`
 *  (would collapse the frame and ray-flatten the subtree) by picking any perpendicular. */
const twist = (side: V, dir: V, angle: number): V => {
  const proj = add(side, vscale(dir, -dot(side, dir))); // component of side ⟂ dir
  let s = proj;
  if (Math.hypot(proj[0], proj[1], proj[2]) < 1e-6) {
    s = cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]); // any vector not ∥ dir
  }
  s = norm(s);
  return norm(add(vscale(s, Math.cos(angle)), vscale(cross(dir, s), Math.sin(angle))));
};

/** Lay out a term as a packed sphere: positions in 3-space, root at the origin. */
export function layoutSphere(root: Node): Layout3 {
  // subtree leaf counts (the split weight), memoised — counts each shared node once (DAG).
  const weight = new Map<NodeId, number>();
  const countLeaves = (n: Node): number => {
    const w = weight.get(n.id);
    if (w !== undefined) return w;
    const c = n.kind === "app" ? countLeaves(n.fn) + countLeaves(n.arg) : 1;
    weight.set(n.id, c);
    return c;
  };
  countLeaves(root);

  const pos = new Map<NodeId, Pos3>();
  let radius = 0;
  // place a node at `dir × depth·RING`, then fan its children into tilted, twisted lobes.
  const place = (n: Node, depth: number, dir: V, side: V): void => {
    if (pos.has(n.id)) return; // DAG: position a shared node once, on first visit
    const r = depth * RING3;
    pos.set(n.id, { x: dir[0] * r, y: dir[1] * r, z: dir[2] * r });
    radius = Math.max(radius, r);
    if (n.kind !== "app") return;
    const wL = weight.get(n.fn.id)!;
    const wR = weight.get(n.arg.id)!;
    const wT = wL + wR;
    const spread = SPREAD0 / (1 + SPREAD_DECAY * depth);
    // weighted split: a balanced (wL=wR) node fans symmetrically to ±spread; otherwise the
    // heavier child tilts less (keeps the central cone), the lighter one is pushed further out.
    // Capped at MAX_TILT so a very lopsided split can't fold a child backward / collapse the frame.
    const tiltL = Math.min(MAX_TILT, (2 * spread * wR) / wT);
    const tiltR = Math.min(MAX_TILT, (2 * spread * wL) / wT);
    const dirL = tilt(dir, side, -tiltL);
    const dirR = tilt(dir, side, tiltR);
    place(n.fn, depth + 1, dirL, twist(side, dirL, GOLDEN));
    place(n.arg, depth + 1, dirR, twist(side, dirR, GOLDEN));
  };
  place(root, 0, [0, 0, 1], [1, 0, 0]);
  return { pos, radius };
}

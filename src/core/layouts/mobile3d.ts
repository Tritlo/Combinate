/**
 * 3D mobile: the volumetric generalization of {@link import("./mobile").layoutMobile} — a Calder mobile
 * hanging in space. Each application is a horizontal balance beam at its own level; its two children
 * hang a fixed DROP below, offset along the beam by subtree mass (the heavier child nearer the pivot,
 * shorter moment arm). The beam DIRECTION twists azimuthally by the golden angle each level so the
 * beams don't all lie in one plane — the beams stay horizontal (as under gravity), only their heading
 * rotates. The beam span shrinks geometrically per level. Nodes taper with the beam (the shared
 * `scale` map). No DOM/Pixi/Three (functional core, ADR 0001). Root at the origin; the mobile hangs
 * below it (−Y). The 3D view draws straight parent→child edges — the diagonal drop reads as the string.
 */
import { type Node, type NodeId } from "../term";
import { type Layout3, type Pos3, countNodes, leafCounts, HTREE_MIN_ARM } from "./types";

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
/** Rotate a horizontal vector about the vertical (Y) axis by `a` — keeps the beam horizontal. */
const rotY = (v: V, a: number): V => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];

const BEAM_SHRINK = 0.62; // beam span ratio per level
const DROP = 56; // vertical drop from a beam to its children
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ≈137.5° — twist the beam heading each level → 3D mobile

/** Lay out a term as a 3D Calder mobile: positions in 3-space, root at the origin. */
export function layoutMobile3D(root: Node): Layout3 {
  const leaf = leafCounts(root);
  const B0 = 200 + 60 * Math.log2(countNodes(root) + 2);
  const pos = new Map<NodeId, Pos3>();
  const scale = new Map<NodeId, number>();
  let radius = 0;
  const place = (n: Node, p: V, bdir: V, d: number): void => {
    if (pos.has(n.id)) return; // DAG: position a shared node once, on first visit
    pos.set(n.id, { x: p[0], y: p[1], z: p[2] });
    radius = Math.max(radius, Math.hypot(p[0], p[1], p[2]));
    const beam = B0 * BEAM_SHRINK ** d;
    scale.set(n.id, Math.min(1, Math.max(beam, DROP) / HTREE_MIN_ARM));
    if (n.kind !== "app") return;
    const lf = leaf.get(n.fn.id)!;
    const rf = leaf.get(n.arg.id)!;
    const tot = lf + rf;
    const drop: V = [p[0], p[1] - DROP, p[2]]; // the children's level
    const nb = rotY(bdir, GOLDEN); // next level's beam heading
    place(n.fn, add(drop, vscale(bdir, -(beam * rf) / tot)), nb, d + 1); // fn hangs to −beam, moment ∝ arg mass
    place(n.arg, add(drop, vscale(bdir, (beam * lf) / tot)), nb, d + 1); // arg hangs to +beam, moment ∝ fn mass
  };
  place(root, [0, 0, 0], [1, 0, 0], 0);
  return { pos, radius, scale };
}

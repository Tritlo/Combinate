/**
 * The 3D "packed sphere" view (ADR 20) — a lazy Three.js renderer for the focused term. It
 * renders a 3D layout (layoutHTree3D / layoutSphere) as instanced spheres + coloured edges into its OWN off-DOM
 * canvas; the owner draws that canvas as a Pixi texture sprite so the Pixi HUD composites on
 * top (compositing "A", Magi-consensus — no separate overlay covering the HUD). Re-renders on
 * demand (term / theme / resize / orbit) and animates reduction steps via {@link animateTo} +
 * {@link advanceMorph} (plan 06: survivors glide, new nodes scale in, dropped scale out — the 3D
 * echo of TreeView.animateTo), each render firing {@link onFrame} so the owner re-uploads. The camera is a small
 * orbit driven by the host's Pixi pointer events ({@link orbit} / {@link zoomBy}) — no
 * OrbitControls, since the canvas isn't in the DOM. Three is dynamic-imported on first entry
 * (the lazy-heavy pattern); WebGL only — WebGPU was dropped as not worth the maintenance/
 * portability cost for this static scene, so headless/CI stays on WebGL.
 */
import type * as T from "three";
import { type Node } from "../core/term";
import { layoutHTree3D, type Layout3Fn } from "../core/layout3d";
import { theme, combinatorColor, edgeTierColor } from "./theme";
import { easeInOut } from "./anim";

/** Beyond this node count the static scene gets heavy to build/draw — the app preflights this
 *  (iteratively, deep-safe) before entering 3D. */
export const NODE_CAP = 20_000;
const SPHERE_SEGMENTS = 12; // low-poly node sphere (instanced thousands of times)
const ROT = 0.008; // orbit radians per pixel of drag
const PAN = 0.0016; // pan world-units per pixel, scaled by orbit radius (consistent at any zoom)
const POLAR_MIN = 0.08;
const POLAR_MAX = Math.PI - 0.08;
const DPR_CAP = 1.5; // cap the 3D canvas DPR — the texture re-upload per orbit step is the cost, not the draw
// Above this combined node count the per-step morph jump-cuts (snap) instead of tweening. Raised
// from 600 once the reduction loop paces itself to the morph (3D mode hides the 2D view, so the
// focused tree only advances when its morph completes — see ReductionController). Measured: the
// per-frame CPU morph cost (matrices + edge rewrite + dash recompute) stays under ~5 ms up to ~5–6k
// nodes, which covers the ballooned middle of small Scott arithmetic (e.g. (+) 1 1 peaks ~1.6k,
// (+) 2 2 ~5.2k). Bigger blow-ups still snap (and anything past NODE_CAP exits to 2D).
const MORPH_CAP = 6000;
// Clamp the per-frame morph advance: a single huge tick (a frame hitch, a backgrounded tab, a slow
// machine) must not jump the tween straight to its end — that reads as the snap we're removing. Above
// ~20 fps this never bites (deltaMS < 50); below it the morph plays in slight slow-motion instead of
// teleporting. The reduction loop paces to the morph, so a slower morph just means a slower step.
const MORPH_MAX_DT = 50;
const EDGE_OPACITY = 0.85; // edges more opaque than before so the fn/arg cue reads (ADR 20 follow-up)
const DASH_SIZE = 16; // arg (right) edges are DASHED, fn (left) solid — the 3D echo of the 2D solid/dashed legend
const GAP_SIZE = 11; // (layout shells are ~92 units apart, so ~3 dashes per edge)
const FRAME_MARGIN = 1.6; // camera pull-back factor when framing (smaller = the ball fills more of the view)
const FRAME_FLOOR = 120; // min framing radius (keeps a tiny tree from clipping)

type Pos3 = { x: number; y: number; z: number };
// One node's tween across a reduction step: instance slot, from→to position, base radius, scale 0/1.
interface MorphAnim {
  i: number;
  id: number;
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
  baseR: number;
  sFrom: number; // 1 survivor/exit start, 0 enter start
  sTo: number; // 1 survivor/enter end, 0 exit end
}
// An in-flight reduction-step morph: its own InstancedMesh + edge buffer, advanced frame by frame.
// fn (solid) + arg (dashed) edges as separate batches so left/right reads; positions rewritten each frame.
interface EdgeBatch {
  seg: T.LineSegments;
  pos: Float32Array;
  pairs: Array<[number, number]>;
  dashed: boolean;
}
interface Morph {
  mesh: T.InstancedMesh;
  anims: MorphAnim[];
  edges: EdgeBatch[];
  curPos: Map<number, Pos3>;
  node: Node; // the settled term to snap to when the tween ends
  newPos: Map<number, Pos3>;
  elapsed: number;
  duration: number;
}

// Lazily-loaded Three module (WebGL — see ADR 20; WebGPU was dropped as not worth the
// maintenance/portability cost for this static scene).
let THREE: typeof T | null = null;
async function loadThree(): Promise<void> {
  if (THREE) return;
  THREE = await import("three");
}
/** Warm the Three chunk in the background at boot, so the first 3D entry is instant. Best-effort. */
export function preloadSphere3D(): Promise<void> {
  return loadThree().catch(() => {});
}

// Per-kind node radius + colour (a 3D echo of tree.ts's visSpec, reusing the theme).
function nodeStyle(n: Node, depth: number): { radius: number; color: number } {
  switch (n.kind) {
    case "iota":
      return { radius: 9, color: theme.mutedDot }; // grey sphere — ι is the bare generator (no longer gold)
    case "comb":
      return { radius: 18, color: combinatorColor(n.sym) };
    case "free":
      return { radius: 15, color: theme.mutedDot };
    default:
      return { radius: 7, color: depth > 0 ? edgeTierColor(depth - 1) : theme.text }; // app junction takes its incoming-edge tier (root: ink)
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export class Sphere3D {
  /** The off-DOM render target — the owner wraps this in a Pixi texture. */
  readonly canvas = document.createElement("canvas");
  /** Fired after every render so the owner can re-upload the canvas into its Pixi texture. */
  onFrame: (() => void) | null = null;
  private renderer: T.WebGLRenderer | null = null;
  private scene: T.Scene | null = null;
  private camera: T.PerspectiveCamera | null = null;
  private content: T.Group | null = null;
  private current: Node | null = null;
  private on = false;
  private az = 0.6; // orbit azimuth
  private pol = 1.05; // orbit polar (from +Y)
  private rad = 800; // orbit radius
  private target = { x: 0, y: 0, z: 0 }; // orbit look-at point (panned by the left drag)
  private lastRadius = 120; // model radius from the last layout (for recenter)
  private w = 1;
  private h = 1;
  lastCount = 0;
  lastCapped = false;
  lastBuildMs = 0;
  lastDrawMs = 0; // wall-clock of the last orbit render + texture re-upload (the per-frame cost)
  lastMorphFrameMs = 0; // CPU cost of the last advanceMorph frame (matrices + edge rewrite + dash recompute), excl. the GPU draw — the metric the MORPH_CAP is tuned against
  drawCount = 0; // renders since boot (dev seam: confirms the morph render loop actually advanced)
  private layout3: Layout3Fn = layoutHTree3D; // the active 3D layout (cubic H-tree by default; sphere via setLayout3 for radial)
  private lastPos = new Map<number, Pos3>(); // currently-displayed node positions — the next morph's `from`
  private lastNodes = new Map<number, Node>(); // currently-displayed nodes (to colour/size dropped nodes)
  private lastDepth = new Map<number, number>(); // currently-displayed node depths (app nodes take their incoming-edge tier)
  private morph: Morph | null = null;

  /** Current orbit azimuth (for the dev seam / E2E — confirms rotation). */
  get azimuth(): number {
    return this.az;
  }
  /** Σ of the pan look-at target (for E2E — confirms pan vs orbit don't cross-fire). */
  get panSum(): number {
    return this.target.x + this.target.y + this.target.z;
  }

  get active(): boolean {
    return this.on;
  }

  /** Enter 3D and render `node` at canvas size `w×h` (lazy-loads Three on first call). Rejects
   *  if Three fails to load / WebGL unavailable — the caller backs out + toasts. */
  async show(node: Node | null, w: number, h: number): Promise<void> {
    this.on = true;
    this.w = w;
    this.h = h;
    try {
      await loadThree();
      this.ensureScene();
    } catch (e) {
      this.on = false;
      throw e;
    }
    this.update(node);
  }

  hide(): void {
    this.on = false;
    this.morph = null; // exiting mid-morph: drop it so the host's ticker can't advance a stale/disposed group
  }

  private ensureScene(): void {
    if (this.scene || !THREE) return;
    const three = THREE;
    this.renderer = new three.WebGLRenderer({ canvas: this.canvas, antialias: true }); // `new` can throw if WebGL is unavailable — caught by show()
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
    this.scene = new three.Scene();
    this.camera = new three.PerspectiveCamera(50, 1, 0.1, 500_000);
    // No lights: nodes use an unlit MeshBasicMaterial so per-combinator hues read flat + vivid
    // (a 3D echo of the 2D palette) instead of being darkened by shading.
    this.resize(this.w, this.h);
  }

  /** Render `node` (rebuilds the scene content). Frames the camera unless `keepCamera` (a same-term
   *  repaint — theme/colour — must not reset the user's orbit/pan). Cheap to call again. */
  update(node: Node | null, keepCamera = false): void {
    this.current = node;
    this.morph = null; // an external rebuild (theme / Expand / discovery / settle) supersedes any in-flight morph; its group is disposed below
    if (!this.on || !THREE || !this.scene) return;
    const three = THREE;
    this.scene.background = new three.Color(theme.bg);
    if (this.content) {
      this.disposeGroup(this.content);
      this.scene.remove(this.content);
      this.content = null;
    }
    if (!node) {
      this.lastCount = 0;
      this.lastCapped = false;
      this.lastPos = new Map();
      this.lastNodes = new Map();
      this.lastDepth = new Map();
      this.draw();
      return;
    }
    const t0 = performance.now();
    const { pos, radius } = this.layout3(node);
    this.lastCount = pos.size;
    this.lastCapped = pos.size > NODE_CAP;
    if (this.lastCapped) {
      this.lastPos = new Map(); // can't morph from a tree we never laid out — the next step snaps
      this.lastNodes = new Map();
      this.lastDepth = new Map();
      this.draw();
      return; // too big to build a static scene — blank (the toast lives in app.ts)
    }
    const group = new three.Group();
    group.add(this.buildNodes(three, node, pos));
    const edges = this.buildEdges(three, node, pos);
    if (edges) group.add(edges);
    this.scene.add(group);
    this.content = group;
    this.lastPos = pos;
    this.lastNodes = this.collect(node);
    this.lastDepth = this.depthMap(node);
    this.lastRadius = radius;
    if (keepCamera) this.place();
    else this.frame(radius);
    this.draw();
    this.lastBuildMs = performance.now() - t0;
  }

  // id → Node for the displayed tree (to style dropped nodes + walk new-tree edges).
  private collect(root: Node): Map<number, Node> {
    const m = new Map<number, Node>();
    const walk = (n: Node): void => {
      if (m.has(n.id)) return;
      m.set(n.id, n);
      if (n.kind === "app") {
        walk(n.fn);
        walk(n.arg);
      }
    };
    walk(root);
    return m;
  }

  // id → depth (first visit), so an app node can take its incoming-edge tier (edgeTierColor(depth-1)).
  private depthMap(root: Node): Map<number, number> {
    const m = new Map<number, number>();
    const walk = (n: Node, d: number): void => {
      if (m.has(n.id)) return;
      m.set(n.id, d);
      if (n.kind === "app") {
        walk(n.fn, d + 1);
        walk(n.arg, d + 1);
      }
    };
    walk(root, 0);
    return m;
  }

  /** Animate one reduction step (plan 06): persisting nodes (same id) glide old→new, new nodes
   *  scale in, dropped nodes scale out. The 3D analog of TreeView.animateTo. Frame-stepped by the
   *  host via {@link advanceMorph}; snaps (jump-cut) above MORPH_CAP or with nothing to glide from. */
  animateTo(node: Node, durationMS: number): void {
    if (!this.on || !THREE || !this.scene) return;
    const three = THREE;
    if (this.morph) {
      // settle any in-flight morph to its end so the next one glides from there
      this.lastPos = this.morph.newPos;
      this.lastNodes = this.collect(this.morph.node);
      this.morph = null;
    }
    const { pos: newPos } = this.layout3(node);
    const ids = new Set<number>([...this.lastPos.keys(), ...newPos.keys()]);
    if (this.lastPos.size === 0 || ids.size > MORPH_CAP) {
      this.update(node, true); // nothing to glide from, or too big to tween — snap to the steady scene
      return;
    }
    const newNodes = this.collect(node);
    const newDepth = this.depthMap(node);
    const mesh = new three.InstancedMesh(new three.SphereGeometry(1, SPHERE_SEGMENTS, SPHERE_SEGMENTS), new three.MeshBasicMaterial(), ids.size);
    const anims: MorphAnim[] = [];
    const col = new three.Color();
    let i = 0;
    for (const id of ids) {
      const np = newPos.get(id);
      const op = this.lastPos.get(id);
      const depth = newDepth.get(id) ?? this.lastDepth.get(id) ?? 0;
      const { radius: baseR, color } = nodeStyle(newNodes.get(id) ?? this.lastNodes.get(id)!, depth);
      if (np && op) anims.push({ i, id, fx: op.x, fy: op.y, fz: op.z, tx: np.x, ty: np.y, tz: np.z, baseR, sFrom: 1, sTo: 1 });
      else if (np) anims.push({ i, id, fx: np.x, fy: np.y, fz: np.z, tx: np.x, ty: np.y, tz: np.z, baseR, sFrom: 0, sTo: 1 });
      else anims.push({ i, id, fx: op!.x, fy: op!.y, fz: op!.z, tx: op!.x, ty: op!.y, tz: op!.z, baseR, sFrom: 1, sTo: 0 });
      mesh.setColorAt(i, col.set(color));
      i++;
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // new-tree edges, fn (left) + arg (right) as separate batches (endpoints all in `ids`, so curPos
    // has them); positions rewritten each frame. arg is dashed so left/right reads while it morphs.
    const fnPairs: Array<[number, number]> = [];
    const fnCols: number[] = [];
    const argPairs: Array<[number, number]> = [];
    const argCols: number[] = [];
    const ecol = new three.Color();
    const seen = new Set<number>();
    const ewalk = (m: Node, depth: number): void => {
      if (seen.has(m.id) || m.kind !== "app") return;
      seen.add(m.id);
      ecol.set(edgeTierColor(depth)); // depth tier (red/black) — fixed for the morph; only positions move
      fnPairs.push([m.id, m.fn.id]);
      fnCols.push(ecol.r, ecol.g, ecol.b, ecol.r, ecol.g, ecol.b);
      argPairs.push([m.id, m.arg.id]);
      argCols.push(ecol.r, ecol.g, ecol.b, ecol.r, ecol.g, ecol.b);
      ewalk(m.fn, depth + 1);
      ewalk(m.arg, depth + 1);
    };
    ewalk(node, 0);
    const edges: EdgeBatch[] = [];
    const batch = (pairs: Array<[number, number]>, cols: number[], dashed: boolean): void => {
      if (!pairs.length) return;
      const pos = new Float32Array(pairs.length * 6);
      const geo = new three.BufferGeometry();
      geo.setAttribute("position", new three.BufferAttribute(pos, 3)); // wraps `pos` (no copy) so per-frame writes land
      geo.setAttribute("color", new three.Float32BufferAttribute(cols, 3));
      edges.push({ seg: this.edgeLine(three, geo, dashed), pos, pairs, dashed });
    };
    batch(fnPairs, fnCols, false);
    batch(argPairs, argCols, true);
    const group = new three.Group();
    group.add(mesh);
    for (const e of edges) group.add(e.seg);
    if (this.content) {
      this.disposeGroup(this.content);
      this.scene.remove(this.content);
    }
    this.scene.add(group);
    this.content = group;
    this.place(); // a same-term morph — keep the user's orbit/zoom
    this.morph = { mesh, anims, edges, curPos: new Map(), node, newPos, elapsed: 0, duration: Math.max(16, durationMS) };
    this.advanceMorph(0); // paint frame 0
  }

  /** Advance the active morph by `dtMS` (host's Pixi ticker); snaps to the steady scene at the end.
   *  No-op when idle. Returns true while a morph is still running. */
  advanceMorph(dtMS: number): boolean {
    const m = this.morph;
    if (!m || !THREE) return false;
    const three = THREE;
    const t0 = performance.now();
    m.elapsed += Math.min(dtMS, MORPH_MAX_DT); // clamp so a frame hitch can't snap the tween to its end
    const t = Math.min(1, m.elapsed / m.duration);
    const e = easeInOut(t);
    const M = new three.Matrix4();
    m.curPos.clear();
    for (const a of m.anims) {
      const x = a.fx + (a.tx - a.fx) * e;
      const y = a.fy + (a.ty - a.fy) * e;
      const z = a.fz + (a.tz - a.fz) * e;
      const s = a.baseR * (a.sFrom + (a.sTo - a.sFrom) * e);
      M.makeScale(s, s, s);
      M.setPosition(x, y, z);
      m.mesh.setMatrixAt(a.i, M);
      m.curPos.set(a.id, { x, y, z });
    }
    m.mesh.instanceMatrix.needsUpdate = true;
    for (const e of m.edges) {
      for (let k = 0; k < e.pairs.length; k++) {
        const pa = m.curPos.get(e.pairs[k][0])!;
        const pb = m.curPos.get(e.pairs[k][1])!;
        const o = k * 6;
        e.pos[o] = pa.x;
        e.pos[o + 1] = pa.y;
        e.pos[o + 2] = pa.z;
        e.pos[o + 3] = pb.x;
        e.pos[o + 4] = pb.y;
        e.pos[o + 5] = pb.z;
      }
      e.seg.geometry.getAttribute("position").needsUpdate = true;
      if (e.dashed) e.seg.computeLineDistances(); // endpoints moved → recompute the dash pattern
    }
    this.lastMorphFrameMs = performance.now() - t0; // CPU morph work this frame, excl. the GPU draw below
    this.draw();
    if (t >= 1) {
      this.morph = null;
      this.update(m.node, true); // settle to the steady InstancedMesh + record lastPos for the next step
      return false;
    }
    return true;
  }

  /** Whether a reduction-step morph is currently playing (the host drives {@link advanceMorph}). */
  get morphing(): boolean {
    return this.morph !== null;
  }

  /** Swap the 3D layout algorithm (sphere ↔ H-tree). Drops any in-flight morph and the last scene so
   *  the next {@link update} lays the tree out fresh in the new layout (no cross-layout tween). */
  setLayout3(fn: Layout3Fn): void {
    if (this.layout3 === fn) return;
    this.layout3 = fn;
    this.morph = null;
    this.lastPos = new Map();
    this.lastNodes = new Map();
    this.lastDepth = new Map();
  }

  /** Snap an in-flight morph to its settled term — the host calls this when the 2D reducer is paused
   *  (it stop-animates the tree), so 2D and 3D don't desync. No-op if idle. */
  settleMorph(): void {
    const m = this.morph;
    if (!m) return;
    this.morph = null;
    this.update(m.node, true);
  }

  /** Dev seam (E2E): the morph's phase + counts so a test can assert the MATH ran (survivors glide,
   *  enter 0→1, exit 1→0) without trusting headless pixels. `drawCount` proves the loop advanced. */
  debugMorph(): { active: boolean; t: number; drawCount: number; survivors: number; entering: number; exiting: number; enterScale: number; exitScale: number } {
    const m = this.morph;
    if (!m) return { active: false, t: 1, drawCount: this.drawCount, survivors: 0, entering: 0, exiting: 0, enterScale: 0, exitScale: 0 };
    const t = Math.min(1, m.elapsed / m.duration);
    const e = easeInOut(t);
    let survivors = 0;
    let entering = 0;
    let exiting = 0;
    for (const a of m.anims) {
      if (a.sFrom === 1 && a.sTo === 1) survivors++;
      else if (a.sTo === 1) entering++;
      else exiting++;
    }
    return { active: true, t, drawCount: this.drawCount, survivors, entering, exiting, enterScale: e, exitScale: 1 - e };
  }

  // One instanced sphere per node, positioned + scaled by kind, tinted per kind.
  private buildNodes(three: typeof T, root: Node, pos: Map<number, { x: number; y: number; z: number }>): T.InstancedMesh {
    const geo = new three.SphereGeometry(1, SPHERE_SEGMENTS, SPHERE_SEGMENTS);
    const mat = new three.MeshBasicMaterial(); // unlit: per-instance colours read at full saturation, matching the 2D palette
    const mesh = new three.InstancedMesh(geo, mat, pos.size);
    const m = new three.Matrix4();
    const col = new three.Color();
    let i = 0;
    const seen = new Set<number>();
    const walk = (n: Node, depth: number): void => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      const p = pos.get(n.id)!;
      const { radius, color } = nodeStyle(n, depth);
      m.makeScale(radius, radius, radius);
      m.setPosition(p.x, p.y, p.z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, col.set(color));
      i++;
      if (n.kind === "app") {
        walk(n.fn, depth + 1);
        walk(n.arg, depth + 1);
      }
    };
    walk(root, 0);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }

  // A LineSegments for one edge batch: solid (fn) or dashed (arg). Per-vertex colour carries the
  // red/black depth TIER (so parent vs child reads); the style carries left vs right.
  private edgeLine(three: typeof T, geo: T.BufferGeometry, dashed: boolean): T.LineSegments {
    const mat = dashed
      ? new three.LineDashedMaterial({ vertexColors: true, transparent: true, opacity: EDGE_OPACITY, dashSize: DASH_SIZE, gapSize: GAP_SIZE })
      : new three.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: EDGE_OPACITY });
    const seg = new three.LineSegments(geo, mat);
    if (dashed) seg.computeLineDistances();
    return seg;
  }

  // Parent→child edges as two batches: fn (left) SOLID, arg (right) DASHED; each vertex coloured by
  // the parent's depth TIER (red/black) so a node's parent-edge is the opposite colour of its
  // child-edges. Style = left/right, colour = depth — the 3D echo of the 2D legend.
  private buildEdges(three: typeof T, root: Node, pos: Map<number, { x: number; y: number; z: number }>): T.Object3D | null {
    const fn = { verts: [] as number[], cols: [] as number[] };
    const arg = { verts: [] as number[], cols: [] as number[] };
    const col = new three.Color();
    const seen = new Set<number>();
    const edge = (b: { verts: number[]; cols: number[] }, a: Node, c: Node, depth: number): void => {
      const pa = pos.get(a.id)!;
      const pc = pos.get(c.id)!;
      b.verts.push(pa.x, pa.y, pa.z, pc.x, pc.y, pc.z);
      col.set(edgeTierColor(depth));
      b.cols.push(col.r, col.g, col.b, col.r, col.g, col.b);
    };
    const walk = (n: Node, depth: number): void => {
      if (seen.has(n.id) || n.kind !== "app") return;
      seen.add(n.id);
      edge(fn, n, n.fn, depth);
      edge(arg, n, n.arg, depth);
      walk(n.fn, depth + 1);
      walk(n.arg, depth + 1);
    };
    walk(root, 0);
    if (!fn.verts.length && !arg.verts.length) return null;
    const group = new three.Group();
    const add = (b: { verts: number[]; cols: number[] }, dashed: boolean): void => {
      if (!b.verts.length) return;
      const geo = new three.BufferGeometry();
      geo.setAttribute("position", new three.Float32BufferAttribute(b.verts, 3));
      geo.setAttribute("color", new three.Float32BufferAttribute(b.cols, 3));
      group.add(this.edgeLine(three, geo, dashed));
    };
    add(fn, false);
    add(arg, true);
    return group;
  }

  // ---- orbit camera (driven by the host's Pixi pointer events; no OrbitControls) ----
  /** Rotate the camera by a pointer drag (pixels). */
  orbit(dx: number, dy: number): void {
    this.az -= dx * ROT;
    this.pol = clamp(this.pol - dy * ROT, POLAR_MIN, POLAR_MAX);
    this.place();
    this.draw();
  }
  /** Zoom by a factor (<1 in, >1 out) — the wheel / pinch. */
  zoomBy(factor: number): void {
    this.rad = clamp(this.rad * factor, 1, 5_000_000);
    this.place();
    this.draw();
  }
  /** Pan the look-at point in the camera's screen plane (left drag / right stick / one finger). */
  pan(dx: number, dy: number): void {
    if (!this.camera || !THREE) return;
    const three = THREE;
    this.camera.updateMatrixWorld();
    const right = new three.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0); // camera +X (screen right)
    const up = new three.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1); // camera +Y (screen up)
    const k = this.rad * PAN;
    this.target.x += -dx * k * right.x + dy * k * up.x;
    this.target.y += -dx * k * right.y + dy * k * up.y;
    this.target.z += -dx * k * right.z + dy * k * up.z;
    this.place();
    this.draw();
  }
  /** Reset the camera to frame the whole ball (R / R3 / recenter). */
  recenter(): void {
    this.frame(this.lastRadius);
    this.draw();
  }
  private place(): void {
    if (!this.camera) return;
    const sp = Math.sin(this.pol);
    const t = this.target;
    this.camera.position.set(t.x + this.rad * sp * Math.cos(this.az), t.y + this.rad * Math.cos(this.pol), t.z + this.rad * sp * Math.sin(this.az));
    this.camera.lookAt(t.x, t.y, t.z);
  }
  // Frame the whole ball: pull the camera back so a sphere of `radius` fills the view.
  private frame(radius: number): void {
    if (!this.camera) return;
    const r = Math.max(radius, FRAME_FLOOR);
    this.lastRadius = radius;
    this.target = { x: 0, y: 0, z: 0 }; // re-centre the look-at on the ball
    this.rad = (r * FRAME_MARGIN) / Math.tan((this.camera.fov * Math.PI) / 360);
    this.az = 0.6;
    this.pol = 1.05;
    this.camera.near = Math.max(0.1, this.rad / 1000);
    this.camera.far = this.rad * 10;
    this.camera.updateProjectionMatrix();
    this.place();
  }

  private draw(): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.(); // owner re-uploads the canvas into its Pixi texture
    this.drawCount++;
    this.lastDrawMs = performance.now() - t0;
  }

  /** Resize the off-DOM render target (the owner sizes its sprite to match). */
  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(w, h, false); // false: off-DOM, don't touch canvas CSS
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  /** Re-read the theme (background + node/edge colours) and repaint, keeping the camera. */
  retheme(): void {
    if (this.on) this.update(this.current, true);
  }

  private disposeGroup(g: T.Group): void {
    g.traverse((o) => {
      const any = o as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
      any.geometry?.dispose();
      any.material?.dispose();
    });
  }
}

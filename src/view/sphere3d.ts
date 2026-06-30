/**
 * The 3D "packed sphere" view (ADR 18) — a lazy Three.js renderer for the focused term. It
 * renders {@link layoutSphere} as instanced spheres + coloured edges into its OWN off-DOM
 * canvas; the owner draws that canvas as a Pixi texture sprite so the Pixi HUD composites on
 * top (compositing "A", Magi-consensus — no separate overlay covering the HUD). Re-renders on
 * demand (term / theme / resize / orbit) and animates reduction steps via {@link animateTo} +
 * {@link advanceMorph} (plan 06: survivors glide, new nodes scale in, dropped scale out — the 3D
 * echo of TreeView.animateTo), each render firing {@link onFrame} so the owner re-uploads. The camera is a small
 * orbit driven by the host's Pixi pointer events ({@link orbit} / {@link zoomBy}) — no
 * OrbitControls, since the canvas isn't in the DOM. Three is dynamic-imported on first entry
 * (the lazy-heavy pattern); WebGL by default, WebGPU when the optimization is on (it auto-falls-
 * back to WebGL2), so headless/CI stays on WebGL.
 */
import type * as T from "three";
import { type Node } from "../core/term";
import { layoutSphere } from "../core/layout3d";
import { theme, combinatorColor } from "./theme";

/** Beyond this node count the static scene gets heavy to build/draw — the app preflights this
 *  (iteratively, deep-safe) before entering 3D. */
export const NODE_CAP = 20_000;
const SPHERE_SEGMENTS = 12; // low-poly node sphere (instanced thousands of times)
const ROT = 0.008; // orbit radians per pixel of drag
const PAN = 0.0016; // pan world-units per pixel, scaled by orbit radius (consistent at any zoom)
const POLAR_MIN = 0.08;
const POLAR_MAX = Math.PI - 0.08;
const DPR_CAP = 1.5; // cap the 3D canvas DPR — the texture re-upload per orbit step is the cost, not the draw
const MORPH_CAP = 600; // above this the per-frame morph tween is too costly — jump-cut (snap) the step, like the 2D HEAVY path

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
interface Morph {
  mesh: T.InstancedMesh;
  anims: MorphAnim[];
  edgeGeo: T.BufferGeometry;
  epos: Float32Array;
  pairs: Array<[number, number]>; // new-tree edge endpoint ids (positions interpolate each frame)
  curPos: Map<number, Pos3>;
  node: Node; // the settled term to snap to when the tween ends
  newPos: Map<number, Pos3>;
  elapsed: number;
  duration: number;
}

// Lazily-loaded Three module (WebGL — see ADR 18; WebGPU was dropped as not worth the
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
function nodeStyle(n: Node): { radius: number; color: number } {
  switch (n.kind) {
    case "iota":
      return { radius: 9, color: theme.iota };
    case "comb":
      return { radius: 18, color: combinatorColor(n.sym) };
    case "free":
      return { radius: 15, color: theme.mutedDot };
    default:
      return { radius: 7, color: theme.mutedDot }; // app junction
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
  bg: number | null = null; // scene background override (the preview matches its box); null = theme.bg
  frameMargin = 1.6; // camera pull-back factor when framing (smaller = the ball fills more of the view)
  frameFloor = 120; // min framing radius (keeps a tiny tree from clipping; the preview lowers it to fill its box)
  drawCount = 0; // renders since boot (dev seam: confirms the morph render loop actually advanced)
  private lastPos = new Map<number, Pos3>(); // currently-displayed node positions — the next morph's `from`
  private lastNodes = new Map<number, Node>(); // currently-displayed nodes (to colour/size dropped nodes)
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
    if (!this.on || !THREE || !this.scene) return;
    const three = THREE;
    this.scene.background = new three.Color(this.bg ?? theme.bg);
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
      this.draw();
      return;
    }
    const t0 = performance.now();
    const { pos, radius } = layoutSphere(node);
    this.lastCount = pos.size;
    this.lastCapped = pos.size > NODE_CAP;
    if (this.lastCapped) {
      this.lastPos = new Map(); // can't morph from a tree we never laid out — the next step snaps
      this.lastNodes = new Map();
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
    const { pos: newPos } = layoutSphere(node);
    const ids = new Set<number>([...this.lastPos.keys(), ...newPos.keys()]);
    if (this.lastPos.size === 0 || ids.size > MORPH_CAP) {
      this.update(node, true); // nothing to glide from, or too big to tween — snap to the steady scene
      return;
    }
    const newNodes = this.collect(node);
    const mesh = new three.InstancedMesh(new three.SphereGeometry(1, SPHERE_SEGMENTS, SPHERE_SEGMENTS), new three.MeshBasicMaterial(), ids.size);
    const anims: MorphAnim[] = [];
    const col = new three.Color();
    let i = 0;
    for (const id of ids) {
      const np = newPos.get(id);
      const op = this.lastPos.get(id);
      const { radius: baseR, color } = nodeStyle(newNodes.get(id) ?? this.lastNodes.get(id)!);
      if (np && op) anims.push({ i, id, fx: op.x, fy: op.y, fz: op.z, tx: np.x, ty: np.y, tz: np.z, baseR, sFrom: 1, sTo: 1 });
      else if (np) anims.push({ i, id, fx: np.x, fy: np.y, fz: np.z, tx: np.x, ty: np.y, tz: np.z, baseR, sFrom: 0, sTo: 1 });
      else anims.push({ i, id, fx: op!.x, fy: op!.y, fz: op!.z, tx: op!.x, ty: op!.y, tz: op!.z, baseR, sFrom: 1, sTo: 0 });
      mesh.setColorAt(i, col.set(color));
      i++;
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // new-tree edges (endpoints are all in `ids`, so curPos has them); positions rewritten each frame
    const pairs: Array<[number, number]> = [];
    const ecols: number[] = [];
    const fnC = new three.Color(theme.fnEdge);
    const argC = new three.Color(theme.argEdge);
    const seen = new Set<number>();
    const ewalk = (m: Node): void => {
      if (seen.has(m.id) || m.kind !== "app") return;
      seen.add(m.id);
      pairs.push([m.id, m.fn.id], [m.id, m.arg.id]);
      ecols.push(fnC.r, fnC.g, fnC.b, fnC.r, fnC.g, fnC.b, argC.r, argC.g, argC.b, argC.r, argC.g, argC.b);
      ewalk(m.fn);
      ewalk(m.arg);
    };
    ewalk(node);
    const edgeGeo = new three.BufferGeometry();
    const epos = new Float32Array(pairs.length * 6);
    edgeGeo.setAttribute("position", new three.BufferAttribute(epos, 3));
    edgeGeo.setAttribute("color", new three.Float32BufferAttribute(ecols, 3));
    const group = new three.Group();
    group.add(mesh);
    if (pairs.length) group.add(new three.LineSegments(edgeGeo, new three.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 })));
    if (this.content) {
      this.disposeGroup(this.content);
      this.scene.remove(this.content);
    }
    this.scene.add(group);
    this.content = group;
    this.place(); // a same-term morph — keep the user's orbit/zoom
    this.morph = { mesh, anims, edgeGeo, epos, pairs, curPos: new Map(), node, newPos, elapsed: 0, duration: Math.max(16, durationMS) };
    this.advanceMorph(0); // paint frame 0
  }

  /** Advance the active morph by `dtMS` (host's Pixi ticker); snaps to the steady scene at the end.
   *  No-op when idle. Returns true while a morph is still running. */
  advanceMorph(dtMS: number): boolean {
    const m = this.morph;
    if (!m || !THREE) return false;
    const three = THREE;
    m.elapsed += dtMS;
    const t = Math.min(1, m.elapsed / m.duration);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOut
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
    for (let k = 0; k < m.pairs.length; k++) {
      const pa = m.curPos.get(m.pairs[k][0])!;
      const pb = m.curPos.get(m.pairs[k][1])!;
      const o = k * 6;
      m.epos[o] = pa.x;
      m.epos[o + 1] = pa.y;
      m.epos[o + 2] = pa.z;
      m.epos[o + 3] = pb.x;
      m.epos[o + 4] = pb.y;
      m.epos[o + 5] = pb.z;
    }
    if (m.pairs.length) m.edgeGeo.getAttribute("position").needsUpdate = true;
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

  /** Dev seam (E2E): the morph's phase + counts so a test can assert the MATH ran (survivors glide,
   *  enter 0→1, exit 1→0) without trusting headless pixels. `drawCount` proves the loop advanced. */
  debugMorph(): { active: boolean; t: number; drawCount: number; survivors: number; entering: number; exiting: number; enterScale: number; exitScale: number } {
    const m = this.morph;
    if (!m) return { active: false, t: 1, drawCount: this.drawCount, survivors: 0, entering: 0, exiting: 0, enterScale: 0, exitScale: 0 };
    const t = Math.min(1, m.elapsed / m.duration);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
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
    const walk = (n: Node): void => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      const p = pos.get(n.id)!;
      const { radius, color } = nodeStyle(n);
      m.makeScale(radius, radius, radius);
      m.setPosition(p.x, p.y, p.z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, col.set(color));
      i++;
      if (n.kind === "app") {
        walk(n.fn);
        walk(n.arg);
      }
    };
    walk(root);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }

  // All parent→child edges in one LineSegments buffer; fn edges warm, arg edges cool (the 2D legend).
  private buildEdges(three: typeof T, root: Node, pos: Map<number, { x: number; y: number; z: number }>): T.LineSegments | null {
    const verts: number[] = [];
    const colors: number[] = [];
    const fn = new three.Color(theme.fnEdge);
    const arg = new three.Color(theme.argEdge);
    const seen = new Set<number>();
    const edge = (a: Node, b: Node, c: T.Color): void => {
      const pa = pos.get(a.id)!;
      const pb = pos.get(b.id)!;
      verts.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    const walk = (n: Node): void => {
      if (seen.has(n.id) || n.kind !== "app") return;
      seen.add(n.id);
      edge(n, n.fn, fn);
      edge(n, n.arg, arg);
      walk(n.fn);
      walk(n.arg);
    };
    walk(root);
    if (!verts.length) return null;
    const geo = new three.BufferGeometry();
    geo.setAttribute("position", new three.Float32BufferAttribute(verts, 3));
    geo.setAttribute("color", new three.Float32BufferAttribute(colors, 3));
    return new three.LineSegments(geo, new three.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }));
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
    const r = Math.max(radius, this.frameFloor);
    this.lastRadius = radius;
    this.target = { x: 0, y: 0, z: 0 }; // re-centre the look-at on the ball
    this.rad = (r * this.frameMargin) / Math.tan((this.camera.fov * Math.PI) / 360);
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

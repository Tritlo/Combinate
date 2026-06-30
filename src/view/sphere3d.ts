/**
 * The 3D "packed sphere" view (ADR 18) — a lazy Three.js renderer for the focused term. It
 * renders {@link layoutSphere} as instanced spheres + coloured edges into its OWN off-DOM
 * canvas; the owner draws that canvas as a Pixi texture sprite so the Pixi HUD composites on
 * top (compositing "A", Magi-consensus — no separate overlay covering the HUD). Static + read-
 * only (no reduction animation yet): re-renders on demand (term / theme / resize / orbit), each
 * render firing {@link onFrame} so the owner can re-upload the texture. The camera is a small
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
      this.draw();
      return;
    }
    const t0 = performance.now();
    const { pos, radius } = layoutSphere(node);
    this.lastCount = pos.size;
    this.lastCapped = pos.size > NODE_CAP;
    if (this.lastCapped) {
      this.draw();
      return; // too big to build a static scene — blank (the toast lives in app.ts)
    }
    const group = new three.Group();
    group.add(this.buildNodes(three, node, pos));
    const edges = this.buildEdges(three, node, pos);
    if (edges) group.add(edges);
    this.scene.add(group);
    this.content = group;
    this.lastRadius = radius;
    if (keepCamera) this.place();
    else this.frame(radius);
    this.draw();
    this.lastBuildMs = performance.now() - t0;
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
    const r = Math.max(radius, 120);
    this.lastRadius = radius;
    this.target = { x: 0, y: 0, z: 0 }; // re-centre the look-at on the ball
    this.rad = (r * 1.6) / Math.tan((this.camera.fov * Math.PI) / 360);
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

/**
 * The 3D "packed sphere" view (ADR 18) — a lazy Three.js renderer for the focused term. A
 * static, read-only visualization (no reduction animation yet): it renders the {@link
 * layoutSphere} of one term as instanced spheres + coloured edges, with orbit controls, and
 * re-renders on demand (on a term/theme/resize change or a camera move). Three is dynamic-
 * imported on first entry (the lazy-heavy pattern — DuckDB-WASM, the MicroHs blob), so it never
 * touches the main bundle. WebGL today; a WebGPU backend can slot into {@link makeRenderer}
 * later (ADR 18). The 2D Pixi scene is untouched — this is a parallel canvas the toggle covers
 * it with.
 */
import type * as T from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type Node } from "../core/term";
import { layoutSphere } from "../core/layout3d";
import { theme, combinatorColor } from "./theme";

/** Beyond this node count the static scene gets heavy to build/draw — the app preflights this
 *  (iteratively, deep-safe) before entering 3D, so the toast shows while the 2D HUD is up. */
export const NODE_CAP = 20_000;
const SPHERE_SEGMENTS = 12; // low-poly node sphere (instanced thousands of times)

// Lazily-loaded Three module + OrbitControls constructor (shared across instances).
let THREE: typeof T | null = null;
let OrbitCtor: (new (camera: T.Camera, dom: HTMLElement) => OrbitControls) | null = null;
async function loadThree(): Promise<void> {
  if (THREE) return;
  const [three, orbit] = await Promise.all([import("three"), import("three/examples/jsm/controls/OrbitControls.js")]);
  THREE = three;
  OrbitCtor = orbit.OrbitControls as unknown as new (camera: T.Camera, dom: HTMLElement) => OrbitControls;
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

export class Sphere3D {
  readonly canvas = document.createElement("canvas");
  private renderer: T.WebGLRenderer | null = null;
  private scene: T.Scene | null = null;
  private camera: T.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private content: T.Group | null = null; // the current term's meshes (replaced each render)
  private current: Node | null = null;
  private on = false;
  /** The last render's node count, and whether it was too big to draw (the app toasts on it). */
  lastCount = 0;
  lastCapped = false;

  constructor() {
    this.canvas.style.cssText = "position:fixed; inset:0; width:100%; height:100%; display:none; z-index:1; touch-action:none;";
    document.body.appendChild(this.canvas);
  }

  get active(): boolean {
    return this.on;
  }

  /** Enter 3D and render `node` (lazy-loads Three on first call). Rejects if Three fails to load
   *  or WebGL is unavailable — the caller resets the toggle + toasts (a visible failure). */
  async show(node: Node | null): Promise<void> {
    this.on = true;
    this.canvas.style.display = "block";
    try {
      await loadThree();
      this.ensureScene(); // `new WebGLRenderer` can throw (no WebGL / blocklisted / lost context)
    } catch (e) {
      this.on = false;
      this.canvas.style.display = "none";
      throw e;
    }
    this.update(node);
  }

  /** Leave 3D — hide the canvas (keeps the GL context warm for a quick re-entry). */
  hide(): void {
    this.on = false;
    this.canvas.style.display = "none";
  }

  private makeRenderer(three: typeof T): T.WebGLRenderer {
    // WebGL today (ADR 18 — WebGPU is a later renderer-factory branch). Antialiased, DPR-capped.
    const r = new three.WebGLRenderer({ canvas: this.canvas, antialias: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    return r;
  }

  private ensureScene(): void {
    if (this.scene || !THREE) return;
    const three = THREE;
    this.renderer = this.makeRenderer(three);
    this.scene = new three.Scene();
    this.camera = new three.PerspectiveCamera(50, 1, 0.1, 500_000);
    // form-giving light so the spheres read as 3D (cheap: one directional + ambient).
    this.scene.add(new three.AmbientLight(0xffffff, 0.65));
    const key = new three.DirectionalLight(0xffffff, 0.9);
    key.position.set(1, 1.4, 1.2);
    this.scene.add(key);
    const controls = new OrbitCtor!(this.camera, this.canvas);
    controls.enableDamping = false; // static: render on demand, no rAF loop
    controls.addEventListener("change", () => this.draw());
    this.controls = controls;
    this.resize();
  }

  /** Render `node` (rebuilds the scene content + frames the camera). Cheap to call again. */
  update(node: Node | null): void {
    this.current = node;
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
      this.draw();
      return;
    }
    const { pos, radius } = layoutSphere(node);
    this.lastCount = pos.size;
    this.lastCapped = pos.size > NODE_CAP;
    if (this.lastCapped) {
      this.draw();
      return; // too big to build a static scene — leave it blank (the toast lives in app.ts)
    }
    const group = new three.Group();
    group.add(this.buildNodes(three, node, pos));
    const edges = this.buildEdges(three, node, pos);
    if (edges) group.add(edges);
    this.scene.add(group);
    this.content = group;
    this.frame(radius);
    this.draw();
  }

  // One instanced sphere per node, positioned + scaled by kind, tinted per kind.
  private buildNodes(three: typeof T, root: Node, pos: Map<number, { x: number; y: number; z: number }>): T.InstancedMesh {
    const geo = new three.SphereGeometry(1, SPHERE_SEGMENTS, SPHERE_SEGMENTS);
    const mat = new three.MeshLambertMaterial();
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

  // Frame the whole ball: pull the camera back so a sphere of `radius` fills the view.
  private frame(radius: number): void {
    if (!this.camera || !this.controls) return;
    const r = Math.max(radius, 120);
    const dist = (r * 1.5) / Math.tan((this.camera.fov * Math.PI) / 360);
    this.camera.position.set(dist * 0.5, dist * 0.35, dist * 0.9);
    this.camera.near = Math.max(0.1, dist / 1000);
    this.camera.far = dist * 10;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private draw(): void {
    if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    if (!this.renderer || !this.camera) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  /** Re-read the theme (background + edge/node colours) and repaint. */
  retheme(): void {
    if (this.on) this.update(this.current);
  }

  private disposeGroup(g: T.Group): void {
    g.traverse((o) => {
      const any = o as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
      any.geometry?.dispose();
      any.material?.dispose();
    });
  }
}

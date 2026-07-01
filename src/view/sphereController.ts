/**
 * SphereController — owns the whole 3D "packed sphere" subsystem (ADR 20), extracted from app.ts.
 *
 * It holds all 3D state (the {@link Sphere3D} renderer, its Pixi-composited sprite/texture, the
 * `active` flag, orbit-drag + release-momentum + held-rotate state, and the per-frame orbit ticker)
 * and exposes SEMANTIC operations. The shell (`app.ts`) keeps the raw pointer/touch/gamepad/keyboard
 * plumbing and calls these methods only while 3D is active — so this module stays free of any
 * Pixi-event handling or input-context knowledge.
 *
 * Compositing "A" (ADR 20): Three renders to its own off-DOM canvas, drawn as a Pixi texture sprite
 * in a layer between `world` and `hud`, so the Pixi HUD composites on top. Entering is async (Three
 * is dynamic-imported on first use); a generation token drops a stale `show()` result if the view is
 * exited / re-entered before it resolves.
 */
import { Container, Sprite, Texture, type Ticker } from "pixi.js";
import { type Node, exceedsNodes } from "../core/term";
import { type Layout3Fn } from "../core/layout3d";
import { Sphere3D, NODE_CAP } from "./sphere3d";
import { type TreeView } from "./tree";

const KEY_ROT = 6; // orbit: px-equivalent per frame for a held rotate-key
const MOM_DECAY = 0.92; // orbit: drag-release momentum decay per frame

/** What the controller needs from the shell (all 3D-specific; no input-context knowledge). */
export interface SphereControllerDeps {
  stage: Container;
  hud: Container; // the sphere layer is inserted just below this
  world: Container; // hidden while 3D is open, shown again on exit
  ticker: Ticker;
  focus: () => TreeView | null;
  /** The EXPANDED display term for a node (undiscovered S/K/I as ι-trees, etc.) — 3D mirrors the 2D tree. */
  display: (node: Node) => Node;
  /** The 3D layout to use, derived from the current 2D layout mode. */
  layout3: () => Layout3Fn;
  /** Show a transient message on the (still-visible) 2D HUD. */
  notify: (msg: string) => void;
  /** Fired when 3D opens (true) / closes (false) so the shell can re-sync controls/hints/rail and
   *  clear any shared touch-gesture state. Called with `active` already updated. */
  onActiveChange: (active: boolean) => void;
}

/** The dev-seam readout (`__combinate.view3d.info()`), kept source-compatible with the old inline seam. */
export interface SphereInfo {
  count: number;
  capped: boolean;
  buildMs: number;
  drawMs: number;
  morphMs: number;
  az: number;
  pan: number;
}

export class SphereController {
  private readonly sphere = new Sphere3D();
  private readonly layer = new Container();
  private readonly sprite: Sprite;
  private tex: Texture;
  private view3D = false;
  private gen = 0; // bumped on exit + each enter; a stale async show() result checks it before acting
  private orbitDrag: { x: number; y: number } | null = null; // right-drag (mouse)
  private panDrag: { x: number; y: number } | null = null; // left-drag (mouse)
  private lastDragD = { x: 0, y: 0 };
  private readonly heldRot = new Set<string>();
  private momVx = 0;
  private momVy = 0;
  private readonly tickFn = (tk: { deltaMS: number }): void => this.tick(tk.deltaMS);

  constructor(private readonly deps: SphereControllerDeps) {
    this.layer.visible = false;
    this.layer.eventMode = "none"; // orbit input is read off the stage; the sprite never intercepts
    deps.stage.addChildAt(this.layer, deps.stage.getChildIndex(deps.hud)); // just below the HUD
    this.tex = Texture.from(this.sphere.canvas);
    this.sprite = new Sprite(this.tex);
    this.layer.addChild(this.sprite);
    this.sphere.onFrame = () => this.tex.source.update(); // re-upload the canvas after each 3D render
    deps.ticker.add(this.tickFn);
  }

  active(): boolean {
    return this.view3D;
  }
  morphing(): boolean {
    return this.sphere.morphing;
  }
  /** Is `tree` the focused tree AND 3D open? (The 2D view is hidden, so its morph paces the reduction.) */
  isPacing(tree: TreeView): boolean {
    return this.view3D && tree === this.deps.focus();
  }

  // ---- lifecycle ----

  private displayTerm(): Node | null {
    const f = this.deps.focus();
    return f ? this.deps.display(f.node) : null;
  }

  /** Match the sprite to the (resized) off-DOM canvas; re-bind the texture if the canvas grew. */
  private fit(): void {
    if (this.tex.source.resource !== this.sphere.canvas || this.tex.source.pixelWidth !== this.sphere.canvas.width) {
      this.tex.destroy();
      this.tex = Texture.from(this.sphere.canvas);
      this.sprite.texture = this.tex;
      this.sphere.onFrame = () => this.tex.source.update();
    }
    this.sprite.setSize(window.innerWidth, window.innerHeight);
    this.tex.source.update();
  }

  toggle(): void {
    if (this.view3D) this.exit();
    else this.enter();
  }

  enter(): void {
    if (this.view3D) return;
    // Preflight on the EXPANDED display (iterative exceedsNodes — deep-tree-safe) so a too-big /
    // unfocused tree never enters 3D, and the message shows on the visible 2D HUD.
    const disp = this.displayTerm();
    if (!disp) return this.deps.notify("focus a tree to view it in 3D");
    if (exceedsNodes(disp, NODE_CAP)) return this.deps.notify(`tree too large for 3D (over ${NODE_CAP} nodes)`);
    this.view3D = true;
    const g = ++this.gen;
    this.sphere.setLayout3(this.deps.layout3());
    this.deps.onActiveChange(true); // shell: hide build visuals + refresh hints/rail, BEFORE the world hides
    this.deps.world.visible = false;
    this.layer.visible = true;
    void this.sphere
      .show(disp, window.innerWidth, window.innerHeight)
      .then(() => {
        if (g === this.gen) this.fit();
      })
      .catch((e: unknown) => {
        if (g !== this.gen) return; // a later exit / re-enter superseded this attempt
        this.view3D = false; // Three failed to load / no WebGL — back out visibly
        this.layer.visible = false;
        this.deps.world.visible = true;
        this.sphere.hide();
        this.deps.onActiveChange(false);
        this.deps.notify("3D view unavailable — WebGL not supported here");
        console.warn("sphere3d:", e);
      });
  }

  exit(): void {
    if (!this.view3D) return;
    this.view3D = false;
    this.gen++; // invalidate any in-flight enter()
    this.layer.visible = false;
    this.deps.world.visible = true;
    this.sphere.hide();
    this.heldRot.clear(); // drop still-held rotate-keys so they don't resume on re-entry
    this.orbitDrag = this.panDrag = null;
    this.momVx = this.momVy = 0;
    this.deps.onActiveChange(false);
  }

  /** Re-render the open 3D view after a setting changed the displayed term (Expand toggle, a
   *  discovery). Keeps the camera; backs out to 2D if the new display blew past the node cap. */
  rerender(): void {
    if (!this.view3D) return;
    const disp = this.displayTerm();
    if (disp && exceedsNodes(disp, NODE_CAP)) {
      this.exit();
      return this.deps.notify(`tree too large for 3D (over ${NODE_CAP} nodes)`);
    }
    this.sphere.update(disp, true);
  }

  /** Mirror a focused tree's reduction step into the open 3D view (plan 06). No-op unless 3D is open
   *  on the focused tree; backs out to 2D if the expanded term exceeds the cap. */
  morph(tree: TreeView, node: Node, durationMS: number): void {
    if (!this.view3D || tree !== this.deps.focus()) return;
    const disp = this.deps.display(node);
    if (exceedsNodes(disp, NODE_CAP)) {
      this.exit();
      return this.deps.notify(`tree too large for 3D (over ${NODE_CAP} nodes)`);
    }
    this.sphere.animateTo(disp, durationMS);
  }
  settleMorph(): void {
    this.sphere.settleMorph();
  }

  // ---- input (semantic; the shell forwards raw pointer/touch/gamepad/keyboard events) ----

  orbitBy(dx: number, dy: number): void {
    this.sphere.orbit(dx, dy);
  }
  panBy(dx: number, dy: number): void {
    this.sphere.pan(dx, dy);
  }
  zoomBy(factor: number): void {
    this.sphere.zoomBy(factor);
  }
  recenter(): void {
    this.sphere.recenter();
  }
  holdRotate(key: string): void {
    this.heldRot.add(key);
  }
  releaseRotate(key: string): void {
    this.heldRot.delete(key);
  }

  /** Mouse drag with internal state + release momentum: pan (left) or orbit (right). */
  beginDrag(kind: "pan" | "orbit", x: number, y: number): void {
    if (kind === "pan") this.panDrag = { x, y };
    else this.orbitDrag = { x, y };
  }
  dragTo(x: number, y: number): void {
    if (this.panDrag) {
      this.sphere.pan(x - this.panDrag.x, y - this.panDrag.y);
      this.panDrag = { x, y };
    } else if (this.orbitDrag) {
      const dx = x - this.orbitDrag.x;
      const dy = y - this.orbitDrag.y;
      this.sphere.orbit(dx, dy);
      this.lastDragD = { x: dx, y: dy }; // remember the flick for release momentum
      this.orbitDrag = { x, y };
    }
  }
  endDrag(): void {
    if (this.orbitDrag) {
      this.momVx = this.lastDragD.x; // a flick imparts spin momentum (decays on the ticker)
      this.momVy = this.lastDragD.y;
      this.lastDragD = { x: 0, y: 0 };
    }
    this.orbitDrag = null;
    this.panDrag = null;
  }

  // ---- per-frame + window ----

  private tick(deltaMS: number): void {
    if (!this.view3D) return;
    if (this.sphere.morphing) return void this.sphere.advanceMorph(deltaMS); // a reduction-step morph owns the frame
    let vx = 0;
    let vy = 0;
    const h = this.heldRot;
    if (h.has("arrowleft") || h.has("a")) vx -= KEY_ROT;
    if (h.has("arrowright") || h.has("d")) vx += KEY_ROT;
    if (h.has("arrowup") || h.has("w")) vy -= KEY_ROT;
    if (h.has("arrowdown") || h.has("s")) vy += KEY_ROT;
    vx += this.momVx;
    vy += this.momVy;
    if (Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05) this.sphere.orbit(vx, vy);
    this.momVx = Math.abs(this.momVx) < 0.05 ? 0 : this.momVx * MOM_DECAY;
    this.momVy = Math.abs(this.momVy) < 0.05 ? 0 : this.momVy * MOM_DECAY;
  }

  resize(w: number, h: number): void {
    if (!this.view3D) return;
    this.sphere.resize(w, h);
    this.fit();
  }
  retheme(): void {
    this.sphere.retheme(); // no-op when the 3D view is closed
  }

  // ---- dev seam (kept source-compatible with __combinate.view3d) ----

  info(): SphereInfo {
    const s = this.sphere;
    return { count: s.lastCount, capped: s.lastCapped, buildMs: s.lastBuildMs, drawMs: s.lastDrawMs, morphMs: s.lastMorphFrameMs, az: s.azimuth, pan: s.panSum };
  }
  debugMorph(): ReturnType<Sphere3D["debugMorph"]> {
    return this.sphere.debugMorph();
  }

  /** Release resources (ticker callback, texture, layer). For test/remount correctness — not called
   *  in the normal single-lifetime SPA flow. */
  dispose(): void {
    this.deps.ticker.remove(this.tickFn);
    this.sphere.hide();
    this.tex.destroy();
    this.layer.destroy({ children: true });
  }
}

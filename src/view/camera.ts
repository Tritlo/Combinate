/**
 * Camera — owns the world container's view transform (pan + clamped zoom) and screen↔world
 * coordinate conversion. A thin deep module over `world`'s position/scale so the camera math lives
 * in one place and the shell just issues semantic moves. It does NOT manage `world`'s children
 * (tree lifecycle stays with the workspace); it only reads/writes the transform.
 */
import { type Container } from "pixi.js";

const MIN_SCALE = 0.04; // floor low enough that a fac-scale tree still fits
// Deep zoom: with taper (nodes shrink like their arms) the H-tree is self-similar, so zooming in
// IS the way to explore depth — 1e7 reaches ~40 levels below full size. The old cap of 4 was a
// float32 safety margin; precision past ~1e4 is handled by the floating-origin rebase instead
// (TreeView.rebase, hooked via onChange), which keeps GPU-visible magnitudes small.
const MAX_SCALE = 1e7;

export class Camera {
  constructor(private readonly world: Container) {}

  /** Fired after every transform mutation (pan / zoom / place) — the shell hooks the deep-zoom
   *  floating-origin check here (DragController mutates the camera directly, so per-call-site
   *  hooks would miss pans). */
  onChange: (() => void) | undefined;

  /** Current zoom factor. */
  get scale(): number {
    return this.world.scale.x;
  }
  /** The transform as a plain record (TreeView reads this for screen-space culling / labels). */
  transform(): { x: number; y: number; scale: number } {
    return { x: this.world.position.x, y: this.world.position.y, scale: this.world.scale.x };
  }
  screenToWorld(x: number, y: number): { x: number; y: number } {
    return this.world.toLocal({ x, y });
  }
  worldToScreen(x: number, y: number): { x: number; y: number } {
    return this.world.toGlobal({ x, y });
  }

  /** Set the world container's screen position directly (used by a camera-pan drag). */
  moveTo(x: number, y: number): void {
    this.world.position.set(x, y);
    this.onChange?.();
  }
  /** Nudge the camera by a screen-space delta. */
  panBy(dx: number, dy: number): void {
    this.world.position.set(this.world.position.x + dx, this.world.position.y + dy);
    this.onChange?.();
  }
  /** Set a new (clamped) scale while keeping the screen point (sx,sy) fixed under it. */
  zoomTo(newScale: number, sx: number, sy: number): void {
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    const ratio = s / this.world.scale.x;
    this.world.position.set(sx - (sx - this.world.position.x) * ratio, sy - (sy - this.world.position.y) * ratio);
    this.world.scale.set(s);
    this.onChange?.();
  }
  /** Multiply the current scale by `factor`, keeping the screen point (sx,sy) fixed. */
  zoomBy(factor: number, sx: number, sy: number): void {
    this.zoomTo(this.world.scale.x * factor, sx, sy);
  }
  /** Place world point (cx,cy) at screen point (px,py) at an exact scale (caller pre-clamps). Fit/frame. */
  place(cx: number, cy: number, scale: number, px: number, py: number): void {
    this.world.scale.set(scale);
    this.world.position.set(px - cx * scale, py - cy * scale);
    this.onChange?.();
  }
}

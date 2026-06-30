/**
 * A pooled, non-interactive, slowly auto-rotating 3D preview of a term (ADR 18, plans 04-05). One
 * shared instance — a SEPARATE small `Sphere3D` from the full-screen view (the council capped live
 * WebGL contexts at two) — used by the Zoo creature picture and the discovery card.
 *
 * Contention is by PRIORITY: a higher-priority acquire preempts the current owner (its `onPreempt`
 * fires so it falls back to 2D); a lower-priority acquire while a higher one holds it is refused
 * (resolves null, caller keeps 2D). When the holder releases, {@link onAvailable} fires so a waiting
 * lower-priority owner (the Zoo) can re-acquire. The discovery card outranks the Zoo.
 *
 * Shows are SERIALIZED through a single-slot queue keyed by a monotonic `seq`: only one
 * `Sphere3D.show()` runs at a time, only the LATEST request is kept, and `release()` bumps `seq` so
 * an in-flight show for the released owner can't commit (no orphaned spinning preview). The spin is
 * advanced by the host's Pixi {@link tick} (NOT a private rAF) so the Three-canvas mutation and the
 * Pixi texture upload share one cadence — a private rAF can mutate Three while Pixi still shows the
 * last-uploaded (stale) texture, which read as "not spinning". Paused with no holder / hidden tab /
 * reduced motion; degrades to null (caller keeps 2D) when WebGL/Three can't load.
 */
import { type Node } from "../core/term";
import { Sphere3D } from "./sphere3d";
import { theme } from "./theme";
import { withMotion } from "./motion";

export const SLOW_SPIN = 100; // px-equivalent orbit/sec (~46°/s, ~8s/turn) — clearly turning, still ambient
export const FAST_SPIN = 300; // px-equivalent orbit/sec (~one full turn in ~2.6s) — the discovery card
export const ZOO_PRIO = 1; // the Zoo's lease priority
export const CARD_PRIO = 2; // the discovery card outranks the Zoo

interface Lease {
  owner: string;
  priority: number;
  node: Node;
  size: number;
  onFrame: () => void;
  onPreempt?: () => void;
  spin: number;
  bg: number;
  seq: number;
  resolve: (canvas: HTMLCanvasElement | null) => void;
}

/** Options for {@link SpherePreview.acquire}. */
export interface PreviewOpts {
  onFrame: () => void; // fired after each render (compositors re-upload; a DOM canvas no-ops)
  onPreempt?: () => void; // fired when a higher-priority acquire displaces this owner (fall back to 2D)
  spin?: number; // orbit px-equivalent per second (default SLOW_SPIN)
  bg?: number; // scene background (default theme.inset — the Zoo box; the card overrides to a dark viewport)
}

class SpherePreview {
  private readonly sphere = new Sphere3D();
  private seq = 0; // newest request id
  private current: Lease | null = null; // the lease currently displayed + spinning
  private pending: Lease | null = null; // the latest queued request awaiting its show()
  private busy = false; // a show() is in flight
  private running: Lease | null = null; // the in-flight show's request (for priority + release-cancellation)
  private readonly availCbs: Array<() => void> = [];

  /** The canvas a borrower composites / appends (a stable, shared source). */
  get canvas(): HTMLCanvasElement {
    return this.sphere.canvas;
  }

  /** Run `cb` when the preview is freed (no holder, nothing queued) — a waiting owner can re-acquire. */
  onAvailable(cb: () => void): void {
    this.availCbs.push(cb);
  }

  /** Acquire the preview at `priority`, render `node` at `size`px, auto-spin. Higher priority
   *  preempts; a lower priority while a higher holds it is refused (resolves null). */
  acquire(owner: string, priority: number, node: Node, size: number, opts: PreviewOpts): Promise<HTMLCanvasElement | null> {
    // Refused if ANY active claimant — currently shown, queued, OR mid-show — outranks us.
    for (const c of [this.current, this.pending, this.running]) {
      if (c && c.owner !== owner && c.priority > priority) return Promise.resolve(null); // outranked → caller keeps 2D
    }
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.pending?.resolve(null); // a queued-but-not-yet-run request is superseded
      this.pending = { owner, priority, node, size, onFrame: opts.onFrame, onPreempt: opts.onPreempt, spin: opts.spin ?? SLOW_SPIN, bg: opts.bg ?? theme.inset, seq, resolve };
      void this.pump();
    });
  }

  /** Release the preview if `owner` holds it (live, queued, or mid-show); fires onAvailable when freed. */
  release(owner: string): void {
    let freed = false;
    if (this.pending?.owner === owner) {
      this.pending.resolve(null);
      this.pending = null;
    }
    if (this.running?.owner === owner) this.seq++; // invalidate an in-flight show so it can't commit
    if (this.current?.owner === owner) {
      this.stop();
      freed = true;
    }
    if (freed && !this.pending && !this.busy) this.notifyAvailable();
  }

  private notifyAvailable(): void {
    for (const cb of this.availCbs.slice()) cb();
  }

  private stop(): void {
    this.current = null;
    this.sphere.onFrame = null;
    this.sphere.hide();
  }

  /** Advance the active preview's spin by `dtMS` — call this from the host's Pixi ticker so the
   *  canvas mutation lands in the same frame Pixi uploads the texture. A no-op with no holder. */
  tick(dtMS: number): void {
    const lease = this.current;
    if (!lease) return;
    const dt = Math.min(dtMS / 1000, 0.05); // clamp a hidden-tab resume
    if (dt > 0 && withMotion() && !document.hidden) this.sphere.orbit(lease.spin * dt, 0);
  }

  // Drain the single-slot queue: run the latest pending show() and commit it only if still newest.
  private async pump(): Promise<void> {
    if (this.busy || !this.pending) return;
    const req = this.pending;
    this.pending = null;
    this.busy = true;
    this.running = req;
    let canvas: HTMLCanvasElement | null = null;
    try {
      this.sphere.bg = req.bg; // match the box the preview sits in (Zoo: inset; card: a dark viewport so the tree pops)
      this.sphere.frameMargin = 1.15; // fill the box (the full view is for the canvas, no panning)
      this.sphere.frameFloor = 36; // a small tree (e.g. K) still fills the box rather than floating tiny
      await this.sphere.show(req.node, req.size, req.size);
      if (req.seq === this.seq) {
        if (this.current && this.current.owner !== req.owner) this.current.onPreempt?.(); // displaced owner → 2D
        this.current = req;
        this.sphere.onFrame = req.onFrame;
        canvas = this.sphere.canvas; // spun by the host's tick() on the Pixi ticker

      }
    } catch {
      if (req.seq === this.seq && this.current?.owner === req.owner) this.stop();
    }
    this.busy = false;
    this.running = null;
    req.resolve(canvas);
    if (this.pending) void this.pump(); // a newer request queued while we ran
    else if (!this.current) this.notifyAvailable(); // a show was cancelled mid-flight and nothing took over
  }
}

/** The single pooled preview (only the Zoo uses it now; the discovery card draws 2D). */
export const spherePreview = new SpherePreview();

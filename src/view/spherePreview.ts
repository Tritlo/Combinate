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
 * an in-flight show for the released owner can't commit (no orphaned spinning preview). Renders on a
 * dt-scaled rAF loop, paused with no holder / hidden tab / reduced motion; degrades to null (caller
 * keeps 2D) when WebGL/Three can't load.
 */
import { type Node } from "../core/term";
import { Sphere3D } from "./sphere3d";
import { withMotion } from "./motion";

export const SLOW_SPIN = 30; // px-equivalent orbit/sec (~14°/s) — the Zoo's ambient turn
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
  seq: number;
  resolve: (canvas: HTMLCanvasElement | null) => void;
}

/** Options for {@link SpherePreview.acquire}. */
export interface PreviewOpts {
  onFrame: () => void; // fired after each render (compositors re-upload; a DOM canvas no-ops)
  onPreempt?: () => void; // fired when a higher-priority acquire displaces this owner (fall back to 2D)
  spin?: number; // orbit px-equivalent per second (default SLOW_SPIN)
}

class SpherePreview {
  private readonly sphere = new Sphere3D();
  private seq = 0; // newest request id
  private current: Lease | null = null; // the lease currently displayed + spinning
  private pending: Lease | null = null; // the latest queued request awaiting its show()
  private busy = false; // a show() is in flight
  private running: Lease | null = null; // the in-flight show's request (for priority + release-cancellation)
  private raf = 0;
  private lastT = 0;
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
      this.pending = { owner, priority, node, size, onFrame: opts.onFrame, onPreempt: opts.onPreempt, spin: opts.spin ?? SLOW_SPIN, seq, resolve };
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
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.sphere.onFrame = null;
    this.sphere.hide();
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
      await this.sphere.show(req.node, req.size, req.size);
      if (req.seq === this.seq) {
        if (this.current && this.current.owner !== req.owner) this.current.onPreempt?.(); // displaced owner → 2D
        this.current = req;
        this.sphere.onFrame = req.onFrame;
        this.startSpin();
        canvas = this.sphere.canvas;
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

  private startSpin(): void {
    cancelAnimationFrame(this.raf);
    this.lastT = 0;
    const loop = (t: number): void => {
      const lease = this.current;
      if (!lease) return; // released / preempted
      const dt = this.lastT ? Math.min((t - this.lastT) / 1000, 0.05) : 0; // clamp a hidden-tab resume
      this.lastT = t;
      if (dt > 0 && withMotion() && !document.hidden) this.sphere.orbit(lease.spin * dt, 0);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
}

/** The single pooled preview (Zoo + discovery card take turns; the card outranks the Zoo). */
export const spherePreview = new SpherePreview();

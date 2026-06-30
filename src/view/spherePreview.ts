/**
 * A pooled, non-interactive, slowly auto-rotating 3D preview of a term (ADR 18, plan 04). One
 * shared instance — a SEPARATE small `Sphere3D` from the full-screen view (the council capped live
 * WebGL contexts at two) — used by the Zoo creature picture and the discovery card. Contention is
 * explicit: a later acquire preempts the current owner (its `onPreempt` fires so it can fall back to
 * 2D); the discovery card outranks the Zoo. Renders on its own dt-scaled rAF loop, paused when no
 * one holds it, the tab is hidden, or reduced motion is set. Degrades to null (caller keeps its 2D
 * view) when WebGL / Three can't load.
 *
 * Shows are SERIALIZED through a single-slot queue (`pending`) keyed by a monotonic `seq`: only one
 * `Sphere3D.show()` runs at a time and only the LATEST request is kept, so out-of-order completion
 * of a stale request can never stomp the shared scene to an old term (the race the council caught).
 */
import { type Node } from "../core/term";
import { Sphere3D } from "./sphere3d";
import { withMotion } from "./motion";

const SPIN = 30; // px-equivalent orbit per SECOND (~14°/s); dt-scaled so it's frame-rate independent

interface Lease {
  owner: string;
  node: Node;
  size: number;
  onFrame: () => void;
  onPreempt?: () => void;
  seq: number;
  resolve: (canvas: HTMLCanvasElement | null) => void;
}

class SpherePreview {
  private readonly sphere = new Sphere3D();
  private seq = 0; // newest request id
  private current: Lease | null = null; // the lease currently displayed + spinning
  private pending: Lease | null = null; // the latest queued request awaiting its show()
  private busy = false; // a show() is in flight
  private raf = 0;
  private lastT = 0;

  /** The canvas a borrower composites into a Pixi texture (a stable, shared source). */
  get canvas(): HTMLCanvasElement {
    return this.sphere.canvas;
  }

  /** Acquire the preview, render `node` at `size`px square, auto-spin. A later acquire preempts the
   *  current owner (its `onPreempt` fires). Resolves to the canvas, or null if superseded / no WebGL. */
  acquire(owner: string, node: Node, size: number, onFrame: () => void, onPreempt?: () => void): Promise<HTMLCanvasElement | null> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.pending?.resolve(null); // a queued-but-not-yet-run request is superseded
      this.pending = { owner, node, size, onFrame, onPreempt, seq, resolve };
      void this.pump();
    });
  }

  /** Release the preview if `owner` holds it (the live lease or a queued one); a no-op otherwise. */
  release(owner: string): void {
    if (this.pending?.owner === owner) {
      this.pending.resolve(null);
      this.pending = null;
    }
    if (this.current?.owner === owner) this.stop();
  }

  private stop(): void {
    this.current = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.sphere.onFrame = null;
    this.sphere.hide();
  }

  // Drain the single-slot queue: run the latest pending show() to completion, then commit it ONLY if
  // it's still the newest request (else discard — a newer one will run next). One show at a time.
  private async pump(): Promise<void> {
    if (this.busy || !this.pending) return;
    const req = this.pending;
    this.pending = null;
    this.busy = true;
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
    req.resolve(canvas);
    void this.pump(); // a newer request may have queued while we ran
  }

  private startSpin(): void {
    cancelAnimationFrame(this.raf);
    this.lastT = 0;
    const loop = (t: number): void => {
      if (!this.current) return; // released / preempted
      const dt = this.lastT ? Math.min((t - this.lastT) / 1000, 0.05) : 0; // clamp a hidden-tab resume
      this.lastT = t;
      if (dt > 0 && withMotion() && !document.hidden) this.sphere.orbit(SPIN * dt, 0);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
}

/** The single pooled preview (Zoo + discovery card take turns; card preempts Zoo). */
export const spherePreview = new SpherePreview();

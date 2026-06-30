/**
 * Reduction-count estimator (ADR, plan 02). Counts the EXACT number of contractions a term takes
 * to normal form in the SAME reduction mode the visible reducer uses — run in the background,
 * chunked on a small time budget so it never janks the main thread. The visible reducer then plays
 * the SAME reduction slowly; the progress bar fills as `visible steps / this total`.
 *
 * Reduction is deterministic (leftmost-outermost), so a same-mode background run gives the exact
 * visible count — no conversion math. Only the TS modes (raw / rule-steps / native, non-graph,
 * non-turbo) get an exact count here: graph (sharing) and turbo (wasm kernels) count a different,
 * smaller number of contractions, so they stay idle and the bar hides (turbo's own totalSteps
 * drives the bar when it IS the visible mode — handled by the controller, not here). Huge raw
 * reductions hit the cap → `capped`, and the bar shows indeterminate / nothing rather than lying.
 */
import { type Node, exceedsNodes } from "../core/term";
import { step } from "../core/reduce";
import { type NativeOpts } from "../core/native";

export type EstimateState =
  | { kind: "idle" }
  | { kind: "measuring"; done: number }
  | { kind: "exact"; total: number }
  | { kind: "capped"; done: number };

/** The reduction-mode knobs the estimator must match (mirrors the visible reducer's deps). */
export interface EstimatorMode {
  fast: boolean; // rule-steps
  native?: NativeOpts;
  share: boolean; // graph (call-by-need)
  turbo: boolean; // wasm
}

const CHUNK_MS = 6; // wall-clock budget per tick before yielding (keeps the main thread responsive)
const HARD_CAP = 2_000_000; // give up past this many steps (huge/diverging raw reduction → indeterminate)
const MAX_NODES = 90_000; // give up if the (unshared) term balloons past this — counting it would jank/OOM
const SIZE_CHECK = 256; // how often to sample the term size (the walk is O(size), so don't do it every step)

export class ReductionEstimator {
  private gen = 0;
  private timer = 0;
  /** The current estimate (read by the progress bar each frame). */
  state: EstimateState = { kind: "idle" };

  /** Stop the running estimate (mode change / focus change / new reduction). */
  cancel(): void {
    this.gen++;
    clearTimeout(this.timer);
    this.state = { kind: "idle" };
  }

  /** Begin counting `source`'s contractions to normal form under `mode`, chunked in the background. */
  estimate(source: Node, mode: EstimatorMode): void {
    this.cancel();
    if (mode.share || mode.turbo) return; // a different counting model — leave idle (no exact bar)
    const gen = ++this.gen;
    let cur = source;
    let steps = 0;
    this.state = { kind: "measuring", done: 0 };
    const tick = (): void => {
      if (gen !== this.gen) return; // superseded
      const t0 = performance.now();
      while (performance.now() - t0 < CHUNK_MS) {
        if (gen !== this.gen) return; // belt-and-suspenders (the chunk is synchronous, but keep the contract)
        const next = step(cur, 0, mode.fast, mode.native);
        if (!next) {
          this.state = { kind: "exact", total: steps }; // reached normal form — the exact count
          return;
        }
        cur = next;
        // Cap on both step count AND term size: an unshared reduction can balloon (quicksort), and
        // counting a multi-MB term would jank/OOM long before the step cap → report capped instead.
        if (++steps >= HARD_CAP || (steps % SIZE_CHECK === 0 && exceedsNodes(cur, MAX_NODES))) {
          this.state = { kind: "capped", done: steps };
          return;
        }
      }
      if (gen !== this.gen) return;
      this.state = { kind: "measuring", done: steps };
      this.timer = window.setTimeout(tick, 0); // yield, then keep counting
    };
    tick();
  }
}

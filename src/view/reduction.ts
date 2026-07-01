/**
 * The auto-reduce + transport subsystem, extracted from app.ts (reorg, ADR 12). Owns the
 * per-tree reduction loop (each settled tree plays itself to normal form one tween at a
 * time, cancelled on touch), the playback transport (play / pause / fast-forward), the
 * non-termination guard, and the graph-mode lifecycle. Pure-ish imperative shell: the Pixi
 * side effects (the transport bar) stay in app.ts and are injected
 * as callbacks, so this is the state machine, not the chrome.
 */
import { firingRule, redexAt } from "../core/reduce";
import { GraphReducer } from "../core/graph";
import { type Node, exceedsNodes } from "../core/term";
import { type NativeOpts } from "../core/native";
import { type TreeView } from "./tree";
import { type WasmSession } from "./wasmReducer";
import { ReductionEstimator, type EstimateState } from "./reductionEstimator";

const AUTO_DELAY = 450; // ms a tree must sit untouched before it starts reducing (§6.4)
const MORPH_POLL_MS = 16; // while a focused 3D morph is playing, re-check this often before stepping
const STEP_MS = 300; // duration of one reduction-step tween
const STEP_GAP = 700; // pause between reduction steps — with STEP_MS this makes Play ≈ 1 reduction/s
const HEAVY_GAP = 8; // big trees jump-cut each step; pace them fast but still yield to the renderer (≠ 0, which starves rAF)
const STEP_CAP = 2000; // non-termination guard: stop auto-reducing past this many steps
const GRAPH_STEP_CAP = 100_000; // graph mode shares (cheap steps) — let fac-scale reductions finish
// A raw/optimize term bigger than this isn't reflowed every step — laying out + drawing 14k+ nodes is
// O(n) and blocks the frame (the per-step reflow is what freezes the UI on a ballooning quicksort). Past
// it, the term reduces in the background (budgeted, yielding to the renderer) and only reflows once it's
// small enough to draw in a frame, or reaches normal form — so the UI stays live + the bar keeps moving.
const HEAVY_RENDER_CAP = 2500;
const HEAVY_TS_BUDGET_MS = 6; // wall-clock spent building contractions per batch before yielding to rAF
// A raw (unshared) reduction can balloon without bound (quicksort duplicates subterms via the S rule);
// once a single contraction would deep-clone a term this big, ONE `build()` blocks a frame. Past this,
// pause cleanly ("try Graph/Turbo", which share and don't clone) rather than freeze on a giant copy.
const BALLOON_CAP = 30_000;

// ---- Turbo (wasm) playback: run many resident contractions per visible frame, so a big
// raw tree reduces fast even when the renderer can't keep up with one tween per step. ----
const TURBO_BUDGET_MS = 12; // wall-clock spent stepping in wasm before each reflow (yields the rest of the frame to render)
const TURBO_CHUNK = 200; // contractions per wasm call — small enough that TURBO_MAX_STEPS_PER_FRAME actually paces the reflows
const TURBO_MAX_STEPS_PER_FRAME = 400; // cap steps/frame so a fast reduction shows as a few dramatic reflows, not one jump
const TURBO_GAP = 36; // ms between reflows — paced so the churn is *perceptible* (vs ~8ms = looks instant) yet far faster than one tween/step
const TURBO_RENDER_SKIP_NODES = 12_000; // past this working size, don't reflow the (huge) intermediate every frame — keep reducing it undrawn
const TURBO_DISPLAY_MAX = 6_000; // a normal form bigger than this is too deep to lay out / read out (recursive view walks) — don't draw it
// Auto-switch thresholds (measured: see docs/perf-spike-findings.md). The wasm fixed overhead
// is ~0.03 ms; for cheap reductions it wins from ~300 nodes but only ~1.5-2× (sub-ms either
// way → a wash), and LOSES past ~5000 nodes (encode cost). For EXPENSIVE reductions it wins
// 50-3000×, but those start tiny and BALLOON — so tree size is a poor predictor and the real
// trigger is the tree growing (the mid-reduction upgrade). 600 = the view's jump-cut threshold
// (no per-step animation is lost above it), which the data shows is a fine size cutoff.
const TURBO_MIN_NODES = 600;
// A TS reduction that has ground through this many steps without finishing is "struggling"
// (heading for the STEP_CAP=2000 pause); hand it to the wasm engine instead — catches the
// many-steps / bounded-small-tree case the size gate misses, and lets it finish vs pausing.
const TURBO_MIN_STEPS = 1200;
const TURBO_CAP = 20_000_000; // non-termination guard (raw needs far more steps than STEP_CAP)
const TURBO_EXPLODE_NODES = 2_000_000; // a raw term blowing up (e.g. Scott arithmetic) — pause instead of choking
const FINISH_PROBE_MAX = 150; // skip the catalog/quest/golf probes on a normal form (or source) bigger than this — they'd reduce it (too slow), and a big result isn't a bird/puzzle solution


export type Transport = "play" | "pause" | "ff" | "max";

// `source` is the tree as the player built/edited it (captured on release), before
// reduction mutates it — the golf metric + challenge target score the source, not its NF.
// `stash` is the next raw-TS contractum, precomputed while a 3D morph plays (pipeline depth 1) so the
// animation's time isn't wasted; keyed by `from` (must still equal tree.node) so a mode/term change
// discards it. Raw path only — graph/turbo mutate their engines, so we never run them ahead.
type AutoState = { gen: number; timer: number; steps: number; source?: Node; grapher?: GraphReducer; session?: WasmSession | null; stash?: { from: Node; next: Node; sym: string | null }; work?: Node };

/** What the reduction loop needs from the shell. */
export interface ReductionDeps {
  getFast: () => boolean; // optimize mode (reduce by rule, not raw SKI)
  getShare: () => boolean; // graph (call-by-need) mode
  getNative: () => NativeOpts | undefined; // native value ops
  getTurbo: () => boolean; // Turbo (wasm) toggle
  /** Build a resident wasm session for a term, or null if wasm isn't loaded yet. */
  makeSession: (term: Node) => WasmSession | null;
  /** The focused tree if it is still live on the canvas, else null. */
  focusedLive: () => TreeView | null;
  settle: (tree: TreeView) => void; // recognise + collapse a normal form
  onNormalForm: (source: Node) => void; // golf + quest progression
  tickSound: (sym: string | null) => void; // a tone per contraction (null = no rule)
  notify: (msg: string) => void; // toast
  onTransportChange: () => void; // repaint the menu + transport bar
  /** A raw/optimize term ballooned past the render cap: enable graph reduction (call-by-need sharing
   *  → no blow-up) and continue THIS tree there. Silent — no toast. */
  onBalloon: (tree: TreeView) => void;
  /** Mirror a focused tree's step into the 3D view (plan 06) — a no-op unless 3D is open + tree is focused. */
  morph3D?: (tree: TreeView, node: Node, durationMS: number) => void;
  /** Settle any in-flight 3D morph (called when the 2D reducer is paused, which stop-animates trees). */
  settleMorph3D?: () => void;
  /** True when 3D is open AND `tree` is the focused tree — so its playback should pace to the 3D morph
   *  (the 2D view is hidden in 3D mode, so its jump-cut timing must not drive the visible cadence). */
  is3DPacing?: (tree: TreeView) => boolean;
  /** True while a 3D reduction-step morph is actually animating (vs settled/snapped). */
  morph3DActive?: () => boolean;
}

// Speed levels 0-4 (the game-mode `0`-`4` keys): 0 = pause, then the running multiplier.
// `ff` is level 3 (4×), so the legacy Pause/Play/Fast-forward still line up.
const SPEED_MULT = [1, 1, 2, 4, 8]; // index = level (0 maps to pause, so its mult is unused)
const FF_MULT = 3; // "ff" transport multiplier → ≈ 3 reductions/s (Play ×3)
const MAX_MULT = 32; // "max" transport (▶▶▶) — uncapped feel: ≈ 1 step every couple of frames
const LEVEL_OF_MULT: Record<number, number> = { 1: 1, 2: 2, 4: 3, 8: 4 };

export class ReductionController {
  private readonly auto = new Map<TreeView, AutoState>();
  private transport: Transport = "play"; // trees reduce on their own; auto-pauses if a term won't terminate or blows up
  private mult = 1; // running speed multiplier (set by play/ff or setSpeedLevel); read live so speed changes are seamless
  // Background estimate of the focused tree's total contractions, for the progress bar (plan 02).
  private readonly estimator = new ReductionEstimator();
  private estimateTree: TreeView | null = null;

  constructor(private readonly deps: ReductionDeps) {}

  /** The focused tree's reduction progress for the bar: its estimate + how far it's played. */
  get estimate(): EstimateState {
    return this.estimateTree && this.estimateTree === this.deps.focusedLive() ? this.estimator.state : { kind: "idle" };
  }
  /** Contractions the visible reducer has played on the focused tree so far. */
  focusedSteps(): number {
    const f = this.deps.focusedLive();
    return f ? (this.auto.get(f)?.steps ?? 0) : 0;
  }
  /** (Re)start the background estimate for `tree` if it is the focused one (same-mode → exact), keyed
   *  to the term + mode at this moment so the bar's numerator (steps from here) shares its baseline. */
  private refreshEstimate(tree: TreeView): void {
    if (tree !== this.deps.focusedLive()) return;
    this.estimateTree = tree;
    this.estimator.estimate(tree.node, { fast: this.deps.getFast(), native: this.deps.getNative(), share: this.deps.getShare(), turbo: this.deps.getTurbo() });
  }

  // The live speed multiplier (1× … 8×); only resuming from pause re-kicks the loop.
  private speed(): number {
    return this.mult;
  }
  private stepDur(): number {
    return STEP_MS / this.speed();
  }
  private stepGap(): number {
    return STEP_GAP / this.speed();
  }
  // Big trees jump-cut, so pace them at a short fixed gap (still yields); small use the speed
  // gap. The multiplier speeds the jump-cut too, so a high level actually accelerates big trees.
  private nextGap(t: TreeView): number {
    return t.heavy() ? Math.max(1, HEAVY_GAP / this.mult) : this.stepGap();
  }
  // A focused tree whose 3D morph is still animating must wait — advancing the visible state now
  // would cut the morph short (in 3D the 2D view is hidden, so the morph IS the visible step). True
  // only when 3D is open, this tree is focused, and a morph is actually in flight.
  private morphPacing(tree: TreeView): boolean {
    return !!(this.deps.is3DPacing?.(tree) && this.deps.morph3DActive?.());
  }
  // Turbo reflow gap + steps-per-reflow, scaled by the speed level (faster + bigger jumps).
  private turboGap(): number {
    return Math.max(4, TURBO_GAP / this.mult);
  }
  private turboStepsPerFrame(): number {
    return TURBO_MAX_STEPS_PER_FRAME * this.mult;
  }

  /** Forget a tree entirely (it was deleted from the canvas): cancel its loop first so no
   *  pending timer fires on a destroyed tree, then drop its state. */
  forget(tree: TreeView): void {
    this.cancel(tree);
    if (this.estimateTree === tree) {
      this.estimateTree = null;
      this.estimator.cancel(); // stop counting a removed tree's (possibly ballooning) reduction
    }
    this.auto.delete(tree);
  }

  // Turbo (the wasm graph engine) does call-by-need sharing + the number/list/bool kernels,
  // but not the catalog rules (fast mode) or the graph-mode driver — so it's eligible when
  // those are off; any native-value toggle may be on (the wasm kernels handle them).
  // `makeSession` returns null until the wasm has loaded → transparent fallback to TS then.
  private turboEligible(): boolean {
    return this.deps.getTurbo() && !this.deps.getShare() && !this.deps.getFast();
  }
  // Auto-switch: engage the wasm engine once a tree is BIG (the TS reducer is plenty fast on
  // small trees AND gives the pretty per-step animation) OR a reduction is STRUGGLING (many
  // steps, not done — a small tree that balloons, or a many-step bounded reduction). A small
  // tree that crosses either threshold upgrades mid-reduction (see `stepAuto`).
  private wantsTurbo(tree: TreeView, steps = 0): boolean {
    return this.turboEligible() && (steps >= TURBO_MIN_STEPS || exceedsNodes(tree.node, TURBO_MIN_NODES));
  }
  // Build (once) the resident wasm session for a tree that has become turbo-worthy.
  private engageTurbo(tree: TreeView, a: AutoState): boolean {
    if (!a.session) a.session = this.deps.makeSession(tree.node);
    return !!a.session;
  }

  private freeSession(a: AutoState): void {
    a.session?.free();
    a.session = null;
  }

  /** Stop a tree's reduction loop + animation (called on touch / delete). */
  cancel(tree: TreeView): void {
    const a = this.auto.get(tree);
    if (a) {
      a.gen++;
      clearTimeout(a.timer);
      a.stash = undefined; // drop any precomputed look-ahead (the term/mode is about to change)
      this.freeSession(a); // release the wasm arena
    }
    tree.stopAnimation();
  }

  /** Begin (or restart) a tree reducing on its own after the idle delay. */
  schedule(tree: TreeView): void {
    let a = this.auto.get(tree);
    if (!a) {
      a = { gen: 0, timer: 0, steps: 0 };
      this.auto.set(tree, a);
    }
    a.gen++;
    a.steps = 0;
    a.stash = undefined; // a fresh run — no stale look-ahead from the previous term/mode
    a.work = undefined; // no carried-over background-reduced term
    a.source = tree.node; // score the tree as built, before reduction
    this.freeSession(a); // drop any prior resident session
    a.grapher = this.deps.getShare() ? new GraphReducer(tree.node, this.deps.getFast()) : undefined;
    // Turbo: for an already-big tree, drive it with the resident wasm session; a small tree
    // keeps the per-step TS playback and upgrades later if it grows (see `stepAuto`).
    const turbo = this.wantsTurbo(tree) && this.engageTurbo(tree, a);
    const gen = a.gen;
    const tick = turbo ? () => this.turboTick(tree, gen) : () => this.stepAuto(tree, gen);
    a.timer = window.setTimeout(tick, AUTO_DELAY);
    this.refreshEstimate(tree); // kick the background total-count estimate for the bar (focused tree only)
  }

  // Turbo loop: spend a wall-clock budget running resident wasm contractions, then reflow
  // the tree once to the snapshot (jump-cut for big trees). Coalesces many reductions per
  // visible frame, so a big raw program churns fast instead of one slow tween per step.
  private turboTick(tree: TreeView, gen: number): void {
    const a = this.auto.get(tree);
    if (!a || a.gen !== gen) return;
    if (this.transport === "pause") return;
    const s = a.session;
    if (!s) {
      this.stepAuto(tree, gen); // session gone — fall back to the TS path
      return;
    }
    if (this.morphPacing(tree)) {
      a.timer = window.setTimeout(() => this.turboTick(tree, gen), MORPH_POLL_MS); // wait out the 3D morph
      return;
    }
    // Run contractions resident until the frame budget is spent — but cap the steps per
    // frame so a fast reduction is shown as a few dramatic reflows, not one instant jump.
    const start = performance.now();
    const startSteps = s.totalSteps;
    const stepsPerFrame = this.turboStepsPerFrame();
    while (performance.now() - start < TURBO_BUDGET_MS && s.totalSteps - startSteps < stepsPerFrame) {
      const n = s.stepBudget(TURBO_CHUNK);
      if (s.isDone || n === 0) break;
      if (s.nodeCount > TURBO_EXPLODE_NODES) {
        this.freeSession(a); // abandon the doomed reduction — don't resume it
        this.autoPause("term is exploding — try the Native/Optimize options for arithmetic");
        return;
      }
    }
    a.steps = s.totalSteps;
    if (a.steps >= TURBO_CAP) {
      this.freeSession(a); // gave up — drop the session so resume doesn't grind on
      this.autoPause(`won't settle after ${a.steps} steps`);
      return;
    }
    const done = s.isDone;
    // Reflow only when the current term is renderable (or finished). A ballooning
    // intermediate (e.g. Scott arithmetic) is too big to draw every frame — keep reducing
    // it resident, undrawn, and reflow once it resolves or reaches its normal form.
    const reschedule = (): void => {
      const a2 = this.auto.get(tree);
      if (!a2 || a2.gen !== gen || this.transport === "pause") return;
      a2.timer = window.setTimeout(() => this.turboTick(tree, gen), this.turboGap());
    };
    if (!done && s.nodeCount > TURBO_RENDER_SKIP_NODES) {
      reschedule(); // big intermediate — skip the (expensive) reflow, keep churning
      return;
    }
    const snap = s.snapshot(); // iterative decode (safe on a deep result), compacts the arena
    // A normal form too deep/large to lay out + draw (e.g. a huge Scott numeral) — the view's
    // recursive layout/read-out would blow the stack. Don't draw it; finish (the value lens
    // still reads bounded numerals) or, if still reducing, keep churning undrawn.
    if (exceedsNodes(snap, TURBO_DISPLAY_MAX)) {
      if (done) {
        this.deps.notify(`reduced in ${s.totalSteps} steps — result too large to draw`);
        this.freeSession(a);
      } else {
        reschedule();
      }
      return;
    }
    this.stepTo(tree, snap, () => {
      const a2 = this.auto.get(tree);
      if (!a2 || a2.gen !== gen) return;
      if (this.transport === "pause") return;
      if (done) {
        this.finishNormalForm(tree, a2);
        this.freeSession(a2);
        return;
      }
      a2.timer = window.setTimeout(() => this.turboTick(tree, gen), this.turboGap());
    });
  }

  // Auto-pause (with a toast) when a tree won't settle within its step budget.
  private autoPause(reason: string): void {
    this.setTransport("pause");
    this.deps.notify(`auto-paused — ${reason}`);
  }

  // A tree reached normal form: recognise + collapse it, then score it (golf + quest).
  // Shared by the auto loop and the manual Step button so both record solves.
  private finishNormalForm(tree: TreeView, a: AutoState): void {
    // settle() recognises the NF against the catalog; onNormalForm() runs the quest/golf
    // checks on the source. Both REDUCE the term, unbounded over a big one, so each is gated
    // by its OWN operand's size (a big result isn't a bird; a big source isn't a puzzle
    // solution) — independently, so a small NF from a big source still settles, and vice
    // versa. `recognize`/the quest engine are also internally size-guarded as a backstop.
    if (!exceedsNodes(tree.node, FINISH_PROBE_MAX)) this.deps.settle(tree);
    const source = a.source ?? tree.node;
    if (!exceedsNodes(source, FINISH_PROBE_MAX)) this.deps.onNormalForm(source);
  }

  // The auto-state for a tree, created (without a running timer) if missing — some focused
  // trees (e.g. spawned by the Haskell panel) were never scheduled.
  private ensureAuto(tree: TreeView): AutoState {
    let a = this.auto.get(tree);
    if (!a) {
      a = { gen: 0, timer: 0, steps: 0, source: tree.node };
      this.auto.set(tree, a);
    }
    return a;
  }

  // Animate a focused tree's step in 2D and mirror it into the 3D view (plan 06). One snapshot,
  // one duration for both; morph3D is a no-op unless 3D is open on this tree.
  private stepTo(tree: TreeView, node: Node, onDone: () => void): void {
    const dur = this.stepDur();
    this.deps.morph3D?.(tree, node, dur);
    tree.animateTo(node, dur, onDone);
  }

  private stepAuto(tree: TreeView, gen: number): void {
    const a = this.auto.get(tree);
    if (!a || a.gen !== gen) return;
    if (this.transport === "pause") return; // frozen — resume re-kicks from setTransport
    const share = this.deps.getShare();
    const fast = this.deps.getFast();
    // A big ballooning raw/optimize term reduces in the BACKGROUND (budgeted + yielding) rather than
    // paying an O(n) layout+edge reflow every step — the per-step reflow is what freezes the UI on a
    // 14k-node quicksort intermediate. Graph mode (share) already does cheap shared steps, so it's out.
    if (!share && exceedsNodes(tree.node, HEAVY_RENDER_CAP)) return this.stepHeavyTs(tree, gen);
    // Pace to the 3D morph: while it animates, don't advance the visible state — but use that time to
    // precompute the next RAW contractum (pipeline depth 1), so the cadence stays full once it ends.
    if (this.morphPacing(tree)) {
      // Plain raw TS only: fast/native build() can run kernel value-matching (normalize) on the main
      // thread — exactly the work that would hitch the morph we're pacing for. Those modes (and
      // graph/turbo) just compute the step when the morph ends, no look-ahead.
      if (!share && !fast && !this.deps.getNative() && !a.session && !a.stash) {
        const r = redexAt(tree.node, 0, fast, this.deps.getNative()); // fast/native are falsy here → plain raw redex
        if (r) a.stash = { from: tree.node, next: r.build(), sym: r.sym };
      }
      a.timer = window.setTimeout(() => this.stepAuto(tree, gen), MORPH_POLL_MS);
      return;
    }
    // Non-termination guard. Graph mode shares, so it does far fewer, far cheaper steps and
    // can finish reductions the tree reducer can't (fac-scale) — give it a much higher ceiling.
    if (a.steps >= (share ? GRAPH_STEP_CAP : STEP_CAP)) {
      this.autoPause(share ? `no normal form after ${a.steps} steps` : `won't settle after ${a.steps} steps — try Graph reduction (Optimizations menu)`);
      return;
    }

    // Graph mode: step the shared graph and animate each snapshot.
    if (share) {
      if (!a.grapher) a.grapher = new GraphReducer(tree.node, fast);
      const g = a.grapher;
      if (!g.step()) {
        this.finishNormalForm(tree, a); // normal form
        return;
      }
      this.deps.tickSound(firingRule(tree.node, fast)); // a tone per contraction (approx)
      a.steps = g.steps;
      this.stepTo(tree, g.snapshot(), () => {
        const a2 = this.auto.get(tree);
        if (!a2 || a2.gen !== gen) return;
        if (this.transport === "pause") return;
        a2.timer = window.setTimeout(() => this.stepAuto(tree, gen), this.nextGap(tree));
      });
      return;
    }
    a.grapher = undefined; // optimize/raw path: no live graph

    // One traversal yields both the rule to sonify and the contractum to animate — unless the morph
    // pacer already precomputed it (stash), in which case reuse it (still valid only if from === now).
    const stashed = a.stash && a.stash.from === tree.node ? a.stash : undefined;
    a.stash = undefined;
    let next: Node;
    let sym: string | null;
    if (stashed) {
      next = stashed.next;
      sym = stashed.sym;
    } else {
      const redex = redexAt(tree.node, 0, fast, this.deps.getNative());
      if (!redex) {
        this.finishNormalForm(tree, a); // normal form reached — recognise, collapse, score
        return;
      }
      next = redex.build(); // build before the side effects (sound/step count)
      sym = redex.sym;
    }
    this.deps.tickSound(sym); // sonify the rule about to fire
    a.steps++;
    this.stepTo(tree, next, () => {
      const a2 = this.auto.get(tree);
      if (!a2 || a2.gen !== gen) return;
      if (this.transport === "pause") return; // paused mid-tween — stop scheduling
      // Auto-upgrade: a tree that has grown big (or a reduction grinding many steps) hands off
      // to the wasm engine instead of continuing the per-step TS path.
      if (this.wantsTurbo(tree, a2.steps) && this.engageTurbo(tree, a2)) {
        a2.timer = window.setTimeout(() => this.turboTick(tree, gen), this.turboGap());
      } else {
        a2.timer = window.setTimeout(() => this.stepAuto(tree, gen), this.nextGap(tree));
      }
    });
  }

  /** Reduce a term too big to reflow every step ({@link HEAVY_RENDER_CAP}): build contractions in short
   *  budgeted batches WITHOUT a reflow, yielding to the renderer between batches, and only reflow once the
   *  term is small enough to draw in a frame — or reaches normal form. Keeps the UI live + the estimate
   *  bar moving through a huge ballooning reduction (quicksort) instead of freezing on a per-step O(n)
   *  layout+edge rebuild. Re-enters {@link stepAuto} once the term is renderable, so it animates normally. */
  private stepHeavyTs(tree: TreeView, gen: number): void {
    const a = this.auto.get(tree);
    if (!a || a.gen !== gen) return;
    if (this.transport === "pause") return;
    if (this.morphPacing(tree)) {
      a.timer = window.setTimeout(() => this.stepHeavyTs(tree, gen), MORPH_POLL_MS);
      return;
    }
    const fast = this.deps.getFast();
    const native = this.deps.getNative();
    let node = a.work ?? tree.node;
    if (exceedsNodes(node, BALLOON_CAP)) {
      a.work = undefined;
      this.deps.onBalloon(tree); // auto-switch to graph reduction (shares → no blow-up), no toast
      return;
    }
    let sym: string | null = null;
    let nf = false;
    const start = performance.now();
    do {
      if (a.steps >= STEP_CAP) {
        a.work = undefined;
        this.autoPause(`won't settle after ${a.steps} steps — try Graph reduction (Optimizations menu)`);
        return;
      }
      const redex = redexAt(node, 0, fast, native);
      if (!redex) {
        nf = true;
        break;
      }
      node = redex.build();
      sym = redex.sym;
      a.steps++;
      if (!exceedsNodes(node, HEAVY_RENDER_CAP)) break; // dropped below the cap → reflow this batch
    } while (performance.now() - start < HEAVY_TS_BUDGET_MS);
    this.deps.tickSound(sym); // one tone for the batch — a heavy term can't sonify every contraction
    if (!nf && exceedsNodes(node, HEAVY_RENDER_CAP)) {
      a.work = node; // still too big to draw — keep reducing it in the background, yielding each batch
      a.timer = window.setTimeout(() => this.stepHeavyTs(tree, gen), 0);
      return;
    }
    a.work = undefined;
    this.stepTo(tree, node, () => {
      const a2 = this.auto.get(tree);
      if (!a2 || a2.gen !== gen) return;
      if (this.transport === "pause") return;
      if (nf) {
        this.finishNormalForm(tree, a2);
        return;
      }
      a2.timer = window.setTimeout(() => this.stepAuto(tree, gen), this.nextGap(tree));
    });
  }

  /** Step: pause, then advance the focused tree by exactly one reduction (no reschedule).
   *  An action, not a transport mode. No-op if nothing is focused. */
  stepOnce(): void {
    this.setTransport("pause"); // single-stepping implies the auto-run is stopped
    const tree = this.deps.focusedLive();
    if (!tree) return;
    const a = this.ensureAuto(tree);
    const fast = this.deps.getFast();
    if (this.deps.getShare()) {
      if (!a.grapher) a.grapher = new GraphReducer(tree.node, fast);
      if (!a.grapher.step()) {
        this.finishNormalForm(tree, a);
        return;
      }
      this.deps.tickSound(firingRule(tree.node, fast));
      a.steps = a.grapher.steps;
      this.stepTo(tree, a.grapher.snapshot(), () => {});
    } else {
      a.grapher = undefined;
      const redex = redexAt(tree.node, 0, fast, this.deps.getNative());
      if (!redex) {
        this.finishNormalForm(tree, a);
        return;
      }
      this.deps.tickSound(redex.sym);
      a.steps++;
      this.stepTo(tree, redex.build(), () => {});
    }
  }

  /** Switch playback mode. Pause freezes every tree; resuming re-kicks the ones that still
   *  have a reduction left (settled trees stay put). play↔ff↔max needs no re-kick — the running
   *  loop reads `mult` live. play ≈ 1 red/s, ff ≈ 3/s, max ≈ as-fast-as-it-animates. */
  setTransport(mode: Transport): void {
    const wasPaused = this.transport === "pause";
    this.transport = mode;
    if (mode === "play") this.mult = 1;
    else if (mode === "ff") this.mult = FF_MULT;
    else if (mode === "max") this.mult = MAX_MULT;
    this.deps.onTransportChange();
    if (mode === "pause") this.pauseAll();
    else if (wasPaused) this.resumeAll();
  }

  /** Set the reduction speed by level 0-4 (the game-mode `0`-`4` keys): 0 = pause, 1 = 1×,
   *  2 = 2×, 3 = 4×, 4 = 8×. Reflects in the transport (ff when >1×) so the menu/bar agree. */
  setSpeedLevel(level: number): void {
    const n = Math.max(0, Math.min(4, Math.round(level)));
    if (n === 0) return this.setTransport("pause");
    const wasPaused = this.transport === "pause";
    this.mult = SPEED_MULT[n];
    this.transport = this.mult > 1 ? "ff" : "play"; // keep the menu/bar highlight sensible
    this.deps.onTransportChange();
    if (wasPaused) this.resumeAll();
  }

  /** The current speed level 0-4 (0 = paused). */
  get speedLevel(): number {
    return this.transport === "pause" ? 0 : (LEVEL_OF_MULT[this.mult] ?? 1);
  }

  // Freeze every tree (cancel its timer + animation).
  private pauseAll(): void {
    for (const [tree, a] of this.auto) {
      clearTimeout(a.timer);
      tree.stopAnimation();
    }
    this.deps.settleMorph3D?.(); // the focused tree's 3D morph snaps too, so 2D + 3D freeze together
  }
  // Re-kick every tree that still has a reduction left (a resident session, or a TS redex).
  private resumeAll(): void {
    for (const [tree, a] of this.auto) {
      if (a.session && !a.session.isDone) {
        // a resident turbo reduction in flight — continue it (the session holds the state)
        a.gen++;
        const gen = a.gen;
        a.timer = window.setTimeout(() => this.turboTick(tree, gen), 0);
      } else if (redexAt(tree.node, 0, this.deps.getFast(), this.deps.getNative())) {
        a.steps = 0; // explicit resume = "keep going" → a fresh budget before auto-pause re-trips
        this.refreshEstimate(tree); // re-count from here so the bar's numerator + denominator share a baseline
        a.gen++;
        const gen = a.gen;
        a.timer = window.setTimeout(() => this.stepAuto(tree, gen), 0);
      }
    }
  }

  /** Cycle Pause → Play → Fast-forward → Pause. */
  cycleTransport(): void {
    this.setTransport(this.transport === "pause" ? "play" : this.transport === "play" ? "ff" : this.transport === "ff" ? "max" : "pause");
  }

  /** The current transport mode (read by the bar + permalink + dev seam). */
  get mode(): Transport {
    return this.transport;
  }

  /** The playback modes the transport bar shows, slowest → fastest (Step is a separate action). */
  transportModes(): Transport[] {
    return ["pause", "play", "ff", "max"];
  }

  /** Total contractions across all live trees (the reduction-rate read-out + dev seam). */
  totalSteps(): number {
    let s = 0;
    for (const a of this.auto.values()) s += a.steps;
    return s;
  }

  /** Drop every live grapher (they bake `fast` at construction; the optimize toggle changed). */
  invalidateGraphers(): void {
    for (const a of this.auto.values()) a.grapher = undefined;
  }

  /** Drop every resident wasm session (the Turbo toggle / a raw-mode option changed, so the
   *  next schedule re-decides turbo vs TS). */
  invalidateSessions(): void {
    for (const a of this.auto.values()) this.freeSession(a);
  }
}

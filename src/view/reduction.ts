/**
 * The auto-reduce + transport subsystem, extracted from app.ts (reorg, ADR 12). Owns the
 * per-tree reduction loop (each settled tree plays itself to normal form one tween at a
 * time, cancelled on touch), the playback transport (play / pause / fast-forward), the
 * non-termination guard, and the graph-mode lifecycle. Pure-ish imperative shell: the Pixi
 * side effects (the reduction flourish, the transport bar) stay in app.ts and are injected
 * as callbacks, so this is the state machine, not the chrome.
 */
import { firingRule, redexAt } from "../core/reduce";
import { GraphReducer } from "../core/graph";
import { type Node, exceedsNodes } from "../core/term";
import { type NativeOpts } from "../core/native";
import { type TreeView } from "./tree";
import { type WasmSession } from "./wasmReducer";

const AUTO_DELAY = 450; // ms a tree must sit untouched before it starts reducing (§6.4)
const STEP_MS = 300; // duration of one reduction-step tween
const STEP_GAP = 130; // pause between reduction steps
const HEAVY_GAP = 8; // big trees jump-cut each step; pace them fast but still yield to the renderer (≠ 0, which starves rAF)
const STEP_CAP = 2000; // non-termination guard: stop auto-reducing past this many steps
const GRAPH_STEP_CAP = 100_000; // graph mode shares (cheap steps) — let fac-scale reductions finish

// ---- Turbo (wasm) playback: run many resident contractions per visible frame, so a big
// raw tree reduces fast even when the renderer can't keep up with one tween per step. ----
const TURBO_BUDGET_MS = 12; // wall-clock spent stepping in wasm before each reflow (yields the rest of the frame to render)
const TURBO_CHUNK = 200; // contractions per wasm call — small enough that TURBO_MAX_STEPS_PER_FRAME actually paces the reflows
const TURBO_MAX_STEPS_PER_FRAME = 400; // cap steps/frame so a fast reduction shows as a few dramatic reflows, not one jump
const TURBO_GAP = 36; // ms between reflows — paced so the churn is *perceptible* (vs ~8ms = looks instant) yet far faster than one tween/step
const TURBO_RENDER_SKIP_NODES = 12_000; // past this working size, don't reflow the (huge) intermediate every frame — keep reducing it undrawn
const TURBO_CAP = 20_000_000; // non-termination guard (raw needs far more steps than STEP_CAP)
const TURBO_EXPLODE_NODES = 2_000_000; // a raw term blowing up (e.g. Scott arithmetic) — pause instead of choking
const FINISH_PROBE_MAX = 150; // skip the catalog/quest/golf probes on a normal form (or source) bigger than this — they'd reduce it (too slow), and a big result isn't a bird/puzzle solution


export type Transport = "play" | "pause" | "ff";

// `source` is the tree as the player built/edited it (captured on release), before
// reduction mutates it — the golf metric + challenge target score the source, not its NF.
type AutoState = { gen: number; timer: number; steps: number; source?: Node; grapher?: GraphReducer; session?: WasmSession | null };

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
  flourish: (tree: TreeView) => void; // the redex-ants ripple (Pixi, in app)
  notify: (msg: string) => void; // toast
  onTransportChange: () => void; // repaint the menu + transport bar
}

export class ReductionController {
  private readonly auto = new Map<TreeView, AutoState>();
  private transport: Transport = "play"; // trees reduce on their own; auto-pauses if a term won't terminate or blows up

  constructor(private readonly deps: ReductionDeps) {}

  // Speed is read live, so play↔ff is seamless; only resuming from pause re-kicks the loop.
  private speed(): number {
    return this.transport === "ff" ? 3 : 1;
  }
  private stepDur(): number {
    return STEP_MS / this.speed();
  }
  private stepGap(): number {
    return STEP_GAP / this.speed();
  }
  // Big trees jump-cut, so pace them at a short fixed gap (still yields); small use the speed gap.
  private nextGap(t: TreeView): number {
    return t.heavy() ? HEAVY_GAP : this.stepGap();
  }

  /** Forget a tree entirely (it was deleted from the canvas): cancel its loop first so no
   *  pending timer fires on a destroyed tree, then drop its state. */
  forget(tree: TreeView): void {
    this.cancel(tree);
    this.auto.delete(tree);
  }

  // Turbo is raw-only: it doesn't know rules / native ops / graph sharing, so it's eligible
  // only when those are all off (else fall back to the TS reducer). `makeSession` returns
  // null until the wasm has loaded, so we transparently fall back then too.
  private turboEligible(): boolean {
    return this.deps.getTurbo() && !this.deps.getShare() && !this.deps.getFast() && !this.deps.getNative();
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
    a.source = tree.node; // score the tree as built, before reduction
    this.freeSession(a); // drop any prior resident session
    a.grapher = this.deps.getShare() ? new GraphReducer(tree.node, this.deps.getFast()) : undefined;
    // Turbo: build a resident wasm session up front; if it succeeds, the turbo loop drives
    // this tree instead of the per-step path. Null (wasm not loaded) → normal playback.
    a.session = this.turboEligible() ? this.deps.makeSession(tree.node) : null;
    const gen = a.gen;
    const tick = a.session ? () => this.turboTick(tree, gen) : () => this.stepAuto(tree, gen);
    a.timer = window.setTimeout(tick, AUTO_DELAY);
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
    // Run contractions resident until the frame budget is spent — but cap the steps per
    // frame so a fast reduction is shown as a few dramatic reflows, not one instant jump.
    const start = performance.now();
    const startSteps = s.totalSteps;
    while (performance.now() - start < TURBO_BUDGET_MS && s.totalSteps - startSteps < TURBO_MAX_STEPS_PER_FRAME) {
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
      a2.timer = window.setTimeout(() => this.turboTick(tree, gen), TURBO_GAP);
    };
    if (!done && s.nodeCount > TURBO_RENDER_SKIP_NODES) {
      reschedule(); // big intermediate — skip the (expensive) reflow, keep churning
      return;
    }
    const snap = s.snapshot();
    this.deps.flourish(tree);
    tree.animateTo(snap, this.stepDur(), () => {
      const a2 = this.auto.get(tree);
      if (!a2 || a2.gen !== gen) return;
      if (this.transport === "pause") return;
      if (done) {
        this.finishNormalForm(tree, a2);
        this.freeSession(a2);
        return;
      }
      a2.timer = window.setTimeout(() => this.turboTick(tree, gen), TURBO_GAP);
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

  private stepAuto(tree: TreeView, gen: number): void {
    const a = this.auto.get(tree);
    if (!a || a.gen !== gen) return;
    if (this.transport === "pause") return; // frozen — resume re-kicks from setTransport
    const share = this.deps.getShare();
    const fast = this.deps.getFast();
    // Non-termination guard. Graph mode shares, so it does far fewer, far cheaper steps and
    // can finish reductions the tree reducer can't (fac-scale) — give it a much higher ceiling.
    if (a.steps >= (share ? GRAPH_STEP_CAP : STEP_CAP)) {
      this.autoPause(share ? `no normal form after ${a.steps} steps` : `won't settle after ${a.steps} steps — try Graph reduction (Reduce menu)`);
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
      this.deps.flourish(tree);
      tree.animateTo(g.snapshot(), this.stepDur(), () => {
        const a2 = this.auto.get(tree);
        if (!a2 || a2.gen !== gen) return;
        if (this.transport === "pause") return;
        a2.timer = window.setTimeout(() => this.stepAuto(tree, gen), this.nextGap(tree));
      });
      return;
    }
    a.grapher = undefined; // optimize/raw path: no live graph

    // One traversal yields both the rule to sonify and the contractum to animate.
    const redex = redexAt(tree.node, 0, fast, this.deps.getNative());
    if (!redex) {
      this.finishNormalForm(tree, a); // normal form reached — recognise, collapse, score
      return;
    }
    const next = redex.build(); // build before the side effects (sound/step count)
    this.deps.tickSound(redex.sym); // sonify the rule about to fire
    a.steps++;
    this.deps.flourish(tree);
    tree.animateTo(next, this.stepDur(), () => {
      const a2 = this.auto.get(tree);
      if (!a2 || a2.gen !== gen) return;
      if (this.transport === "pause") return; // paused mid-tween — stop scheduling
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
      this.deps.flourish(tree);
      tree.animateTo(a.grapher.snapshot(), this.stepDur(), () => {});
    } else {
      a.grapher = undefined;
      const redex = redexAt(tree.node, 0, fast, this.deps.getNative());
      if (!redex) {
        this.finishNormalForm(tree, a);
        return;
      }
      this.deps.tickSound(redex.sym);
      a.steps++;
      this.deps.flourish(tree);
      tree.animateTo(redex.build(), this.stepDur(), () => {});
    }
  }

  /** Switch playback mode. Pause freezes every tree; resuming re-kicks the ones that still
   *  have a reduction left (settled trees stay put). play↔ff needs no re-kick. */
  setTransport(mode: Transport): void {
    const wasPaused = this.transport === "pause";
    this.transport = mode;
    this.deps.onTransportChange();
    if (mode === "pause") {
      for (const [tree, a] of this.auto) {
        clearTimeout(a.timer);
        tree.stopAnimation();
      }
    } else if (wasPaused) {
      for (const [tree, a] of this.auto) {
        if (a.session && !a.session.isDone) {
          // a resident turbo reduction in flight — continue it (the session holds the state)
          a.gen++;
          const gen = a.gen;
          a.timer = window.setTimeout(() => this.turboTick(tree, gen), 0);
        } else if (redexAt(tree.node, 0, this.deps.getFast(), this.deps.getNative())) {
          a.steps = 0; // explicit resume = "keep going" → a fresh budget before auto-pause re-trips
          a.gen++;
          const gen = a.gen;
          a.timer = window.setTimeout(() => this.stepAuto(tree, gen), 0);
        }
      }
    }
  }

  /** Cycle Pause → Play → Fast-forward → Pause. */
  cycleTransport(): void {
    this.setTransport(this.transport === "pause" ? "play" : this.transport === "play" ? "ff" : "pause");
  }

  /** The current transport mode (read by the bar + permalink + dev seam). */
  get mode(): Transport {
    return this.transport;
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

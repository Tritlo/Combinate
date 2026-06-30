/**
 * The read-out lens (ADR 12): the per-frame driver behind the top-centre read-out box. It reads the
 * focused tree's *current* term every frame and renders it in the box's active view:
 *
 *  - **ski** (default) — `exprOf`: the combinator s-expression of the current term, masking
 *    undiscovered S/K/I. No reduction, so it never runs ahead of the on-screen reducer (this is what
 *    "show the current state" means — e.g. `map (+1) [1,2,3]` stays itself until the tree visibly
 *    reduces, instead of jumping to `[2,3,4]`).
 *  - **named** — the only evaluating view: the value probe (`read`/`render` → native ints / lists /
 *    bools / chars) with the combinator residual named by the re-folder (egg, behavioural fallback).
 *    An explicit "what does this evaluate to" lens. The HM type badge (opt-in) appends here.
 *  - **barker** — the raw Barker ι bit-code (`1` = ι, `0 <fn> <arg>` = app), bounded.
 *
 * The shell injects how to find the focused node + the active read page and owns the box placement.
 */
import { type Ticker } from "pixi.js";
import { sexp, decode, exceedsNodes, type Node } from "../core/term";
import { IOTA_CODE, barkerCode } from "../core/catalog";
import { makeRefolder, behavioralRefolder, type Refolder } from "../core/refold";
import { read, render, type Ty } from "../core/types";
import { inferType } from "../core/infer";
import { type ReadoutBox } from "./readoutBox";
import { type Toast } from "./toast";

/** What the read-out reads from the shell. */
export interface ReadoutDeps {
  ticker: Ticker;
  /** The shell-owned read-out box (chrome + view state). */
  box: ReadoutBox;
  /** The focused tree's term, or null when none is live. */
  focusNode: () => Node | null;
  /** The active hotbar page (drives the named view's data reading). */
  readPage: () => string;
  /** Whether a combinator is discovered (undiscovered S/K/I read as their ι-tree). */
  isDiscovered: (sym: string) => boolean;
  /** Refresh the menu checkmarks after a lens toggle. */
  onToggle: () => void;
  toast: Toast;
}

// The hotbar page → the data reading the named view forces.
const READ_AS: Record<string, Ty> = { Arithmetic: "Int", Booleans: "Bool", Lists: "List", Char: "Char" };

// Above this node count, skip the (reducing) value/type/re-fold probes in the named view — the raw
// s-expression is shown instead. The probes are internally size-bounded now (normalize's maxNodes),
// so this can be generous enough to read a big CLEAN numeral as its value (a Turbo result like
// (*) 20 20 = 400 is an ~800-node Succ-spine) without freezing on a term that would explode under
// probing (that bails via the size guard).
const READOUT_PROBE_MAX = 3000;

// The named view evaluates the term (read/normalize + re-fold) — O(nodes). While a term is actively
// reducing its node changes every step, and a (+) balloons to thousands of nodes mid-reduction, so
// re-evaluating per frame lags playback. Throttle the named recompute to this cadence while only the
// node is changing; ski/barker stay per-frame and a view/page/type change still recomputes at once.
const NAMED_MIN_INTERVAL = 120; // ms (~8 Hz)

export class ReadoutLens {
  // re-folding (used by the named view; behavioural pre-pass works without wasm)
  private refolder: Refolder | null = null;
  private refolderLoading = false;
  private refoldRaw: ((sexpr: string) => string) | null = null;
  private typeOn = false;
  // render memo: only repaint when the node / view / type / reading mode changes
  private lastNode: Node | null = null;
  private lastView: string | null = null;
  private lastType = false;
  private lastMode: Ty | undefined;
  private lastExpr = "";
  private lastNamedAt = 0; // last wall-clock the (evaluating) named view recomputed — for the throttle

  constructor(private readonly deps: ReadoutDeps) {
    deps.ticker.add(() => this.tick());
  }

  /** S-expression of a term; an undiscovered S/K/I shows as its full ι-tree (not its
   *  letter), matching the tree view, so the read-out never spoils a combinator. */
  exprOf(n: Node): string {
    switch (n.kind) {
      case "iota":
        return "ι";
      case "comb": {
        const code = !this.deps.isDiscovered(n.sym) ? IOTA_CODE[n.sym] : undefined;
        return code ? this.exprOf(decode(code)) : n.sym;
      }
      case "free":
        return n.name;
      case "app":
        return `(${this.exprOf(n.fn)} ${this.exprOf(n.arg)})`;
    }
  }

  // The per-frame render: switch on the active view FIRST, so the default (`ski`) and `barker`
  // paths never touch a normalizing probe — only the `named` view reduces.
  private tick(): void {
    const node = this.deps.focusNode();
    const view = this.deps.box.current;
    const mode = READ_AS[this.deps.readPage()];
    if (node === this.lastNode && view === this.lastView && this.typeOn === this.lastType && mode === this.lastMode) return;
    // Throttle the named view while ONLY the node is changing (i.e. mid-reduction) — see NAMED_MIN_INTERVAL.
    // A view/page/type change (anything but the node) skips the throttle and recomputes immediately.
    const onlyNodeChanged = view === this.lastView && this.typeOn === this.lastType && mode === this.lastMode;
    const now = performance.now();
    if (view === "named" && onlyNodeChanged && now - this.lastNamedAt < NAMED_MIN_INTERVAL) return; // recompute on a later frame; lastNode stays stale so the memo above won't swallow it
    this.lastNode = node;
    this.lastView = view;
    this.lastType = this.typeOn;
    this.lastMode = mode;
    let txt = "";
    if (node) {
      if (view === "ski") txt = this.exprOf(node);
      else if (view === "barker") txt = barkerCode(node);
      else {
        this.lastNamedAt = now;
        txt = this.named(node, mode);
      }
    }
    if (txt !== this.lastExpr) {
      this.lastExpr = txt;
      this.deps.box.setText(txt);
    }
  }

  // The named + native view: native value if the term reads as data, else the re-folded
  // (bird-named) term, else the raw combinator s-expression; with the optional type badge. Past the
  // node budget the reducing probes would freeze playback, so fall back to the raw expression.
  private named(node: Node, mode: Ty | undefined): string {
    if (!this.refolder) {
      this.refolder = behavioralRefolder; // instant pure-TS lens…
      void this.ensureRefolder(); // …upgraded with the egg stage when it loads
    }
    const big = exceedsNodes(node, READOUT_PROBE_MAX);
    const v = big ? null : read(node, mode ?? null);
    const value = v ? render(v) : null;
    const folded = !value && !big && this.refolder ? this.refolder(node) : null;
    let txt = value ?? (folded ? sexp(folded) : this.exprOf(node));
    if (this.typeOn) txt += `  ::  ${big ? "(tree too large to type)" : (inferType(node) ?? "no simple type")}`;
    return txt;
  }

  /** Force a read-out recompute on the next frame (after a view / mode / discovery change). */
  invalidate(): void {
    this.lastNode = null;
    this.lastView = null;
  }

  // Upgrade the named view's re-folder from the pure behavioural pre-pass to the full
  // behavioural→egg pipeline once the wasm loads; a load failure keeps the behavioural-only folder.
  async ensureRefolder(): Promise<void> {
    if (this.refoldRaw || this.refolderLoading) return;
    this.refolderLoading = true;
    try {
      const mod = await import("../../crates/refold/pkg/refold.js");
      await mod.default();
      this.refoldRaw = mod.refold;
      this.refolder = makeRefolder(mod.refold);
      this.invalidate(); // recompute now the egg stage is live
    } catch {
      this.deps.toast.show("re-folder: behavioural only (wasm unavailable)");
    } finally {
      this.refolderLoading = false;
    }
  }

  /** Advance the read-out view (the F key + the View menu). */
  cycleView(): void {
    this.deps.box.cycle();
  }

  toggleType(): void {
    this.typeOn = !this.typeOn;
    this.invalidate();
    this.deps.onToggle();
  }

  // ---- accessors for the menu, permalink, and dev seam ----
  get isTypeOn(): boolean {
    return this.typeOn;
  }
  get view(): string {
    return this.deps.box.current;
  }
  get text(): string {
    return this.lastExpr;
  }
  get refolderReady(): boolean {
    return !!this.refoldRaw;
  }
  rawRefold(s: string): string | null {
    return this.refoldRaw?.(s) ?? null;
  }

  /** The lens state for the permalink (view omitted when it's the default `ski`). */
  modes(): { view?: "ski" | "named" | "barker"; type?: true } {
    const v = this.deps.box.current;
    return { view: v === "ski" ? undefined : v, type: this.typeOn || undefined };
  }
  /** Restore from a permalink: an explicit `view` wins; a legacy `refold:true` maps to `named`. */
  applyModes(m: { refold?: boolean; view?: "ski" | "named" | "barker"; type?: boolean }): void {
    this.typeOn = !!m.type;
    this.deps.box.setView(m.view ?? (m.refold ? "named" : "ski")); // fires onChange → invalidate
  }
}

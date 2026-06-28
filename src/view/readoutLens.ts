/**
 * The read-out lens (extracted from app.ts, ADR 12): the top-centre live expression of
 * the focused tree, plus the two opt-in lenses — the re-folding lens (the egg/WASM
 * re-sugarer, a lazy driven adapter) and the type lens (principal simple type). It owns
 * the lens state, the per-frame render, and `exprOf`; the shell injects how to find the
 * focused node + the active read page and owns the `exprText` placement, so app.ts stays
 * composition wiring.
 */
import { Text, type Ticker } from "pixi.js";
import { decode, sexp, type Node } from "../core/term";
import { IOTA_CODE } from "../core/catalog";
import { makeRefolder, behavioralRefolder, type Refolder } from "../core/refold";
import { read, render, type Ty } from "../core/types";
import { inferType } from "../core/infer";
import { type Toast } from "./toast";

/** What the read-out reads from the shell. */
export interface ReadoutDeps {
  ticker: Ticker;
  /** The shell-owned read-out Text (placed/themed alongside the other HUD lines). */
  exprText: Text;
  /** The focused tree's term, or null when none is live. */
  focusNode: () => Node | null;
  /** The active hotbar page (drives the data reading mode). */
  readPage: () => string;
  /** Whether a combinator is discovered (undiscovered S/K/I read as their ι-tree). */
  isDiscovered: (sym: string) => boolean;
  /** Refresh the menu checkmarks after a lens toggle. */
  onToggle: () => void;
  toast: Toast;
}

// The hotbar page → the data reading it forces.
const READ_AS: Record<string, Ty> = { Arithmetic: "Int", Booleans: "Bool", Lists: "List", Char: "Char" };

// Above this node count, skip the (reducing) value/type/re-fold probes in the read-out —
// they're for recognising small data values, and running them per frame on a big term
// freezes playback. The raw s-expression is shown instead.
const READOUT_PROBE_MAX = 400;
/** True if `n` has more than `max` nodes (early-exit DFS — cheap, no allocation). */
function exceeds(n: Node, max: number): boolean {
  let count = 0;
  const go = (m: Node): boolean => ++count > max || (m.kind === "app" && (go(m.fn) || go(m.arg)));
  return go(n);
}

export class ReadoutLens {
  // re-folding lens (lazy WASM adapter; behavioural pre-pass works without it)
  private refoldOn = false;
  private refolder: Refolder | null = null;
  private refolderLoading = false;
  private refoldRaw: ((sexpr: string) => string) | null = null;
  private typeOn = false;
  // render memo: only repaint when the node or reading mode changes
  private lastShownNode: Node | null = null;
  private lastMode: Ty | undefined;
  private lastExpr = "";

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

  // The per-frame render: read the focused term type-guided (Phase 1), else the re-fold
  // lens (Phase 2), else the raw sexp; append the type badge when the type lens is on.
  private tick(): void {
    const node = this.deps.focusNode();
    const mode = READ_AS[this.deps.readPage()];
    if (node === this.lastShownNode && mode === this.lastMode) return;
    this.lastShownNode = node;
    this.lastMode = mode;
    let txt = "";
    if (node) {
      // The value probe (`read`) and the re-fold lens reduce the term — too slow on a big
      // term, and run on EVERY identity change (so they'd freeze playback of a big tree,
      // turbo or not). Past a node budget, skip them and show the raw s-expression.
      const big = exceeds(node, READOUT_PROBE_MAX);
      const v = big ? null : read(node, mode ?? null);
      const value = v ? render(v) : null;
      const folded = !value && !big && this.refoldOn && this.refolder ? this.refolder(node) : null;
      txt = value ?? (folded ? sexp(folded) : this.exprOf(node));
      if (this.typeOn) txt += `  ::  ${big ? "(tree too large to type)" : (inferType(node) ?? "no simple type")}`;
    }
    if (txt !== this.lastExpr) {
      this.lastExpr = txt;
      this.deps.exprText.text = txt;
    }
  }

  /** Force a read-out recompute on the next frame (after a mode/state change). */
  invalidate(): void {
    this.lastShownNode = null;
  }

  // Upgrade the lens from the pure behavioural pre-pass to the full behavioural→egg
  // pipeline once the wasm loads; a load failure keeps the behavioural-only re-folder.
  async ensureRefolder(): Promise<void> {
    if (this.refoldRaw || this.refolderLoading) return;
    this.refolderLoading = true;
    try {
      const mod = await import("../../crates/refold/pkg/refold.js");
      await mod.default();
      this.refoldRaw = mod.refold;
      this.refolder = makeRefolder(mod.refold);
      this.lastShownNode = null; // recompute now the egg stage is live
    } catch {
      this.deps.toast.show("re-folder: behavioural only (wasm unavailable)");
    } finally {
      this.refolderLoading = false;
    }
  }

  toggleRefold(): void {
    this.refoldOn = !this.refoldOn;
    this.lastShownNode = null;
    if (this.refoldOn) {
      if (!this.refolder) this.refolder = behavioralRefolder; // instant pure-TS lens
      void this.ensureRefolder(); // then upgrade with the egg stage
    }
    this.deps.onToggle();
  }

  toggleType(): void {
    this.typeOn = !this.typeOn;
    this.lastShownNode = null;
    this.deps.onToggle();
  }

  // ---- accessors for the menu, permalink, and dev seam ----
  get isRefoldOn(): boolean {
    return this.refoldOn;
  }
  get isTypeOn(): boolean {
    return this.typeOn;
  }
  get text(): string {
    return this.deps.exprText.text;
  }
  get refolderReady(): boolean {
    return !!this.refolder;
  }
  rawRefold(s: string): string | null {
    return this.refoldRaw?.(s) ?? null;
  }

  /** The lens state for the permalink. */
  modes(): { refold?: true; type?: true } {
    return { refold: this.refoldOn || undefined, type: this.typeOn || undefined };
  }
  applyModes(m: { refold?: boolean; type?: boolean }): void {
    this.typeOn = !!m.type;
    this.refoldOn = !!m.refold;
    if (this.refoldOn && !this.refolder) {
      this.refolder = behavioralRefolder;
      void this.ensureRefolder();
    }
    this.lastShownNode = null;
  }
}

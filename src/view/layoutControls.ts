/**
 * The top-right control stack (under the transport): two System-1 sliding-toggle rows.
 *   Row 1 (view): a [2D | 3D] switch, a [Auto | Top-Down | Radial | H-Tree] layout selector, and a
 *     [ι] iota-tree toggle (draw every combinator expanded to raw ι).
 *   Row 2 (optimizations): independent [Rules] [Graph] [Primitives] [Turbo] toggles.
 * A thin DOM view over the shell's layout / 3D / expand / optimization state: the shell owns the
 * state and injects getters + setters, and calls {@link LayoutControls.refresh} whenever it changes
 * (from here, the menus, T, or a pad). System-1 chrome — an ink track, the selected cell a paper slider.
 */
import { currentMode, onThemeChange, type Mode } from "./theme";

/** The layout the view row picks between — the three explicit ones plus Auto. */
export type LayoutKey = "auto" | "topdown" | "radial" | "htree";
/** The optimization toggles in the second row (independent on/off). */
export type OptCell = "rules" | "graph" | "primitives" | "turbo";

/** What the bars read + drive — the shell's layout / 3D / expand / optimization state. */
export interface LayoutControlsDeps {
  is3D: () => boolean;
  set3D: (on: boolean) => void;
  layout: () => LayoutKey;
  setLayout: (k: LayoutKey) => void;
  iotaTree: () => boolean;
  toggleIotaTree: () => void;
  opt: (k: OptCell) => boolean;
  toggleOpt: (k: OptCell) => void;
}

const PALETTE: Record<Mode, { paper: string; ink: string }> = {
  light: { paper: "#ffffff", ink: "#000000" },
  dark: { paper: "#07090d", ink: "#f0f3f6" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.lc-root { position: fixed; top: 52px; right: 16px; z-index: 41; display: flex; flex-direction: column;
  align-items: flex-end; gap: 6px; font-family: ${MONO}; }
.lc-row { display: flex; gap: 8px; align-items: stretch; }
.lc-seg { display: flex; border: 1px solid var(--lc-ink); background: var(--lc-ink); box-shadow: 2px 2px 0 rgba(0,0,0,0.6); }
.lc-btn { font-family: ${MONO}; font-size: 11px; line-height: 1; padding: 4px 9px; border: none; background: transparent;
  color: var(--lc-paper); cursor: pointer; white-space: nowrap; letter-spacing: 0.02em; transition: background 0.14s, color 0.14s; }
.lc-btn + .lc-btn { border-left: 1px solid color-mix(in srgb, var(--lc-paper) 30%, transparent); }
.lc-btn.on { background: var(--lc-paper); color: var(--lc-ink); font-weight: 700; }
.lc-btn:not(.on):hover { background: color-mix(in srgb, var(--lc-paper) 18%, transparent); }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** Make a `<button>` cell that runs `onClick` (pointerdown, so it beats the canvas). */
function cell(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "lc-btn";
  b.textContent = label;
  b.title = title;
  b.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

const LAYOUTS: { key: LayoutKey; label: string; title: string }[] = [
  { key: "auto", label: "Auto", title: "Auto — top-down for small trees, the compact H-tree once they get big" },
  { key: "topdown", label: "Top-Down", title: "Top-down — leaves on a row, depth grows downward" },
  { key: "radial", label: "Radial", title: "Radial — the root at the centre, depth as radius" },
  { key: "htree", label: "H-Tree", title: "H-tree — a nested square antenna, arms shrinking with depth" },
];

const OPTS: { key: OptCell; label: string; title: string }[] = [
  { key: "rules", label: "Rules", title: "Rule-based reduction — reduce a named bird by its law in one step, not its raw ι/SKI tree" },
  { key: "graph", label: "Graph", title: "Graph reduction — call-by-need sharing; a shared subterm is drawn and reduced once" },
  { key: "primitives", label: "Primitives", title: "Primitives — compute recognised numbers, lists, and booleans directly" },
  { key: "turbo", label: "Turbo", title: "Turbo — reduce big trees in WebAssembly (fast, no blow-up); auto-engages once a tree is big" },
];

export class LayoutControls {
  private readonly root = document.createElement("div");
  private readonly b2d: HTMLButtonElement;
  private readonly b3d: HTMLButtonElement;
  private readonly layoutBtns = new Map<LayoutKey, HTMLButtonElement>();
  private readonly bIota: HTMLButtonElement;
  private readonly optBtns = new Map<OptCell, HTMLButtonElement>();

  constructor(private readonly deps: LayoutControlsDeps) {
    injectStyles();
    this.root.className = "lc-root";
    this.applyPalette();

    // — Row 1: view —
    const dim = document.createElement("div");
    dim.className = "lc-seg";
    this.b2d = cell("2D", "2D view — the flat tree on the canvas", () => this.act(() => this.deps.set3D(false)));
    this.b3d = cell("3D", "3D view — the focused tree as a rotating spatial tree", () => this.act(() => this.deps.set3D(true)));
    dim.append(this.b2d, this.b3d);

    const laySeg = document.createElement("div");
    laySeg.className = "lc-seg";
    for (const { key, label, title } of LAYOUTS) {
      const b = cell(label, title, () => this.act(() => this.deps.setLayout(key)));
      this.layoutBtns.set(key, b);
      laySeg.append(b);
    }

    const row1 = document.createElement("div");
    row1.className = "lc-row";
    row1.append(dim, laySeg);

    // — Row 2: the [ι] iota-tree toggle + the optimizations. All independent (not mutually exclusive),
    // so each is its own separated toggle rather than one joined segment. [ι] leads the row so the two
    // rows balance optically (row 1 is the wide view segment). —
    const row2 = document.createElement("div");
    row2.className = "lc-row";
    const iotaSeg = document.createElement("div");
    iotaSeg.className = "lc-seg";
    this.bIota = cell("ι", "Show every combinator expanded to its raw ι-tree", () => this.act(() => this.deps.toggleIotaTree()));
    iotaSeg.append(this.bIota);
    row2.append(iotaSeg);
    for (const { key, label, title } of OPTS) {
      const seg = document.createElement("div");
      seg.className = "lc-seg";
      const b = cell(label, title, () => this.act(() => this.deps.toggleOpt(key)));
      this.optBtns.set(key, b);
      seg.append(b);
      row2.append(seg);
    }

    this.root.append(row1, row2);
    document.body.append(this.root);
    onThemeChange(() => this.applyPalette());
    this.refresh();
  }

  /** Run a state change, then reflect it immediately (the shell also refreshes us, but this keeps
   *  the bar snappy on click). */
  private act(change: () => void): void {
    change();
    this.refresh();
  }

  /** Re-read the shell's state and repaint the selected cells. */
  refresh(): void {
    const on3d = this.deps.is3D();
    this.b2d.classList.toggle("on", !on3d);
    this.b3d.classList.toggle("on", on3d);
    const k = this.deps.layout();
    for (const [key, b] of this.layoutBtns) b.classList.toggle("on", key === k);
    this.bIota.classList.toggle("on", this.deps.iotaTree());
    for (const [key, b] of this.optBtns) b.classList.toggle("on", this.deps.opt(key));
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    this.root.style.setProperty("--lc-paper", p.paper);
    this.root.style.setProperty("--lc-ink", p.ink);
  }
}

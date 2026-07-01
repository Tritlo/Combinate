/**
 * The layout control bar (top-right, just under the transport): a System-1 row of three toggles —
 * a sliding [2D | 3D] view switch, a 3-way [Top-Down | Radial | H-tree] layout selector, and an
 * [Auto] toggle (auto-layout on/off, which supersedes the 3-way). A thin DOM view over the shell's
 * layout / 3D state: the shell owns the state and injects getters + setters, and calls
 * {@link LayoutControls.refresh} whenever that state changes (from here, the View menu, T, or a pad).
 *
 * System-1 chrome to match the modals: each segment sits on an ink track (the "dark" cells); the
 * selected cell is filled with paper (the "white" slider) and slides between cells on a transition.
 */
import { currentMode, onThemeChange, type Mode } from "./theme";

/** The three explicit 2D layouts the middle toggle picks between. */
export type LayoutKey = "topdown" | "radial" | "htree";

/** What the bar reads + drives — the shell's layout / 3D state. */
export interface LayoutControlsDeps {
  is3D: () => boolean;
  set3D: (on: boolean) => void;
  /** The active layout — one of the three explicit ones, or `"auto"` when auto-layout is on. */
  layoutKey: () => LayoutKey | "auto";
  setLayout: (k: LayoutKey) => void;
  autoOn: () => boolean;
  toggleAuto: () => void;
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
.lc-root { position: fixed; top: 52px; right: 16px; z-index: 41; display: flex; gap: 8px; align-items: stretch;
  font-family: ${MONO}; }
.lc-seg { display: flex; border: 1px solid var(--lc-ink); background: var(--lc-ink); box-shadow: 2px 2px 0 rgba(0,0,0,0.6); }
.lc-seg.dim { opacity: 0.4; }
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
function cell(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "lc-btn";
  b.textContent = label;
  b.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export class LayoutControls {
  private readonly root = document.createElement("div");
  private readonly b2d: HTMLButtonElement;
  private readonly b3d: HTMLButtonElement;
  private readonly layoutSeg = document.createElement("div");
  private readonly bTop: HTMLButtonElement;
  private readonly bRadial: HTMLButtonElement;
  private readonly bHTree: HTMLButtonElement;
  private readonly bAuto: HTMLButtonElement;

  constructor(private readonly deps: LayoutControlsDeps) {
    injectStyles();
    this.root.className = "lc-root";
    this.applyPalette();

    const dim = document.createElement("div");
    dim.className = "lc-seg";
    this.b2d = cell("2D", () => this.act(() => this.deps.set3D(false)));
    this.b3d = cell("3D", () => this.act(() => this.deps.set3D(true)));
    dim.append(this.b2d, this.b3d);

    this.layoutSeg.className = "lc-seg";
    this.bTop = cell("Top-Down", () => this.act(() => this.deps.setLayout("topdown")));
    this.bRadial = cell("Radial", () => this.act(() => this.deps.setLayout("radial")));
    this.bHTree = cell("H-tree", () => this.act(() => this.deps.setLayout("htree")));
    this.layoutSeg.append(this.bTop, this.bRadial, this.bHTree);

    const autoSeg = document.createElement("div");
    autoSeg.className = "lc-seg";
    this.bAuto = cell("Auto", () => this.act(() => this.deps.toggleAuto()));
    autoSeg.append(this.bAuto);

    this.root.append(dim, this.layoutSeg, autoSeg);
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

  /** Re-read the shell's layout / 3D state and repaint the selected cells. */
  refresh(): void {
    const on3d = this.deps.is3D();
    this.b2d.classList.toggle("on", !on3d);
    this.b3d.classList.toggle("on", on3d);
    const auto = this.deps.autoOn();
    const k = this.deps.layoutKey();
    this.bTop.classList.toggle("on", k === "topdown");
    this.bRadial.classList.toggle("on", k === "radial");
    this.bHTree.classList.toggle("on", k === "htree");
    this.layoutSeg.classList.toggle("dim", auto); // Auto supersedes the manual pick → dim it
    this.bAuto.classList.toggle("on", auto);
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    this.root.style.setProperty("--lc-paper", p.paper);
    this.root.style.setProperty("--lc-ink", p.ink);
  }
}

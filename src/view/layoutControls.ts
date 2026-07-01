/**
 * The top-right control stack (under the transport): two System-1 sliding-toggle rows.
 *   Row 1 (view): a [2D | 3D] switch + a [Auto | Top-Down | Radial | H-Tree] layout selector.
 *   Row 2: a [ι] iota-tree toggle + independent [Rules] [Graph] [Primitives] [Turbo] optimizations.
 * A thin DOM view over the shell's layout / 3D / expand / optimization state.
 *
 * On phones (≤600) the whole thing — plus the transport (speed controls), reparented in — collapses
 * into a single "Controls" card with a title bar + collapse caret, styled like the quest tracker.
 * System-1 chrome throughout: an ink track, the selected cell a paper slider.
 */
import { currentMode, onThemeChange, type Mode, MONO, PAPER, INK } from "./theme";

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
  /** The transport bar's root — hosted inside the Controls card on phones. */
  transportEl: HTMLElement;
}

const PALETTE: Record<Mode, { paper: string; ink: string }> = {
  light: { paper: PAPER.light, ink: INK.light },
  dark: { paper: PAPER.dark, ink: INK.dark },
};
const STORE_KEY = "combinate:controls:collapsed:v1";
const PHONE = 600;

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.lc-root { position: fixed; top: 52px; right: 16px; z-index: 41; font-family: ${MONO}; }
.lc-title { display: none; }
.lc-body { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
.lc-row { display: flex; gap: 8px; align-items: stretch; }
/* Segments + cells grow to fill the row, so the two rows come out equal-width with a UNIFORM 8px gap
   (rather than space-between, which stretched the gaps unevenly). */
.lc-seg { display: flex; flex: 1 1 auto; border: 1px solid var(--lc-ink); background: var(--lc-ink); box-shadow: 2px 2px 0 rgba(0,0,0,0.6); }
.lc-btn { flex: 1 1 auto; font-family: ${MONO}; font-size: 11px; line-height: 1; padding: 4px 9px; border: none; background: transparent;
  color: var(--lc-paper); cursor: pointer; white-space: nowrap; letter-spacing: 0.02em; transition: background 0.14s, color 0.14s; }
.lc-btn + .lc-btn { border-left: 1px solid color-mix(in srgb, var(--lc-paper) 30%, transparent); }
.lc-btn.on { background: var(--lc-paper); color: var(--lc-ink); font-weight: 700; }
.lc-btn:not(.on):hover { background: color-mix(in srgb, var(--lc-paper) 18%, transparent); }
/* Phone: a collapsible Controls card (title + body) hosting the transport + the toggle rows. */
.lc-root.lc-phone { top: 26px; left: 8px; right: 8px; background: var(--lc-paper); border: 1px solid var(--lc-ink);
  box-shadow: 3px 3px 0 rgba(0,0,0,0.6); }
.lc-root.lc-phone .lc-title { display: flex; align-items: center; gap: 8px; padding: 3px 9px; background: var(--lc-ink);
  color: var(--lc-paper); cursor: pointer; user-select: none; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }
.lc-root.lc-phone .lc-title span { flex: 1; }
.lc-root.lc-phone .lc-body { padding: 9px; gap: 8px; }
.lc-root.lc-phone.lc-collapsed .lc-body { display: none; }
/* Host the transport (speed controls) in the card: static, and its segments/cells grow to fill the
   row with the same uniform 8px gaps as the toggle rows. */
.lc-root.lc-phone .tp-root { position: static; box-shadow: none; width: 100%; }
.lc-root.lc-phone .tp-seg, .lc-root.lc-phone .tp-rate { flex: 1 1 auto; }
.lc-root.lc-phone .tp-cell { flex: 1 1 0; width: auto; }
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
  private readonly title = document.createElement("div");
  private readonly caret = document.createElement("span");
  private readonly body = document.createElement("div");
  private readonly b2d: HTMLButtonElement;
  private readonly b3d: HTMLButtonElement;
  private readonly layoutBtns = new Map<LayoutKey, HTMLButtonElement>();
  private readonly bIota: HTMLButtonElement;
  private readonly optBtns = new Map<OptCell, HTMLButtonElement>();
  private phone = false;
  private collapsed = false;
  /** Fired when the card's height changes (collapse / breakpoint) so the shell can restack the read-out. */
  onLayout: (() => void) | undefined;

  constructor(private readonly deps: LayoutControlsDeps) {
    injectStyles();
    this.root.className = "lc-root";
    this.applyPalette();
    this.load();

    // Title bar (phone only) — collapses the card, quest-tracker style.
    this.title.className = "lc-title";
    this.caret.textContent = "▾";
    const label = document.createElement("span");
    label.textContent = "Controls";
    this.title.append(this.caret, label);
    this.title.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.toggleCollapsed();
    });

    // — Row 1: view —
    const dim = document.createElement("div");
    dim.className = "lc-seg";
    this.b2d = cell("2D", "2D view — the flat tree on the canvas", () => this.act(() => this.deps.set3D(false)));
    this.b3d = cell("3D", "3D view — the focused tree as a rotating spatial tree", () => this.act(() => this.deps.set3D(true)));
    dim.append(this.b2d, this.b3d);

    const laySeg = document.createElement("div");
    laySeg.className = "lc-seg";
    for (const { key, label: l, title } of LAYOUTS) {
      const b = cell(l, title, () => this.act(() => this.deps.setLayout(key)));
      this.layoutBtns.set(key, b);
      laySeg.append(b);
    }

    const row1 = document.createElement("div");
    row1.className = "lc-row";
    row1.append(dim, laySeg);

    // — Row 2: the [ι] iota-tree toggle + the optimizations, all independent (separate toggles). —
    const row2 = document.createElement("div");
    row2.className = "lc-row";
    const iotaSeg = document.createElement("div");
    iotaSeg.className = "lc-seg";
    this.bIota = cell("ι", "Show every combinator expanded to its raw ι-tree", () => this.act(() => this.deps.toggleIotaTree()));
    iotaSeg.append(this.bIota);
    row2.append(iotaSeg);
    for (const { key, label: l, title } of OPTS) {
      const seg = document.createElement("div");
      seg.className = "lc-seg";
      const b = cell(l, title, () => this.act(() => this.deps.toggleOpt(key)));
      this.optBtns.set(key, b);
      seg.append(b);
      row2.append(seg);
    }

    this.body.className = "lc-body";
    this.body.append(row1, row2);
    this.root.append(this.title, this.body);
    document.body.append(this.root);
    onThemeChange(() => this.applyPalette());
    window.addEventListener("resize", () => this.syncPhone());
    this.syncPhone();
    this.refresh();
  }

  /** Run a state change, then reflect it immediately (the shell also refreshes us). */
  private act(change: () => void): void {
    change();
    this.refresh();
  }

  /** Track the phone breakpoint: below it, host the transport in the card + show the title. */
  private syncPhone(): void {
    const phone = window.innerWidth <= PHONE;
    if (phone !== this.phone) {
      this.phone = phone;
      // Reparent the transport: into the card on phones, back out to <body> on wider screens.
      if (phone) this.body.insertBefore(this.deps.transportEl, this.body.firstChild);
      else document.body.append(this.deps.transportEl);
    }
    this.root.classList.toggle("lc-phone", phone);
    this.renderCollapse();
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.save();
    this.renderCollapse();
  }

  private renderCollapse(): void {
    this.caret.textContent = this.collapsed ? "▸" : "▾";
    this.root.classList.toggle("lc-collapsed", this.collapsed);
    this.onLayout?.();
  }

  /** The card's bottom edge in viewport px on phones (0 otherwise) — for stacking the read-out below it. */
  mobileBottom(): number {
    return this.phone ? this.root.getBoundingClientRect().bottom : 0;
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

  private load(): void {
    try {
      this.collapsed = localStorage.getItem(STORE_KEY) === "1";
    } catch {
      /* default expanded */
    }
  }
  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, this.collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    document.body.style.setProperty("--lc-paper", p.paper);
    document.body.style.setProperty("--lc-ink", p.ink);
  }
}

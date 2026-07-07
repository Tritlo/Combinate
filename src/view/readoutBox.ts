/**
 * The read-out box (ADR 12, revised): the focused tree's live expression in a small System-1 card,
 * top-center. Click the title bar to cycle the *view* — combinators (the current state, no
 * reduction), named + native (birds + ints/lists/…, an explicit "what does it evaluate to" lens),
 * and the raw Barker ι bit-code (0/1). An expand toggle in the title bar swaps the single scrolling
 * line for the full wrapped expression (handy for long Barker codes / big trees). Owns the view +
 * expand state + chrome/persistence; the per-frame string comes from {@link ReadoutLens} via
 * {@link setText}. DOM (matches the quest tracker / discovery card chrome — the shared base is ADR 12).
 */
import { currentMode, onThemeChange, type Mode, MONO, PAPER, INK, ensureFont } from "./theme";

/** The read-out's view mode. `ski` is the default (combinators only, no look-ahead). */
export type ReadoutView = "ski" | "named" | "barker";

const ORDER: ReadoutView[] = ["ski", "named", "barker"];
const LABEL: Record<ReadoutView, string> = { ski: "combinators", named: "named + native", barker: "Barker · 0/1" };

const PALETTE: Record<Mode, Record<string, string>> = {
  light: { paper: PAPER.light, ink: INK.light, shadow: "rgba(0,0,0,0.85)" },
  dark: { paper: PAPER.dark, ink: INK.dark, shadow: "rgba(0,0,0,0.85)" },
};
const STORE_KEY = "combinate:readout:view:v1";
const EXPAND_KEY = "combinate:readout:expanded:v1";

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  ensureFont();
  const css = `
.ro-root { position: fixed; top: 30px; left: 50%; transform: translateX(-50%); z-index: 36;
  font-family: ${MONO}; width: min(620px, calc(100vw - 24px)); display: none; }
.ro-card { background: var(--ro-paper); color: var(--ro-ink); border: 1px solid var(--ro-ink);
  box-shadow: 2px 2px 0 var(--ro-shadow); }
.ro-title { display: flex; align-items: center; gap: 8px; padding: 2px 8px; background: var(--ro-ink);
  color: var(--ro-paper); cursor: pointer; user-select: none; }
.ro-title span { flex: 1; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ro-cyc { flex: 0 0 auto; font-size: 11px; opacity: 0.7; }
.ro-exp { flex: 0 0 auto; width: 16px; height: 15px; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--ro-paper); font-size: 11px; line-height: 1; cursor: pointer; }
.ro-body { padding: 5px 9px; font-size: 16px; line-height: 1.4; white-space: nowrap;
  overflow-x: auto; overflow-y: hidden; user-select: text;
  font-variant-ligatures: contextual; font-feature-settings: "calt" 1, "liga" 1; }
.ro-body.ro-wrap { white-space: pre-wrap; word-break: break-all; overflow-x: hidden; overflow-y: auto; max-height: 42vh; }
/* The centered read-out competes with the top-right control stack (and the top-left edge legend).
   1101–1399px: narrow it — centered at width (100vw−780) fixes each margin at 390px, clearing both
   the legend (left) and the bars/tracker (right) at every width. ≤1100px: drop it BELOW the whole
   stack; the tracker hides at the same breakpoint. ≤600px: go full width (phone). */
@media (min-width: 1101px) and (max-width: 1399px) { .ro-root { width: min(620px, calc(100vw - 780px)); } }
@media (max-width: 1100px) { .ro-root { top: 116px; } }
@media (max-width: 600px) { .ro-root { width: calc(100vw - 16px); } }
@media (max-width: 560px) { .ro-body { font-size: 14px; } .ro-body.ro-wrap { max-height: 60vh; } }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

export class ReadoutBox {
  private readonly root = document.createElement("div");
  private readonly titleLabel = document.createElement("span");
  private readonly expBtn = document.createElement("div");
  private readonly body = document.createElement("div");
  private view: ReadoutView = "ski";
  private expanded = false; // full view: the body wraps + scrolls (for long Barker / big trees)

  constructor() {
    injectStyles();
    this.load();
    this.root.className = "ro-root";
    this.applyPalette();

    const card = document.createElement("div");
    card.className = "ro-card";
    const title = document.createElement("div");
    title.className = "ro-title";
    title.title = "Click to change view";
    title.addEventListener("pointerdown", () => this.cycle());
    this.expBtn.className = "ro-exp";
    this.expBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // don't also cycle the view
      this.toggleExpand();
    });
    const cyc = document.createElement("div");
    cyc.className = "ro-cyc";
    cyc.textContent = "⟳";
    title.append(this.titleLabel, this.expBtn, cyc);
    this.body.className = "ro-body";
    card.append(title, this.body);
    this.root.append(card);
    document.body.append(this.root);
    onThemeChange(() => this.applyPalette());
    this.paintTitle();
    this.applyExpand();
  }

  /** The active view (read by the per-frame lens). */
  get current(): ReadoutView {
    return this.view;
  }

  /** Set the expression text; an empty string hides the box (no focused tree). textContent only —
   *  never innerHTML: the text can carry user-authored combinator names / free-var atoms. */
  setText(s: string): void {
    if (this.body.textContent !== s) this.body.textContent = s;
    this.root.style.display = s ? "block" : "none";
  }

  /** Advance to the next view (the title-bar click + the F key). */
  cycle(): void {
    this.setView(ORDER[(ORDER.indexOf(this.view) + 1) % ORDER.length]);
  }

  /** Set the view directly (menu / permalink restore). The lens polls `current` each frame, so it
   *  recomputes on its own next tick — no callback. An unknown value (a hand-edited permalink / dev
   *  seam) clamps to the safe non-evaluating default rather than falling through to a probe. */
  setView(v: ReadoutView): void {
    this.view = ORDER.includes(v) ? v : "ski";
    this.save();
    this.paintTitle();
  }

  /** Override the fixed `top` (used on phones to stack this below the tracked-quest card); pass null
   *  to restore the CSS-driven position. */
  setTop(px: number | null): void {
    this.root.style.top = px === null ? "" : `${px}px`;
  }

  /** Toggle the full (wrapping, scrollable) view — the whole expression instead of one scrolling line. */
  toggleExpand(): void {
    this.expanded = !this.expanded;
    this.save();
    this.applyExpand();
  }

  private paintTitle(): void {
    this.titleLabel.textContent = LABEL[this.view];
  }

  private applyExpand(): void {
    this.body.classList.toggle("ro-wrap", this.expanded);
    this.expBtn.textContent = this.expanded ? "⤡" : "⤢"; // collapse / expand
    this.expBtn.title = this.expanded ? "Collapse" : "Expand (show the full expression)";
  }

  private load(): void {
    try {
      const v = localStorage.getItem(STORE_KEY) as ReadoutView | null;
      if (v && ORDER.includes(v)) this.view = v;
      this.expanded = localStorage.getItem(EXPAND_KEY) === "1";
    } catch {
      /* defaults: ski, collapsed */
    }
  }
  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, this.view);
      localStorage.setItem(EXPAND_KEY, this.expanded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    for (const [k, v] of Object.entries(p)) this.root.style.setProperty(`--ro-${k}`, v);
  }
}

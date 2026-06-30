/**
 * The read-out box (ADR 12, revised): the focused tree's live expression in a small System-1 card,
 * top-centre. Click the title bar to cycle the *view* — combinators (the current state, no
 * reduction), named + native (birds + ints/lists/…, an explicit "what does it evaluate to" lens),
 * and the raw Barker ι bit-code (0/1). Owns the view state + its chrome/persistence; the per-frame
 * string comes from {@link ReadoutLens} via {@link setText}. DOM (matches the quest tracker /
 * discovery card chrome — the shared System-1 base is ADR 12).
 */
import { currentMode, onThemeChange, type Mode } from "./theme";
import { vendorUrl } from "../vendorUrl";

/** The read-out's view mode. `ski` is the default (combinators only, no look-ahead). */
export type ReadoutView = "ski" | "named" | "barker";

const ORDER: ReadoutView[] = ["ski", "named", "barker"];
const LABEL: Record<ReadoutView, string> = { ski: "combinators", named: "named + native", barker: "Barker · 0/1" };

const PALETTE: Record<Mode, Record<string, string>> = {
  light: { paper: "#ffffff", ink: "#000000", shadow: "rgba(0,0,0,0.85)" },
  dark: { paper: "#07090d", ink: "#f0f3f6", shadow: "rgba(0,0,0,0.85)" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";
const STORE_KEY = "combinate:readout:view:v1";

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
@font-face { font-family: 'IoskeleyMono'; src: url('${vendorUrl("vendor/fonts/IoskeleyMono-Regular.woff2")}') format('woff2'); font-display: swap; }
.ro-root { position: fixed; top: 30px; left: 50%; transform: translateX(-50%); z-index: 36;
  font-family: ${MONO}; width: min(620px, calc(100vw - 24px)); display: none; }
.ro-card { background: var(--ro-paper); color: var(--ro-ink); border: 1px solid var(--ro-ink);
  box-shadow: 2px 2px 0 var(--ro-shadow); }
.ro-title { display: flex; align-items: center; gap: 8px; padding: 2px 8px; background: var(--ro-ink);
  color: var(--ro-paper); cursor: pointer; user-select: none; }
.ro-title span { flex: 1; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ro-cyc { flex: 0 0 auto; font-size: 11px; opacity: 0.7; }
.ro-body { padding: 5px 9px; font-size: 16px; line-height: 1.4; white-space: nowrap;
  overflow-x: auto; overflow-y: hidden; user-select: text; }
@media (max-width: 560px) { .ro-root { top: 26px; } .ro-body { font-size: 14px; } }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** What the box reports back to the shell when the view changes (recompute + lazy-load + repaint). */
export interface ReadoutBoxDeps {
  onChange: (view: ReadoutView) => void;
}

export class ReadoutBox {
  private readonly root = document.createElement("div");
  private readonly titleLabel = document.createElement("span");
  private readonly body = document.createElement("div");
  private view: ReadoutView = "ski";

  constructor(private readonly deps: ReadoutBoxDeps) {
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
    const cyc = document.createElement("div");
    cyc.className = "ro-cyc";
    cyc.textContent = "⟳";
    title.append(this.titleLabel, cyc);
    this.body.className = "ro-body";
    card.append(title, this.body);
    this.root.append(card);
    document.body.append(this.root);
    onThemeChange(() => this.applyPalette());
    this.paintTitle();
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

  /** Set the view directly (permalink restore); fires onChange so the lens recomputes. */
  setView(v: ReadoutView): void {
    this.view = v;
    this.save();
    this.paintTitle();
    this.deps.onChange(v);
  }

  private paintTitle(): void {
    this.titleLabel.textContent = LABEL[this.view];
  }

  private load(): void {
    try {
      const v = localStorage.getItem(STORE_KEY) as ReadoutView | null;
      if (v && ORDER.includes(v)) this.view = v;
    } catch {
      /* default ski */
    }
  }
  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, this.view);
    } catch {
      /* ignore */
    }
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    for (const [k, v] of Object.entries(p)) this.root.style.setProperty(`--ro-${k}`, v);
  }
}

/**
 * A tiny System-1-styled context popup (Delete / Copy): a 1px-bordered DOM menu shown at a screen
 * point and dismissed on click-away or Esc. Operable by the mouse (hover + click) AND by
 * keyboard/gamepad — a pad bind can open it, so the host routes nav in while it's open:
 * {@link move} walks the highlight, {@link choose} runs the highlighted item, {@link cancel}
 * dismisses. Styled to match the menu bar (mono, hard 1px border, box-shadow; inverts for dark).
 */
import { currentMode, onThemeChange, type Mode } from "./theme";

/** One row in the popup: a label and the action it runs when chosen. */
export interface ContextItem {
  label: string;
  run: () => void;
}

const PALETTE: Record<Mode, { bg: string; fg: string; line: string; shadow: string }> = {
  light: { bg: "#ffffff", fg: "#000000", line: "#000000", shadow: "rgba(0,0,0,0.85)" },
  dark: { bg: "#07090d", fg: "#f0f3f6", line: "#f0f3f6", shadow: "rgba(0,0,0,0.85)" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.ctx-menu { position: fixed; display: none; min-width: 120px; padding: 2px 0; z-index: 60;
  background: var(--ctx-bg); color: var(--ctx-fg); border: 1px solid var(--ctx-line);
  box-shadow: 2px 2px 0 var(--ctx-shadow); font-family: ${MONO}; font-size: 14px; line-height: 1;
  user-select: none; -webkit-user-select: none; }
.ctx-item { padding: 4px 20px; white-space: nowrap; cursor: default; }
.ctx-item.ctx-active, .ctx-item:hover { background: var(--ctx-fg); color: var(--ctx-bg); }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** A reusable single-instance context popup (the app shows it for the canvas + the focused bucket). */
export class ContextMenu {
  private readonly el = document.createElement("div");
  private items: ContextItem[] = [];
  private active = 0;
  private shown = false;
  // Dismiss on the NEXT outside pointerdown — attached deferred so the opening right-click (still
  // bubbling to document) doesn't immediately close us.
  private readonly onOutside = (): void => this.hide();

  constructor() {
    injectStyles();
    this.el.className = "ctx-menu";
    this.applyPalette();
    document.body.appendChild(this.el);
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation()); // a click on the menu isn't "outside"
    onThemeChange(() => this.applyPalette());
  }

  /** Whether the popup is currently shown (the host gates nav routing on this). */
  get isOpen(): boolean {
    return this.shown;
  }

  /** Show the popup at a screen point with the given items (clamped to stay on-screen). */
  show(x: number, y: number, items: ContextItem[]): void {
    this.items = items;
    this.active = 0;
    this.render();
    this.el.style.display = "block";
    this.shown = true;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    this.el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 6))}px`;
    this.el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 6))}px`;
    document.removeEventListener("pointerdown", this.onOutside);
    setTimeout(() => {
      if (this.shown) document.addEventListener("pointerdown", this.onOutside);
    }, 0);
  }

  /** Dismiss the popup (no-op if hidden). */
  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.el.style.display = "none";
    document.removeEventListener("pointerdown", this.onOutside);
  }

  /** Walk the highlight by `d` (wraps) — the keyboard/gamepad ↑/↓. */
  move(d: number): void {
    if (!this.shown || this.items.length === 0) return;
    this.active = (this.active + d + this.items.length) % this.items.length;
    this.paintActive();
  }

  /** Run the highlighted item, then dismiss — the keyboard/gamepad Space/A. */
  choose(): void {
    if (!this.shown) return;
    const it = this.items[this.active];
    this.hide();
    it?.run();
  }

  /** Dismiss without choosing — the keyboard/gamepad Esc/B. */
  cancel(): void {
    this.hide();
  }

  private render(): void {
    this.el.replaceChildren(
      ...this.items.map((it, i) => {
        const row = document.createElement("div");
        row.className = i === this.active ? "ctx-item ctx-active" : "ctx-item";
        row.textContent = it.label;
        row.addEventListener("pointerenter", () => {
          this.active = i;
          this.paintActive();
        });
        row.addEventListener("pointerup", (e) => {
          e.stopPropagation();
          this.hide();
          it.run();
        });
        return row;
      }),
    );
  }

  private paintActive(): void {
    [...this.el.children].forEach((c, i) => c.classList.toggle("ctx-active", i === this.active));
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    for (const [k, v] of Object.entries(p)) this.el.style.setProperty(`--ctx-${k}`, v);
  }
}

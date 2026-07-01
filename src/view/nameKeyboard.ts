/**
 * A System-1-styled on-screen keyboard for entering a combinator name with no text field, so a
 * gamepad or the keyboard alone can name a tree (right-click / M → "Name combinator"). A modal DOM
 * popup — the entered name on top, a QWERTY key grid (with a second 123/symbols page), and a bottom
 * row (page toggle, Space, Backspace, Done). Styled to match the menu bar + context popup (mono,
 * hard 1px border, box-shadow, theme palette that inverts for dark).
 *
 * Navigable every way: arrow keys / gamepad D-pad walk a 2D highlight ({@link move}); Space / A
 * presses the highlighted key ({@link press}); the physical keyboard types directly
 * ({@link typeChar} / {@link backspace}); Enter commits ({@link done}); Esc cancels ({@link cancel}).
 * The host routes input while {@link isOpen}, exactly like the menu bar / context popup.
 */
import { currentMode, onThemeChange, type Mode, MONO, PAPER, INK } from "./theme";

/** One key in the grid: its glyph and the action it runs when pressed. `wide` stretches it. */
interface Key {
  label: string;
  act: () => void;
  wide?: boolean;
}

/** The character rows of each page (the bottom action row is built per render). */
const PAGE_CHARS: string[][][] = [
  [["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"], ["a", "s", "d", "f", "g", "h", "j", "k", "l"], ["z", "x", "c", "v", "b", "n", "m"]],
  [["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"], ["-", "_", ".", ",", ":", ";", "!", "?"], ["+", "=", "*", "/", "#", "$", "%", "&"]],
];

const PALETTE: Record<Mode, { bg: string; fg: string; line: string; shadow: string; backdrop: string }> = {
  light: { bg: PAPER.light, fg: INK.light, line: "#000000", shadow: "rgba(0,0,0,0.85)", backdrop: "rgba(27,31,36,0.5)" },
  dark: { bg: PAPER.dark, fg: INK.dark, line: "#f0f3f6", shadow: "rgba(0,0,0,0.85)", backdrop: "rgba(1,4,9,0.6)" },
};

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.nk-root { position: fixed; inset: 0; z-index: 80; display: none; align-items: center; justify-content: center;
  background: var(--nk-backdrop); font-family: ${MONO}; }
.nk-card { background: var(--nk-bg); color: var(--nk-fg); border: 1px solid var(--nk-line); box-shadow: 2px 2px 0 var(--nk-shadow);
  padding: 12px; user-select: none; -webkit-user-select: none; }
.nk-title { font-size: 11px; opacity: 0.5; letter-spacing: 0.05em; margin-bottom: 6px; }
.nk-name { min-width: 320px; min-height: 22px; padding: 4px 8px; margin-bottom: 10px; font-size: 18px;
  border: 1px solid var(--nk-line); white-space: pre; overflow: hidden; }
.nk-name.nk-empty { opacity: 0.4; }
.nk-grid { display: flex; flex-direction: column; gap: 5px; }
.nk-row { display: flex; gap: 5px; justify-content: center; }
.nk-key { min-width: 30px; padding: 7px 0; flex: 0 0 auto; text-align: center; font-size: 15px; line-height: 1;
  border: 1px solid var(--nk-line); cursor: default; }
.nk-key.nk-wide { flex: 1 1 auto; padding-left: 14px; padding-right: 14px; }
.nk-key.nk-active, .nk-key:hover { background: var(--nk-fg); color: var(--nk-bg); }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** A reusable single-instance on-screen keyboard (the app shows it for "Name combinator"). */
export class NameKeyboard {
  private readonly root = document.createElement("div");
  private readonly nameEl = document.createElement("div");
  private readonly gridEl = document.createElement("div");
  private name = "";
  private page = 0;
  private row = 0;
  private col = 0;
  private rows: Key[][] = [];
  private keyEls: HTMLElement[][] = [];
  private shown = false;
  // Returns true to commit + close, false to keep the keyboard open (e.g. a rejected name).
  private onDone: ((name: string) => boolean) | null = null;

  constructor() {
    injectStyles();
    this.root.className = "nk-root";
    const card = document.createElement("div");
    card.className = "nk-card";
    const title = document.createElement("div");
    title.className = "nk-title";
    title.textContent = "NAME COMBINATOR";
    this.nameEl.className = "nk-name";
    this.gridEl.className = "nk-grid";
    card.append(title, this.nameEl, this.gridEl);
    this.root.append(card);
    card.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.cancel(); // click the backdrop
    });
    this.applyPalette();
    onThemeChange(() => this.applyPalette());
    document.body.appendChild(this.root);
  }

  /** Whether the keyboard is currently shown (the host gates input routing on this). */
  get isOpen(): boolean {
    return this.shown;
  }

  /** Open the keyboard seeded with `initial`; `onDone` commits (return true to close, false to keep
   *  open so the caller can reject + re-prompt without losing the popup). */
  show(initial: string, onDone: (name: string) => boolean): void {
    this.name = initial;
    this.onDone = onDone;
    this.page = 0;
    this.row = 0;
    this.col = 0;
    this.shown = true;
    this.render();
    this.root.style.display = "flex";
  }

  /** Walk the highlight by (dx, dy), clamping to the page's ragged rows (the arrow keys / D-pad). */
  move(dx: number, dy: number): void {
    if (!this.shown) return;
    this.row = Math.max(0, Math.min(this.rows.length - 1, this.row + dy));
    this.col = Math.max(0, Math.min(this.rows[this.row].length - 1, this.col + dx));
    this.paintActive();
  }

  /** Press the highlighted key (Space / gamepad-A). */
  press(): void {
    if (!this.shown) return;
    this.rows[this.row]?.[this.col]?.act();
  }

  /** Append a character to the name (the physical keyboard typing directly). */
  typeChar(ch: string): void {
    if (!this.shown) return;
    this.name += ch;
    this.paintName();
  }

  /** Delete the last character. */
  backspace(): void {
    if (!this.shown) return;
    this.name = this.name.slice(0, -1);
    this.paintName();
  }

  /** Commit the name through `onDone`; close only if it accepts (Enter / the Done key). */
  done(): void {
    if (!this.shown) return;
    const ok = this.onDone?.(this.name) ?? true;
    if (ok) this.hide();
  }

  /** Dismiss without committing (Esc / gamepad-B / the backdrop). */
  cancel(): void {
    this.hide();
  }

  private hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.root.style.display = "none";
    this.onDone = null;
  }

  private togglePage(): void {
    this.page = this.page === 0 ? 1 : 0;
    this.row = Math.min(this.row, PAGE_CHARS[this.page].length); // bottom row index unchanged
    this.render();
  }

  private buildRows(): Key[][] {
    const chars = PAGE_CHARS[this.page].map((r) => r.map((ch): Key => ({ label: ch, act: () => this.typeChar(ch) })));
    const bottom: Key[] = [
      { label: this.page === 0 ? "123" : "ABC", act: () => this.togglePage() },
      { label: "Space", wide: true, act: () => this.typeChar(" ") },
      { label: "⌫", act: () => this.backspace() },
      { label: "Done", wide: true, act: () => this.done() },
    ];
    return [...chars, bottom];
  }

  private render(): void {
    this.rows = this.buildRows();
    this.keyEls = [];
    this.gridEl.replaceChildren(
      ...this.rows.map((row, ri) => {
        const rowEl = document.createElement("div");
        rowEl.className = "nk-row";
        const els: HTMLElement[] = [];
        for (let ci = 0; ci < row.length; ci++) {
          const k = row[ci];
          const keyEl = document.createElement("div");
          keyEl.className = k.wide ? "nk-key nk-wide" : "nk-key";
          keyEl.textContent = k.label;
          keyEl.addEventListener("pointerenter", () => {
            this.row = ri;
            this.col = ci;
            this.paintActive();
          });
          keyEl.addEventListener("pointerup", (e) => {
            e.stopPropagation();
            k.act();
          });
          rowEl.appendChild(keyEl);
          els.push(keyEl);
        }
        this.keyEls.push(els);
        return rowEl;
      }),
    );
    this.row = Math.min(this.row, this.rows.length - 1);
    this.col = Math.min(this.col, this.rows[this.row].length - 1);
    this.paintName();
    this.paintActive();
  }

  private paintName(): void {
    this.nameEl.textContent = this.name || "type a name…";
    this.nameEl.classList.toggle("nk-empty", this.name.length === 0);
  }

  private paintActive(): void {
    this.keyEls.forEach((row, ri) => row.forEach((el, ci) => el.classList.toggle("nk-active", ri === this.row && ci === this.col)));
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    for (const [k, v] of Object.entries(p)) this.root.style.setProperty(`--nk-${k}`, v);
  }
}

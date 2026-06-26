/**
 * A classic System 1 Macintosh menu bar (the 80s callback): a 1px-bordered bar
 * pinned to the top, an ι where the Apple logo went, and pull-down menus that
 * hold everything the old left rail did. Pure black-and-white chrome that inverts
 * for dark mode, set in IoskeleyMono. A DOM overlay — pull-downs are far nicer in
 * the DOM than in Pixi — driven by a plain menu spec the app supplies (reusing the
 * existing action callbacks). Click a title to drop its menu; hover the bar to
 * walk between open menus; checkmarks (✓) mark active toggles, bullets (•) the
 * selected option in a group; click outside or Esc to close.
 */
import { currentMode, onThemeChange, type Mode } from "./theme";
import { vendorUrl } from "../vendorUrl";

/** One entry in a pull-down. `toggle` shows a ✓ when on; `radio` a • for the
 *  selected option of a group; `action` just runs; `sep` is a divider. */
export type MenuItem =
  | { kind: "action"; label: string; run: () => void; accel?: string }
  | { kind: "toggle"; label: string; checked: () => boolean; run: () => void; accel?: string }
  | { kind: "radio"; label: string; on: () => boolean; run: () => void; accel?: string }
  | { kind: "sep" };

/** A pull-down: a bar title and its items. `apple` styles the ι menu. */
export interface Menu {
  title: string;
  apple?: boolean;
  items: MenuItem[];
}

const PALETTE: Record<Mode, Record<string, string>> = {
  light: { bg: "#ffffff", fg: "#000000", line: "#000000", shadow: "rgba(0,0,0,0.85)" },
  dark: { bg: "#07090d", fg: "#f0f3f6", line: "#f0f3f6", shadow: "rgba(0,0,0,0.85)" },
};

const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
@font-face { font-family: 'IoskeleyMono'; src: url('${vendorUrl("vendor/fonts/IoskeleyMono-Regular.woff2")}') format('woff2'); font-display: swap; }
.mb-bar { position: fixed; top: 0; left: 0; right: 0; height: 22px; z-index: 40; display: flex; align-items: stretch;
  background: var(--mb-bg); color: var(--mb-fg); border-bottom: 1px solid var(--mb-line);
  font-family: ${MONO}; font-size: 14px; line-height: 1; user-select: none; -webkit-user-select: none; }
.mb-title { display: flex; align-items: center; padding: 0 11px; cursor: default; }
.mb-title.mb-apple { font-weight: 600; font-size: 16px; padding: 0 13px; }
.mb-title:hover, .mb-title.mb-open { background: var(--mb-fg); color: var(--mb-bg); }
.mb-menu { position: fixed; display: none; min-width: 184px; padding: 2px 0; z-index: 41;
  background: var(--mb-bg); color: var(--mb-fg); border: 1px solid var(--mb-line); box-shadow: 2px 2px 0 var(--mb-shadow);
  font-family: ${MONO}; font-size: 14px; }
.mb-item { position: relative; display: flex; justify-content: space-between; gap: 24px; padding: 2px 16px 2px 24px; white-space: nowrap; cursor: default; }
.mb-item:hover { background: var(--mb-fg); color: var(--mb-bg); }
.mb-mark { position: absolute; left: 8px; }
.mb-accel { opacity: 0.5; padding-left: 8px; }
.mb-item:hover .mb-accel { opacity: 0.85; }
.mb-sep { height: 0; margin: 3px 0; border-top: 1px solid var(--mb-line); opacity: 0.45; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

export class MenuBar {
  private readonly bar = document.createElement("div");
  private readonly dropdown = document.createElement("div");
  private readonly titleEls: HTMLElement[] = [];
  private open: number | null = null;

  constructor(private readonly menus: Menu[]) {
    injectStyles();
    this.bar.className = "mb-bar";
    this.dropdown.className = "mb-menu";
    this.applyPalette();

    this.menus.forEach((m, i) => {
      const t = document.createElement("div");
      t.className = m.apple ? "mb-title mb-apple" : "mb-title";
      t.textContent = m.title;
      t.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.open === i ? this.close() : this.openAt(i);
      });
      // Once a menu is dropped, sliding across the bar walks to the next — the
      // classic Mac behaviour.
      t.addEventListener("pointerenter", () => {
        if (this.open !== null && this.open !== i) this.openAt(i);
      });
      this.titleEls.push(t);
      this.bar.appendChild(t);
    });

    document.body.appendChild(this.bar);
    document.body.appendChild(this.dropdown);
    // Click anywhere off the bar/menu (titles + items stopPropagation) closes it.
    document.addEventListener("pointerdown", () => this.close());
    // A dropped menu owns the keyboard: Esc closes it, and we swallow keys in the
    // capture phase so the app's global shortcuts (r=clear, t=layout, …) don't fire
    // underneath an open pull-down.
    document.addEventListener(
      "keydown",
      (e) => {
        if (this.open === null) return;
        if (e.key === "Escape") this.close();
        e.stopPropagation();
      },
      true,
    );
    onThemeChange(() => this.applyPalette());
  }

  /** Re-read item states if a menu is open (e.g. a toggle changed elsewhere). */
  refresh(): void {
    if (this.open !== null) this.renderDropdown(this.open);
  }

  private applyPalette(): void {
    // The dropdown is a body child (not under the bar), so set the vars on both.
    // Don't touch other inline styles — the dropdown's display/left/top may be live.
    const p = PALETTE[currentMode()];
    for (const [k, v] of Object.entries(p)) {
      this.bar.style.setProperty(`--mb-${k}`, v);
      this.dropdown.style.setProperty(`--mb-${k}`, v);
    }
  }

  private openAt(i: number): void {
    this.open = i;
    this.titleEls.forEach((t, j) => t.classList.toggle("mb-open", j === i));
    this.renderDropdown(i);
    const r = this.titleEls[i].getBoundingClientRect();
    this.dropdown.style.left = `${Math.round(r.left)}px`;
    this.dropdown.style.top = `${Math.round(r.bottom)}px`;
    this.dropdown.style.display = "block";
  }

  private close(): void {
    if (this.open === null) return;
    this.open = null;
    this.titleEls.forEach((t) => t.classList.remove("mb-open"));
    this.dropdown.style.display = "none";
  }

  private renderDropdown(i: number): void {
    this.dropdown.replaceChildren();
    for (const it of this.menus[i].items) {
      if (it.kind === "sep") {
        const s = document.createElement("div");
        s.className = "mb-sep";
        this.dropdown.appendChild(s);
        continue;
      }
      const row = document.createElement("div");
      row.className = "mb-item";
      const mark = document.createElement("span");
      mark.className = "mb-mark";
      mark.textContent = it.kind === "toggle" ? (it.checked() ? "✓" : "") : it.kind === "radio" ? (it.on() ? "•" : "") : "";
      const label = document.createElement("span");
      label.textContent = it.label;
      row.append(mark, label);
      if (it.accel) {
        const a = document.createElement("span");
        a.className = "mb-accel";
        a.textContent = it.accel;
        row.append(a);
      }
      row.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        it.run();
        this.close();
      });
      this.dropdown.appendChild(row);
    }
  }
}

/**
 * A classic System 1 Macintosh menu bar (the 80s callback): a 1px-bordered bar
 * pinned to the top, an ι where the Apple logo went, and pull-down menus that
 * hold everything the old left rail did. Pure black-and-white chrome that inverts
 * for dark mode, set in IoskeleyMono. A DOM overlay — pull-downs are far nicer in
 * the DOM than in Pixi — driven by a plain menu spec the app supplies (reusing the
 * existing action callbacks). Click a title to drop its menu; hover the bar to
 * walk between open menus; checkmarks (✓) mark active toggles, bullets (•) the
 * selected option in a group; click outside or Esc to close.
 *
 * Fully keyboard/gamepad-navigable too (the host routes input while {@link isOpen}):
 * {@link moveMenu} switches the open top-level menu, {@link moveItem} walks the
 * highlight within the dropdown (skipping separators), {@link choose} runs the
 * highlighted item, {@link close} dismisses.
 */
import { currentMode, onThemeChange, type Mode } from "./theme";
import { vendorUrl } from "../vendorUrl";

/** One entry in a pull-down. `toggle` shows a ✓ when on; `radio` a • for the
 *  selected option of a group; `action` just runs; `sep` is a divider. `title`
 *  is an optional hover tooltip (the row's native `title` attribute). */
export type MenuItem =
  | { kind: "action"; label: string; run: () => void; accel?: string; title?: string }
  | { kind: "toggle"; label: string; checked: () => boolean; run: () => void; accel?: string; title?: string }
  | { kind: "radio"; label: string; on: () => boolean; run: () => void; accel?: string; title?: string }
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
const NARROW = 560; // below this width, collapse the six menus into one ι menu

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
.mb-menu { position: fixed; display: none; min-width: 184px; max-height: calc(100vh - 26px); overflow-y: auto; padding: 2px 0; z-index: 41;
  background: var(--mb-bg); color: var(--mb-fg); border: 1px solid var(--mb-line); box-shadow: 2px 2px 0 var(--mb-shadow);
  font-family: ${MONO}; font-size: 14px; }
.mb-header { padding: 5px 12px 2px; font-size: 11px; opacity: 0.5; letter-spacing: 0.05em; pointer-events: none; }
.mb-item { position: relative; display: flex; justify-content: space-between; gap: 24px; padding: 2px 16px 2px 24px; white-space: nowrap; cursor: default; }
.mb-item:hover, .mb-item.mb-active { background: var(--mb-fg); color: var(--mb-bg); }
.mb-mark { position: absolute; left: 8px; }
.mb-accel { opacity: 0.5; padding-left: 8px; }
.mb-item:hover .mb-accel, .mb-item.mb-active .mb-accel { opacity: 0.85; }
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
  private narrow = false; // collapsed (phone) layout: one ι menu instead of six titles
  // Keyboard/gamepad nav: the navigable rows of the open dropdown (separators excluded) and the
  // highlighted one. Rebuilt on every render; the mouse shares this cursor (pointerenter updates it).
  private navItems: { run: () => void; el: HTMLElement }[] = [];
  private activeItem = 0;

  constructor(private readonly menus: Menu[]) {
    injectStyles();
    this.bar.className = "mb-bar";
    this.dropdown.className = "mb-menu";
    this.applyPalette();

    this.buildTitles();

    document.body.appendChild(this.bar);
    document.body.appendChild(this.dropdown);
    // Rebuild the bar when crossing the narrow/wide breakpoint (collapse the menus
    // into one ι menu on phones, where six titles won't fit).
    window.addEventListener("resize", () => {
      if (this.narrow !== window.innerWidth < NARROW) {
        this.close();
        this.buildTitles();
      }
    });
    // A tap inside the dropdown (its padding / a scroll drag on mobile) must not
    // close it — only item taps (which run + close) and outside taps do.
    this.dropdown.addEventListener("pointerdown", (e) => e.stopPropagation());
    // Click anywhere off the bar/menu (titles + items stopPropagation) closes it.
    document.addEventListener("pointerdown", () => this.close());
    // The keyboard/gamepad routing of an open menu lives in the host (app.ts), mirroring the
    // context popup: it checks `isOpen` and drives moveMenu/moveItem/choose/close.
    onThemeChange(() => this.applyPalette());
  }

  /** Build the bar titles for the current width: six menu titles when wide, a
   *  single ι (that opens every command, grouped) when narrow. */
  private buildTitles(): void {
    for (const t of this.titleEls) t.remove();
    this.titleEls.length = 0;
    this.narrow = window.innerWidth < NARROW;
    if (this.narrow) {
      this.titleEls.push(this.mkTitle("ι", true, () => (this.open === 0 ? this.close() : this.openAt(0))));
    } else {
      this.menus.forEach((m, i) => {
        const t = this.mkTitle(m.title, !!m.apple, () => (this.open === i ? this.close() : this.openAt(i)));
        t.addEventListener("pointerenter", () => {
          if (this.open !== null && this.open !== i) this.openAt(i); // walk between dropped menus
        });
        this.titleEls.push(t);
      });
    }
    for (const t of this.titleEls) this.bar.appendChild(t);
  }

  private mkTitle(text: string, apple: boolean, onDown: () => void): HTMLElement {
    const t = document.createElement("div");
    t.className = apple ? "mb-title mb-apple" : "mb-title";
    t.textContent = text;
    t.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      onDown();
    });
    return t;
  }

  /** Re-read item states if a menu is open (e.g. a toggle changed elsewhere). */
  refresh(): void {
    if (this.open === null) return;
    if (this.narrow) this.renderCombined();
    else this.renderDropdown(this.open);
  }

  /** Open the menu bar programmatically (Esc in game mode → "access the menu bar"); highlights the
   *  first menu and its first item. */
  openMenuBar(): void {
    this.openAt(0);
  }

  /** Whether a pull-down is currently open (the host gates keyboard/gamepad routing on this). */
  get isOpen(): boolean {
    return this.open !== null;
  }

  /** Switch the open top-level menu by `d` (wraps); resets the item highlight to the first. The
   *  keyboard/gamepad ←/→. No-op when collapsed (the phone layout has a single ι menu). */
  moveMenu(d: number): void {
    if (this.open === null) return;
    const n = this.narrow ? 1 : this.menus.length;
    this.openAt((this.open + d + n) % n);
  }

  /** Walk the highlight within the open dropdown by `d` (wraps, separators excluded) — the
   *  keyboard/gamepad ↑/↓. */
  moveItem(d: number): void {
    if (this.open === null || this.navItems.length === 0) return;
    this.activeItem = (this.activeItem + d + this.navItems.length) % this.navItems.length;
    this.paintActiveItem();
  }

  /** Run the highlighted item, then close — the keyboard/gamepad Space/A. */
  choose(): void {
    if (this.open === null) return;
    const it = this.navItems[this.activeItem];
    this.close();
    it?.run();
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
    this.activeItem = 0; // a fresh menu highlights its first item (keyboard/gamepad start)
    this.titleEls.forEach((t, j) => t.classList.toggle("mb-open", j === i));
    if (this.narrow) this.renderCombined();
    else this.renderDropdown(i);
    this.dropdown.style.display = "block";
    // Position under the title, clamped so a wide pull-down doesn't run off-screen.
    const r = this.titleEls[this.narrow ? 0 : i].getBoundingClientRect();
    const left = Math.min(Math.round(r.left), window.innerWidth - this.dropdown.offsetWidth - 6);
    this.dropdown.style.left = `${Math.max(4, left)}px`;
    const top = Math.round(r.bottom);
    this.dropdown.style.top = `${top}px`;
    // Clamp to the *visible* viewport (window.innerHeight, not CSS 100vh — which on
    // mobile spans behind the address bar) so a tall combined menu scrolls in place
    // instead of running off the bottom of the screen.
    this.dropdown.style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
  }

  /** Dismiss the open pull-down (no-op if closed) — click-away, Esc, or the keyboard/gamepad B. */
  close(): void {
    if (this.open === null) return;
    this.open = null;
    this.titleEls.forEach((t) => t.classList.remove("mb-open"));
    this.dropdown.style.display = "none";
  }

  private renderDropdown(i: number): void {
    this.navItems = []; // itemEl repopulates this as it builds the rows
    this.dropdown.replaceChildren(...this.menus[i].items.map((it) => this.itemEl(it)));
    this.paintActiveItem();
  }

  /** The whole menu as one list (phone layout): each menu's items under a header. */
  private renderCombined(): void {
    this.navItems = [];
    this.dropdown.replaceChildren();
    this.menus.forEach((m, mi) => {
      if (mi > 0) this.dropdown.appendChild(this.itemEl({ kind: "sep" }));
      const h = document.createElement("div");
      h.className = "mb-header";
      h.textContent = m.apple ? "Combinate" : m.title;
      this.dropdown.appendChild(h);
      for (const it of m.items) this.dropdown.appendChild(this.itemEl(it));
    });
    this.paintActiveItem();
  }

  /** Paint the active-row highlight (keyboard/gamepad cursor), clamping if the list shrank. */
  private paintActiveItem(): void {
    if (this.activeItem >= this.navItems.length) this.activeItem = Math.max(0, this.navItems.length - 1);
    this.navItems.forEach((r, i) => r.el.classList.toggle("mb-active", i === this.activeItem));
  }

  private itemEl(it: MenuItem): HTMLElement {
    if (it.kind === "sep") {
      const s = document.createElement("div");
      s.className = "mb-sep";
      return s;
    }
    const row = document.createElement("div");
    row.className = "mb-item";
    if (it.title) row.title = it.title; // native hover tooltip (e.g. an optimization's description)
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
    // Fire on tap, not pointerdown — otherwise a touch *scroll* of a tall (phone)
    // menu triggers whatever option you started the drag on. Run only if the
    // pointer didn't move (a tap); a drag scrolls the dropdown instead.
    let downY = 0;
    let moved = false;
    row.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // keep the backdrop-close from firing
      downY = e.clientY;
      moved = false;
    });
    row.addEventListener("pointermove", (e) => {
      if (Math.abs(e.clientY - downY) > 8) moved = true;
    });
    row.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      if (moved) return; // a scroll, not a tap
      it.run();
      this.close();
    });
    // Register as a navigable row + let the mouse share the keyboard/gamepad cursor (hover = highlight).
    const navIndex = this.navItems.length;
    this.navItems.push({ run: it.run, el: row });
    row.addEventListener("pointerenter", () => {
      this.activeItem = navIndex;
      this.paintActiveItem();
    });
    return row;
  }
}

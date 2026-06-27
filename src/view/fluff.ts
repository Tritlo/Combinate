/**
 * "Fluff" — the optional playful-life layer, and its settings. A System-1
 * Macintosh-styled DOM modal (like {@link About}) with classic Mac checkboxes: a
 * master on/off plus one toggle per effect, persisted to localStorage, on by
 * default. Effects read {@link isFluff} at runtime; all-off (or master off) is the
 * current crisp, fast view. Motion effects should also respect
 * {@link prefersReducedMotion} and the tree's HEAVY jump-cut threshold.
 */
import { currentMode, onThemeChange, type Mode } from "./theme";
import { vendorUrl } from "../vendorUrl";

/** The individually-toggleable fluff effects. */
export type FluffKey = "grabPop" | "redexAnts" | "drift" | "leaves" | "zooTone" | "discovery" | "livingZoo";

const EFFECTS: { key: FluffKey; label: string; desc: string }[] = [
  { key: "grabPop", label: "Grab & spawn pops", desc: "Nodes scale in when you pull or drop them." },
  { key: "redexAnts", label: "Marching ants", desc: "Dashes crawl along a redex just before it fires." },
  { key: "drift", label: "Water drift", desc: "Leaves sway gently, as if floating in water." },
  { key: "leaves", label: "Leaf nodes", desc: "Draw the leaves as leaves, on the edge-vines." },
  { key: "zooTone", label: "Zoo tones", desc: "Play a creature's tone when you open its page." },
  { key: "discovery", label: "Discovery fanfare", desc: "Stamp the bird's name and chirp when you find one." },
  { key: "livingZoo", label: "Living Zoo", desc: "The Zoo's creatures drift and breathe." },
];

const STORE_KEY = "combinate:fluff:v1";

interface FluffState {
  on: boolean; // master switch
  fx: Record<FluffKey, boolean>;
}

function defaults(): FluffState {
  const fx = {} as Record<FluffKey, boolean>;
  for (const e of EFFECTS) fx[e.key] = true;
  return { on: true, fx };
}

function load(): FluffState {
  const d = defaults();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return d;
    const saved = JSON.parse(raw) as Partial<FluffState>;
    return { on: saved.on ?? d.on, fx: { ...d.fx, ...(saved.fx ?? {}) } };
  } catch {
    return d;
  }
}

const state: FluffState = load();
const listeners: Array<() => void> = [];

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

/** Is `key` active right now? (master on AND that effect on). */
export function isFluff(key: FluffKey): boolean {
  return state.on && state.fx[key];
}
/** The master switch state — for the menu checkmark. */
export function fluffOn(): boolean {
  return state.on;
}
/** Register a callback to run after any fluff setting changes. */
export function onFluffChange(cb: () => void): void {
  listeners.push(cb);
}
/** Does the user prefer reduced motion? Motion effects must honour this. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

const PALETTE: Record<Mode, Record<string, string>> = {
  light: { paper: "#ffffff", ink: "#000000", backdrop: "rgba(27,31,36,0.5)", shadow: "rgba(0,0,0,0.85)" },
  dark: { paper: "#07090d", ink: "#f0f3f6", backdrop: "rgba(1,4,9,0.6)", shadow: "rgba(0,0,0,0.85)" },
};
const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
@font-face { font-family: 'IoskeleyMono'; src: url('${vendorUrl("vendor/fonts/IoskeleyMono-Regular.woff2")}') format('woff2'); font-display: swap; }
.fl-root { position: fixed; inset: 0; z-index: 60; display: none; align-items: center; justify-content: center;
  background: var(--fl-backdrop); font-family: ${MONO}; }
.fl-card { width: min(440px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--fl-paper); color: var(--fl-ink); border: 1px solid var(--fl-ink); box-shadow: 2px 2px 0 var(--fl-shadow); }
.fl-title { display: flex; align-items: center; gap: 10px; padding: 4px 10px; background: var(--fl-ink); color: var(--fl-paper); }
.fl-close { width: 12px; height: 12px; border: 1.5px solid var(--fl-paper); cursor: pointer; flex: 0 0 auto; }
.fl-title span { font-weight: 600; font-size: 14px; }
.fl-body { padding: 14px 18px 16px; overflow-y: auto; font-size: 14px; }
.fl-row { display: flex; align-items: flex-start; gap: 10px; padding: 7px 4px; cursor: pointer; user-select: none; }
.fl-row:hover { background: color-mix(in srgb, var(--fl-ink) 8%, transparent); }
.fl-box { width: 15px; height: 15px; flex: 0 0 auto; margin-top: 1px; border: 1.5px solid var(--fl-ink);
  display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; line-height: 1; }
.fl-master { border-bottom: 1px solid color-mix(in srgb, var(--fl-ink) 35%, transparent); margin-bottom: 4px; padding-bottom: 9px; }
.fl-master .fl-label { font-size: 15px; font-weight: 600; }
.fl-label { font-weight: 600; }
.fl-desc { opacity: 0.6; font-size: 12.5px; margin-top: 1px; }
.fl-fx.fl-off { opacity: 0.4; }
.fl-foot { display: flex; justify-content: flex-end; padding: 0 18px 16px; }
.fl-done { font-family: ${MONO}; font-size: 13px; font-weight: 600; color: var(--fl-paper); background: var(--fl-ink);
  border: 1px solid var(--fl-ink); padding: 4px 16px; cursor: pointer; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** The Fluff settings window (opened from View ▸ Fluff…). */
export class FluffPanel {
  private readonly root = document.createElement("div");
  private readonly fxWrap = document.createElement("div");

  constructor() {
    injectStyles();
    this.root.className = "fl-root";
    this.applyPalette();
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });

    const card = document.createElement("div");
    card.className = "fl-card";
    card.addEventListener("pointerdown", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "fl-title";
    const close = document.createElement("div");
    close.className = "fl-close";
    close.title = "Close";
    close.addEventListener("pointerdown", () => this.close());
    const label = document.createElement("span");
    label.textContent = "Fluff";
    title.append(close, label);

    const body = document.createElement("div");
    body.className = "fl-body";
    body.append(
      this.row("master", "Fluff", "Playful extras. Off keeps the plain, fast view.", true),
      this.fxWrap,
    );
    this.fxWrap.className = "fl-fx";
    for (const e of EFFECTS) this.fxWrap.append(this.row(e.key, e.label, e.desc, false));

    const foot = document.createElement("div");
    foot.className = "fl-foot";
    const done = document.createElement("button");
    done.className = "fl-done";
    done.textContent = "Done";
    done.addEventListener("pointerdown", () => this.close());
    foot.append(done);

    card.append(title, body, foot);
    this.root.append(card);
    document.body.append(this.root);
    onThemeChange(() => this.applyPalette());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.root.style.display === "flex") this.close();
    });
    this.sync();
  }

  /** A checkbox row. `master` rows toggle the whole layer; others toggle one effect. */
  private row(key: FluffKey | "master", labelText: string, descText: string, master: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = master ? "fl-row fl-master" : "fl-row";
    const box = document.createElement("div");
    box.className = "fl-box";
    box.dataset.key = key;
    const text = document.createElement("div");
    const lab = document.createElement("div");
    lab.className = "fl-label";
    lab.textContent = labelText;
    const desc = document.createElement("div");
    desc.className = "fl-desc";
    desc.textContent = descText;
    text.append(lab, desc);
    row.append(box, text);
    row.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (master) state.on = !state.on;
      else state.fx[key as FluffKey] = !state.fx[key as FluffKey];
      save();
      this.sync();
    });
    return row;
  }

  /** Reflect `state` into every checkbox + dim the effects when the master is off. */
  private sync(): void {
    const mark = (on: boolean): string => (on ? "✓" : "");
    (this.root.querySelector('.fl-box[data-key="master"]') as HTMLElement).textContent = mark(state.on);
    for (const e of EFFECTS) {
      (this.root.querySelector(`.fl-box[data-key="${e.key}"]`) as HTMLElement).textContent = mark(state.fx[e.key]);
    }
    this.fxWrap.classList.toggle("fl-off", !state.on);
  }

  open(): void {
    this.root.style.display = "flex";
  }
  close(): void {
    this.root.style.display = "none";
  }
  toggle(): void {
    if (this.root.style.display === "flex") this.close();
    else this.open();
  }

  private applyPalette(): void {
    const p = PALETTE[currentMode()];
    for (const [k, v] of Object.entries(p)) this.root.style.setProperty(`--fl-${k}`, v);
  }
}

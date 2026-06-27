/**
 * "Optimizations" — reduction optimizations and their settings. A System-1 Macintosh
 * DOM modal (like {@link FluffPanel}) with classic Mac checkboxes, persisted to
 * localStorage. Unlike Fluff there's no master switch: each optimization is an
 * independent capability. All off = the plain pure-ι reducer (the default, ground
 * truth). The shell reads {@link isOpt} and reacts to {@link onOptChange}; every
 * write goes through {@link setOpt} so the modal, permalinks, and the dev seam agree.
 */
import { currentMode, onThemeChange, type Mode } from "./theme";
import { vendorUrl } from "../vendorUrl";

/** A toggleable reduction optimization. */
export type OptKey = "rules" | "graph" | "nativeNumbers";

const SETTINGS: { key: OptKey; label: string; desc: string }[] = [
  { key: "rules", label: "Optimize (rule steps)", desc: "Reduce a named combinator by its law in one step, not its raw ι/SKI tree." },
  { key: "graph", label: "Graph reduction (DAG)", desc: "Call-by-need sharing — a shared subterm is drawn and reduced once." },
  { key: "nativeNumbers", label: "Native numbers", desc: "Compute catalog arithmetic (+, ×, =, <, …) on whole numbers directly." },
];

const STORE_KEY = "combinate:optimize:v1";

type OptState = Record<OptKey, boolean>;

function defaults(): OptState {
  const s = {} as OptState;
  for (const e of SETTINGS) s[e.key] = false; // off = the plain pure-ι reducer
  return s;
}

function load(): OptState {
  const d = defaults();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return d;
    return { ...d, ...(JSON.parse(raw) as Partial<OptState>) };
  } catch {
    return d;
  }
}

const state: OptState = load();
const listeners: Array<(key: OptKey) => void> = [];

/** Is optimization `key` on right now? */
export function isOpt(key: OptKey): boolean {
  return state[key];
}
/** Set optimization `key` and notify — the single write path. `persist` (default
 *  true) writes to localStorage; pass `false` for a transient override that mustn't
 *  change the user's saved preference (e.g. restoring a permalink's tree-local modes,
 *  which still need to drive the reducer + reflect in the modal). */
export function setOpt(key: OptKey, val: boolean, persist = true): void {
  if (state[key] === val) return;
  state[key] = val;
  if (persist) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }
  for (const l of listeners) l(key);
}
/** Run `cb(changedKey)` after any optimization toggles. */
export function onOptChange(cb: (key: OptKey) => void): void {
  listeners.push(cb);
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
.op-root { position: fixed; inset: 0; z-index: 60; display: none; align-items: center; justify-content: center;
  background: var(--op-backdrop); font-family: ${MONO}; }
.op-card { width: min(460px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--op-paper); color: var(--op-ink); border: 1px solid var(--op-ink); box-shadow: 2px 2px 0 var(--op-shadow); }
.op-title { display: flex; align-items: center; gap: 10px; padding: 4px 10px; background: var(--op-ink); color: var(--op-paper); }
.op-close { width: 12px; height: 12px; border: 1.5px solid var(--op-paper); cursor: pointer; flex: 0 0 auto; }
.op-title span { font-weight: 600; font-size: 14px; }
.op-body { padding: 14px 18px 16px; overflow-y: auto; font-size: 14px; }
.op-row { display: flex; align-items: flex-start; gap: 10px; padding: 7px 4px; cursor: pointer; user-select: none; }
.op-row:hover { background: color-mix(in srgb, var(--op-ink) 8%, transparent); }
.op-box { width: 15px; height: 15px; flex: 0 0 auto; margin-top: 1px; border: 1.5px solid var(--op-ink);
  display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; line-height: 1; }
.op-label { font-weight: 600; }
.op-desc { opacity: 0.6; font-size: 12.5px; margin-top: 1px; }
.op-foot { display: flex; justify-content: flex-end; padding: 0 18px 16px; }
.op-done { font-family: ${MONO}; font-size: 13px; font-weight: 600; color: var(--op-paper); background: var(--op-ink);
  border: 1px solid var(--op-ink); padding: 4px 16px; cursor: pointer; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** The Optimizations settings window (opened from Reduce ▸ Optimizations…). */
export class OptimizePanel {
  private readonly root = document.createElement("div");

  constructor() {
    injectStyles();
    this.root.className = "op-root";
    this.applyPalette();
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });

    const card = document.createElement("div");
    card.className = "op-card";
    card.addEventListener("pointerdown", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "op-title";
    const close = document.createElement("div");
    close.className = "op-close";
    close.title = "Close";
    close.addEventListener("pointerdown", () => this.close());
    const label = document.createElement("span");
    label.textContent = "Optimizations";
    title.append(close, label);

    const body = document.createElement("div");
    body.className = "op-body";
    for (const e of SETTINGS) body.append(this.row(e.key, e.label, e.desc));

    const foot = document.createElement("div");
    foot.className = "op-foot";
    const done = document.createElement("button");
    done.className = "op-done";
    done.textContent = "Done";
    done.addEventListener("pointerdown", () => this.close());
    foot.append(done);

    card.append(title, body, foot);
    this.root.append(card);
    document.body.append(this.root);
    onThemeChange(() => this.applyPalette());
    onOptChange(() => this.sync()); // reflect changes from any source (modal, permalink, seam)
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.root.style.display === "flex") this.close();
    });
    this.sync();
  }

  private row(key: OptKey, labelText: string, descText: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "op-row";
    const box = document.createElement("div");
    box.className = "op-box";
    box.dataset.key = key;
    const text = document.createElement("div");
    const lab = document.createElement("div");
    lab.className = "op-label";
    lab.textContent = labelText;
    const desc = document.createElement("div");
    desc.className = "op-desc";
    desc.textContent = descText;
    text.append(lab, desc);
    row.append(box, text);
    row.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      setOpt(key, !isOpt(key));
    });
    return row;
  }

  private sync(): void {
    for (const e of SETTINGS) {
      (this.root.querySelector(`.op-box[data-key="${e.key}"]`) as HTMLElement).textContent = isOpt(e.key) ? "✓" : "";
    }
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
    for (const [k, v] of Object.entries(p)) this.root.style.setProperty(`--op-${k}`, v);
  }
}

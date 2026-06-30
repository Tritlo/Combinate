/**
 * "Optimizations" — reduction optimizations and their settings. The window chrome is the
 * shared {@link SettingsModal} (ADR 12); this file is just the store + the spec. No master
 * switch: each optimization is an independent capability; all off = the plain pure-ι
 * reducer (the default, ground truth). The shell reads {@link isOpt} and reacts to
 * {@link onOptChange}; every write goes through {@link setOpt} so the modal, permalinks,
 * and the dev seam agree.
 */
import { SettingsModal } from "./modal";

/** A toggleable reduction optimization. */
export type OptKey = "rules" | "graph" | "nativeNumbers" | "nativeLists" | "nativeBooleans" | "wasm";

const SETTINGS: { key: OptKey; label: string; desc: string }[] = [
  { key: "rules", label: "Optimize (rule steps)", desc: "Reduce a named combinator by its law in one step, not its raw ι/SKI tree." },
  { key: "graph", label: "Graph reduction (DAG)", desc: "Call-by-need sharing — a shared subterm is drawn and reduced once." },
  { key: "nativeNumbers", label: "Native numbers", desc: "Compute catalog arithmetic (+, ×, =, <, …) on whole numbers directly." },
  { key: "nativeLists", label: "Native lists", desc: "Evaluate list ops (<>, map, concat) on recognised lists directly." },
  { key: "nativeBooleans", label: "Native booleans", desc: "Evaluate not, and, or on recognised booleans directly." },
  { key: "wasm", label: "Turbo (wasm)", desc: "Reduce big trees in WebAssembly with call-by-need sharing + native number/list/bool kernels — fast, no blow-up. Auto-engages once a tree is big (small trees keep the step-by-step animation). Off while the rule-steps or graph option is on." },
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
/** Set optimization `key` and notify — the single write path. `persist` (default true)
 *  writes to localStorage; pass `false` for a transient override that mustn't change the
 *  user's saved preference (e.g. restoring a permalink's tree-local modes, which still
 *  need to drive the reducer + reflect in the modal). */
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

/** The Optimizations settings window (opened from Reduce ▸ Optimizations…). */
export class OptimizePanel extends SettingsModal {
  constructor() {
    super({
      title: "Optimizations",
      rows: SETTINGS,
      checked: (k) => isOpt(k as OptKey),
      toggle: (k) => setOpt(k as OptKey, !isOpt(k as OptKey)),
    });
    onOptChange(() => this.sync()); // reflect changes from any source (modal, permalink, seam)
  }
}

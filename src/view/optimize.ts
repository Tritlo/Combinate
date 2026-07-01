/**
 * "Optimizations" — reduction optimizations and their settings. This file is the store + the
 * spec ({@link OPT_SETTINGS}); the UI is a dropdown menu the shell builds from the spec. No master
 * switch: each optimization is an independent capability; all off = the plain pure-ι reducer (the
 * default, ground truth). The shell reads {@link isOpt} and reacts to {@link onOptChange}; every
 * write goes through {@link setOpt} so the menu, permalinks, and the dev seam agree.
 */

/** A toggleable reduction optimization. */
export type OptKey = "rules" | "graph" | "nativeNumbers" | "nativeLists" | "nativeBooleans" | "wasm";

/** The optimizations, in menu order — label + a one-line description (the menu shows the label). */
export const OPT_SETTINGS: { key: OptKey; label: string; desc: string }[] = [
  { key: "rules", label: "Rule-Based Reduction", desc: "Reduce a named combinator by its law in one step, not its raw ι/SKI tree." },
  { key: "graph", label: "Graph Reduction (DAG)", desc: "Call-by-need sharing — a shared subterm is drawn and reduced once." },
  { key: "nativeNumbers", label: "Native Numbers", desc: "Compute catalog arithmetic (+, ×, =, <, …) on whole numbers directly." },
  { key: "nativeLists", label: "Native Lists", desc: "Evaluate list ops (<>, map, concat) on recognised lists directly." },
  { key: "nativeBooleans", label: "Native Booleans", desc: "Evaluate not, and, or on recognised booleans directly." },
  { key: "wasm", label: "Turbo", desc: "Reduce big trees in WebAssembly with call-by-need sharing + native number/list/bool kernels, and — with Rule-Based Reduction on — the catalog rules too (the fastest tier). Auto-engages once a tree is big (small trees keep the step-by-step animation). Off while Graph Reduction is on (that owns its own reducer)." },
];

const STORE_KEY = "combinate:optimize:v1";

type OptState = Record<OptKey, boolean>;

function defaults(): OptState {
  const s = {} as OptState;
  for (const e of OPT_SETTINGS) s[e.key] = false;
  // Default to rule-based reduction + native value ops (Primitives). Rules reduces a named combinator by
  // its law (no ι blow-up) so most programs terminate; native computes recognised numbers/lists/booleans
  // directly on top. Benchmarks: rules+native is the cheapest mode across the board (native ALONE is
  // worse — it needs rules to keep the structure from exploding). Turn them off for the raw pure-ι grind.
  s.rules = true;
  s.nativeNumbers = true;
  s.nativeLists = true;
  s.nativeBooleans = true;
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
 *  need to drive the reducer + reflect in the menu). */
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

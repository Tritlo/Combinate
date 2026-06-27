/**
 * "Fluff" — the optional playful-life layer, and its settings. The window chrome is the
 * shared {@link SettingsModal} (ADR 12); this file is the store + the spec. A master
 * on/off plus one toggle per effect, persisted to localStorage, on by default. Effects
 * read {@link isFluff} at runtime; all-off (or master off) is the crisp, fast view.
 * Motion effects should also respect {@link prefersReducedMotion} and the tree's HEAVY
 * jump-cut threshold.
 */
import { SettingsModal } from "./modal";

/** The individually-toggleable fluff effects. (Grab/spawn pop isn't here — it's
 *  always on, gated only by reduced-motion.) */
export type FluffKey = "redexAnts" | "drift" | "leaves" | "zooTone" | "discovery" | "livingZoo";

const EFFECTS: { key: FluffKey; label: string; desc: string }[] = [
  { key: "drift", label: "Water drift", desc: "Nodes sway gently, as if floating in water." },
  { key: "leaves", label: "Leaf nodes", desc: "Draw the leaf nodes as leaves, on the edge-vines." },
  { key: "redexAnts", label: "Marching ants", desc: "Dashes crawl along a redex just before it fires." },
  { key: "zooTone", label: "Zoo tones", desc: "Play a creature's tone when you open its page." },
  { key: "discovery", label: "Discovery fanfare", desc: "Stamp the bird's name and chirp when you find one." },
  { key: "livingZoo", label: "Living Zoo", desc: "The Zoo's creatures drift and breathe." },
];

const STORE_KEY = "combinate:fluff:v2"; // v2: effects now opt-in (was all-on) — reset saved state

interface FluffState {
  on: boolean; // master switch
  fx: Record<FluffKey, boolean>;
}

function defaults(): FluffState {
  const fx = {} as Record<FluffKey, boolean>;
  for (const e of EFFECTS) fx[e.key] = false; // the ambient/extra effects are opt-in; grab/spawn pop is always on
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

// Resolved once (not per call): prefersReducedMotion is polled every frame by the
// drift ticker, so don't re-create a MediaQueryList each time.
const reducedMotionMQ = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined;
/** Does the user prefer reduced motion? Motion effects must honour this. */
export function prefersReducedMotion(): boolean {
  return !!reducedMotionMQ?.matches;
}

/** The Fluff settings window (opened from View ▸ Fluff…). */
export class FluffPanel extends SettingsModal {
  constructor() {
    super({
      title: "Fluff",
      width: "min(440px, 92vw)", // Fluff's pre-refactor width (the base default is 460px)
      rows: EFFECTS,
      checked: (k) => state.fx[k as FluffKey],
      toggle: (k) => {
        state.fx[k as FluffKey] = !state.fx[k as FluffKey];
        save();
      },
      master: {
        label: "Fluff",
        desc: "Playful extras. Off keeps the plain, fast view.",
        on: () => state.on,
        toggle: () => {
          state.on = !state.on;
          save();
        },
      },
    });
    onFluffChange(() => this.sync()); // reflect external changes (and re-sync after save())
  }
}

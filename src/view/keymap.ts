/**
 * The control scheme as data (ADR 17, redesigned for 2D Build + 3D Inspect). The single source
 * for BOTH input (key/button → intent, per context) AND the on-screen hints (each action's
 * keyboard + gamepad glyph). The contexts are mutually exclusive for the discrete layer: the
 * same directional input NAVIGATES in Build and ORBITS in Inspect, so bindings are looked up per
 * context. The mouse/touch canvas + the global menu shortcuts live outside this (always there).
 *
 * Keys match a lower-cased `KeyboardEvent.key` ("ArrowLeft" → "arrowleft", Space → " "). Gamepad
 * button indices are the W3C "standard" layout; analog input (sticks/triggers) is handled in the
 * gamepad layer, not here. The Build intent names match {@link GameInputController}'s dispatch.
 */

/** The interactive contexts that own the discrete input + show contextual hints. */
export type Context = "build" | "inspect";

/** A discrete action. The controllers turn a key/button into one of these for the active context. */
export type Intent =
  // build (2D bucket tray)
  | "moveLeft"
  | "moveRight"
  | "moveUp"
  | "moveDown"
  | "pagePrev"
  | "pageNext"
  | "pickPlace"
  | "applyFn"
  | "applyArg"
  | "cancel"
  | "context"
  | "speed"
  | "enterInspect"
  // inspect (3D orbit)
  | "rotLeft"
  | "rotRight"
  | "rotUp"
  | "rotDown"
  | "zoomIn"
  | "zoomOut"
  | "recenter"
  | "exitInspect";

// ---- keyboard: per-context key → intent ----
interface KeyBind {
  context: Context | "global";
  intent: Intent;
  keys: string[];
}
const KEY_BINDS: KeyBind[] = [
  // Build
  { context: "build", intent: "moveLeft", keys: ["arrowleft"] },
  { context: "build", intent: "moveRight", keys: ["arrowright"] },
  { context: "build", intent: "moveUp", keys: ["arrowup"] },
  { context: "build", intent: "moveDown", keys: ["arrowdown"] },
  { context: "build", intent: "pagePrev", keys: ["["] },
  { context: "build", intent: "pageNext", keys: ["]"] },
  { context: "build", intent: "pickPlace", keys: [" ", "enter"] },
  { context: "build", intent: "cancel", keys: ["escape"] },
  { context: "build", intent: "context", keys: ["c"] }, // open the Delete/Copy menu on the focused bucket
  { context: "build", intent: "speed", keys: ["0", "1", "2", "3", "4"] },
  { context: "build", intent: "enterInspect", keys: ["v"] },
  // Inspect
  { context: "inspect", intent: "rotLeft", keys: ["arrowleft"] },
  { context: "inspect", intent: "rotRight", keys: ["arrowright"] },
  { context: "inspect", intent: "rotUp", keys: ["arrowup"] },
  { context: "inspect", intent: "rotDown", keys: ["arrowdown"] },
  { context: "inspect", intent: "zoomIn", keys: ["=", "+"] },
  { context: "inspect", intent: "zoomOut", keys: ["-", "_"] },
  { context: "inspect", intent: "recenter", keys: ["r"] },
  { context: "inspect", intent: "exitInspect", keys: ["escape", "v"] },
];

const KEY_MAP = new Map<string, Intent>(); // `${context}:${key}` → intent
for (const b of KEY_BINDS) for (const k of b.keys) KEY_MAP.set(`${b.context}:${k}`, b.intent);

/** The intent a key fires in `context` (a global binding wins), or null. */
export function intentForKey(context: Context, key: string): Intent | null {
  const k = key.toLowerCase();
  return KEY_MAP.get(`global:${k}`) ?? KEY_MAP.get(`${context}:${k}`) ?? null;
}

// ---- gamepad: W3C standard button index → intent, per context (analog handled separately) ----
export const PAD_BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, R3: 11, DUP: 12, DDOWN: 13, DLEFT: 14, DRIGHT: 15 };
const PAD_BINDS: Record<Context | "global", Partial<Record<number, Intent>>> = {
  global: {},
  build: {
    [PAD_BUTTON.DLEFT]: "moveLeft",
    [PAD_BUTTON.DRIGHT]: "moveRight",
    [PAD_BUTTON.DUP]: "moveUp",
    [PAD_BUTTON.DDOWN]: "moveDown",
    [PAD_BUTTON.A]: "pickPlace",
    [PAD_BUTTON.B]: "cancel",
    [PAD_BUTTON.X]: "context", // open the Delete/Copy menu on the focused bucket
    [PAD_BUTTON.Y]: "enterInspect",
    [PAD_BUTTON.SELECT]: "speed",
  },
  inspect: {
    [PAD_BUTTON.DLEFT]: "rotLeft",
    [PAD_BUTTON.DRIGHT]: "rotRight",
    [PAD_BUTTON.DUP]: "rotUp",
    [PAD_BUTTON.DDOWN]: "rotDown",
    [PAD_BUTTON.B]: "exitInspect",
    [PAD_BUTTON.Y]: "exitInspect",
    [PAD_BUTTON.R3]: "recenter",
  },
};
/** The intent a gamepad button fires in `context` (a global binding wins), or null. */
export function intentForPad(context: Context, button: number): Intent | null {
  return PAD_BINDS.global[button] ?? PAD_BINDS[context][button] ?? null;
}

// ---- contextual hints (curated per context; both glyphs, the active device picks one) ----
export interface Hint {
  label: string;
  kbd: string; // keyboard glyph(s)
  pad: string; // gamepad glyph(s)
}
export const HINTS: Record<Context, Hint[]> = {
  build: [
    { label: "Move", kbd: "←→", pad: "✚" },
    { label: "Pick up / Place", kbd: "Space", pad: "Ⓐ" },
    { label: "Drop", kbd: "Esc", pad: "Ⓑ" },
    { label: "3D", kbd: "V", pad: "Ⓨ" },
  ],
  inspect: [
    { label: "Rotate", kbd: "↑↓←→", pad: "L-stick" },
    { label: "Zoom", kbd: "− +", pad: "LT RT" },
    { label: "Recenter", kbd: "R", pad: "R3" },
    { label: "Exit", kbd: "Esc", pad: "Ⓑ" },
  ],
};

/** A key's printable glyph (Space, ↵, ←, …) for hints/reference. */
export function keyGlyph(key: string): string {
  const map: Record<string, string> = { " ": "Space", enter: "↵", escape: "Esc", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", tab: "Tab" };
  return map[key] ?? key.toUpperCase();
}

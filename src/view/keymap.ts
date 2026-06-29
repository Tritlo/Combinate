/**
 * The game-mode control scheme as data (ADR 17): each intent → the keyboard keys that fire
 * it + the gamepad button it maps to. Single source of truth, consumed by the
 * `GameInputController` (key → intent) and rendered by the keybinds reference page. Keeping
 * it here means the gamepad layer (later) binds the same intents, and the help page can never
 * drift from the real bindings.
 *
 * Keys are matched against a lower-cased `KeyboardEvent.key` (so "ArrowLeft" → "arrowleft",
 * Space → " ", "Escape" → "escape"). `speed` is the one many-key intent: its digit IS the
 * level, so the controller reads `parseInt(key)` rather than needing five intents.
 */

/** A discrete game action. The controller turns a key/button into one of these. */
export type Intent =
  | "moveLeft"
  | "moveRight"
  | "moveUp"
  | "moveDown"
  | "pickPlace"
  | "applyFn"
  | "applyArg"
  | "cancel"
  | "pagePrev"
  | "pageNext"
  | "panUp"
  | "panDown"
  | "panLeft"
  | "panRight"
  | "zoomIn"
  | "zoomOut"
  | "speed";

/** One binding row: an intent, its human label, the keyboard keys, and the gamepad button. */
export interface KeyBind {
  intent: Intent;
  label: string;
  keys: string[]; // lower-cased KeyboardEvent.key values
  pad: string; // gamepad button (documentation; the pad layer binds the same intent)
  group: "Navigate" | "Build" | "Camera" | "Playback";
}

/** The control scheme. Order is the display order on the keybinds page. */
export const KEYBINDS: KeyBind[] = [
  { intent: "moveLeft", label: "Cursor left · previous bucket", keys: ["arrowleft", "a"], pad: "D-pad ◄", group: "Navigate" },
  { intent: "moveRight", label: "Cursor right · next bucket", keys: ["arrowright", "d"], pad: "D-pad ►", group: "Navigate" },
  { intent: "moveUp", label: "Up to the toolbar", keys: ["arrowup", "w"], pad: "D-pad ▲", group: "Navigate" },
  { intent: "moveDown", label: "Down to the buckets", keys: ["arrowdown", "s"], pad: "D-pad ▼", group: "Navigate" },
  { intent: "pagePrev", label: "Previous toolbar page", keys: ["["], pad: "D-pad ◄ at edge", group: "Navigate" },
  { intent: "pageNext", label: "Next toolbar page", keys: ["]"], pad: "D-pad ► at edge", group: "Navigate" },

  { intent: "pickPlace", label: "Pick up · place · drop", keys: [" ", "enter"], pad: "A", group: "Build" },
  { intent: "applyFn", label: "Apply held as function — left child", keys: ["q"], pad: "LB", group: "Build" },
  { intent: "applyArg", label: "Apply held as argument — right child", keys: ["e"], pad: "RB", group: "Build" },
  { intent: "cancel", label: "Cancel held · open the menu", keys: ["escape"], pad: "B", group: "Build" },

  { intent: "panUp", label: "Pan up", keys: ["i"], pad: "R-stick ▲", group: "Camera" },
  { intent: "panLeft", label: "Pan left", keys: ["j"], pad: "R-stick ◄", group: "Camera" },
  { intent: "panDown", label: "Pan down", keys: ["k"], pad: "R-stick ▼", group: "Camera" },
  { intent: "panRight", label: "Pan right", keys: ["l"], pad: "R-stick ►", group: "Camera" },
  { intent: "zoomIn", label: "Zoom in", keys: ["=", "+", "z"], pad: "RT", group: "Camera" },
  { intent: "zoomOut", label: "Zoom out", keys: ["-", "_", "x"], pad: "LT", group: "Camera" },

  { intent: "speed", label: "Reduction speed — 0 pause · 1× · 2× · 4× · 8×", keys: ["0", "1", "2", "3", "4"], pad: "Select cycles", group: "Playback" },
];

const KEY_TO_INTENT = new Map<string, Intent>();
for (const b of KEYBINDS) for (const k of b.keys) KEY_TO_INTENT.set(k, b.intent);

/** The intent a key fires in game mode, or null if it isn't bound (let it through). */
export function intentForKey(key: string): Intent | null {
  return KEY_TO_INTENT.get(key.toLowerCase()) ?? null;
}

/** The display groups in order, each with its rows — for the keybinds page. */
export function keybindGroups(): { group: string; binds: KeyBind[] }[] {
  const order = ["Navigate", "Build", "Camera", "Playback"];
  return order.map((group) => ({ group, binds: KEYBINDS.filter((b) => b.group === group) }));
}

/** A key's printable glyph for the help page (Space, ↵, ←, etc.). */
export function keyGlyph(key: string): string {
  const map: Record<string, string> = { " ": "Space", enter: "↵", escape: "Esc", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓" };
  return map[key] ?? key.toUpperCase();
}

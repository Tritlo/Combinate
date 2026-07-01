/**
 * The active input device (ADR 17) — "last input wins", the video-game standard: the moment a
 * gamepad action is detected the UI switches to gamepad glyphs/prompts; the moment you touch the
 * keyboard or mouse it switches back. The three devices are distinct (mouse vs keyboard vs pad):
 * mouse means the controls' visuals/hints stay hidden, keyboard/pad show them. Keyed off detected
 * ACTIONS, not the `gamepadconnected` event (Chrome withholds that until first input anyway), so a
 * plugged-in-but-idle pad never forces gamepad hints. The hint system reads {@link activeDevice}
 * to pick which glyph to show (and whether to show anything at all).
 */
export type Device = "mouse" | "keyboard" | "pad";

let active: Device = "mouse";
const listeners: Array<(d: Device) => void> = [];

/** The device that last produced a real (dispatched) action. */
export function activeDevice(): Device {
  return active;
}

function set(d: Device): void {
  if (active === d) return;
  active = d;
  for (const l of listeners) l(d);
}

/** A mouse/touch action fired (canvas pointerdown / wheel) — hide the controls' visuals + hints. */
export function noteMouse(): void {
  set("mouse");
}
/** A keyboard action fired — switch hints to keyboard glyphs. */
export function noteKeyboard(): void {
  set("keyboard");
}
/** A gamepad action fired (button edge / stick past deadzone) — switch hints to gamepad glyphs. */
export function notePad(): void {
  set("pad");
}

/** Run `cb` whenever the active device flips (so the HUD can repaint its hint glyphs). */
export function onDeviceChange(cb: (d: Device) => void): void {
  listeners.push(cb);
}

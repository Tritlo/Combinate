/**
 * The active input device (ADR 17) — "last input wins", the video-game standard: the moment a
 * gamepad action is detected the UI switches to gamepad glyphs/prompts; the moment you touch
 * keyboard or mouse it switches back. Keyed off detected ACTIONS, not the `gamepadconnected`
 * event (Chrome withholds that until first input anyway), so a plugged-in-but-idle pad never
 * forces gamepad hints. The hint system reads {@link activeDevice} to pick which glyph to show.
 */
export type Device = "kbm" | "pad";

let active: Device = "kbm";
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

/** A keyboard/mouse action fired — switch hints to keyboard glyphs. */
export function noteKbm(): void {
  set("kbm");
}
/** A gamepad action fired (button edge / stick past deadzone) — switch hints to gamepad glyphs. */
export function notePad(): void {
  set("pad");
}

/** Run `cb` whenever the active device flips (so the HUD can repaint its hint glyphs). */
export function onDeviceChange(cb: (d: Device) => void): void {
  listeners.push(cb);
}

/**
 * Light / dark theming. Colours follow GitHub's Primer high-contrast schemes
 * (`light_high_contrast` / `dark_high_contrast`). The `theme` object is mutated
 * in place on a mode change and every view reads `theme.*` at render time, so a
 * re-render (hotbar/zoo/tree refresh) repaints in the new scheme.
 */
export interface Theme {
  bg: number; // canvas
  panel: number; // cards, slots, toast
  inset: number; // deep panels (the Zoo picture box)
  border: number; // outlines, separators (bright in high contrast)
  text: number;
  textDim: number;
  mutedDot: number; // application nodes, small markers
  accent: number; // UI blue — slot borders/glyphs
  node: number; // combinator dot fill (carries white text)
  iota: number; // ι gold / amber
  iotaGlyph: number; // text drawn on the ι dot
  fnEdge: number; // function (left) edge — orange
  argEdge: number; // argument (right) edge — violet
  root: number; // highlight ring on a tree's root (the snap anchor) — green
  select: number; // selected Zoo row
  backdrop: number;
  backdropAlpha: number;
}

const DARK: Theme = {
  bg: 0x010409,
  panel: 0x151b23,
  inset: 0x010409,
  border: 0xb7bdc8,
  text: 0xffffff,
  textDim: 0xb7bdc8,
  mutedDot: 0x9198a1,
  accent: 0x74b9ff,
  node: 0x1f6feb,
  iota: 0xf0b72f,
  iotaGlyph: 0x010409,
  fnEdge: 0xfe9a2d,
  argEdge: 0xd3abff,
  root: 0x2bd853,
  select: 0x213d5c,
  backdrop: 0x010409,
  backdropAlpha: 0.72,
};

const LIGHT: Theme = {
  bg: 0xffffff,
  panel: 0xe6eaef,
  inset: 0xeff2f5,
  border: 0x454c54,
  text: 0x010409,
  textDim: 0x454c54,
  mutedDot: 0x59636e,
  accent: 0x023b95,
  node: 0x023b95,
  iota: 0x603700,
  iotaGlyph: 0xffffff,
  fnEdge: 0x702c00,
  argEdge: 0x5e2bb4,
  root: 0x04591f,
  select: 0xcfe3ff,
  backdrop: 0x010409,
  backdropAlpha: 0.45,
};

export type Mode = "light" | "dark";

/** The live theme — mutated in place so existing references stay valid. */
export const theme: Theme = { ...DARK };

let mode: Mode = "dark";
let userOverride = false;
const listeners: Array<() => void> = [];

/** The OS preference, defaulting to dark when unavailable. */
export function systemMode(): Mode {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The live mode (light/dark), for DOM views that paint their own palette. */
export function currentMode(): Mode {
  return mode;
}

function apply(m: Mode): void {
  mode = m;
  Object.assign(theme, m === "dark" ? DARK : LIGHT);
  for (const l of listeners) l();
}

/** Switch mode explicitly (a manual toggle pins the choice over OS changes). */
export function setMode(m: Mode): void {
  userOverride = true;
  apply(m);
}
export function toggleMode(): void {
  setMode(mode === "dark" ? "light" : "dark");
}

/** Initialise from the OS and follow OS changes until the user toggles manually. */
export function initTheme(): void {
  apply(systemMode());
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (!userOverride) apply(systemMode());
  });
}

/** Register a callback to run after every theme change (for a full re-render). */
export function onThemeChange(cb: () => void): void {
  listeners.push(cb);
}

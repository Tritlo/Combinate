/**
 * Light / dark theming with a **1-bit Macintosh** default and an opt-in **Colour**
 * mode. By default the canvas + panels are pure black-and-white (paper / ink) like
 * the original 512×342 Mac screen, with exactly three reserved colours that carry
 * meaning — the gold ι (the single generator / brand), and the warm function /
 * cool argument edge hues. The View ▸ Colour toggle swaps in the full palette,
 * restricted to 4096 colours (12-bit, RGB444) like an early colour Mac.
 *
 * The `theme` object is mutated in place and every view reads `theme.*` at render
 * time, so a re-render (hotbar/zoo/tree refresh) repaints in the active scheme.
 */
export interface Theme {
  bg: number; // canvas (paper)
  panel: number; // cards, slots, toast
  inset: number; // deep panels (the Zoo picture box)
  border: number; // outlines, separators (ink)
  text: number;
  textDim: number;
  mutedDot: number; // application nodes, small markers
  accent: number; // UI accent — gold (mono) / blue (colour)
  node: number; // combinator dot fill (ink in mono, blue in colour)
  nodeGlyph: number; // the letter on a combinator dot (paper in mono, white in colour)
  iota: number; // ι gold / amber — the one reserved node colour
  iotaGlyph: number; // text drawn on the ι dot
  fnEdge: number; // function (left) edge — reserved warm hue
  argEdge: number; // argument (right) edge — reserved cool hue
  root: number; // highlight ring on a tree's root (the snap anchor)
  select: number; // selected Zoo / challenge row (a quiet grey under unchanged text)
  backdrop: number;
  backdropAlpha: number;
}

// ---- Colour mode: the classic 1977–1999 Apple six-colour logo (green/yellow/
// orange/red/purple/blue) — the macOS heritage palette, six widely-separated hues
// — mapped to roles: function = red, argument = blue, ι = yellow/gold, combinator
// node = purple, root = green, accent = orange. Quantised to RGB444 at apply()
// (channels near 0x11 multiples survive). Mono stays 1-bit; this is the opt-in.
// Lightness is tuned per mode for contrast: the vivid logo hues on dark, deepened
// on white where a token doubles as text (ι = Zoo/Golf headings, root = the solved
// tick, edges = strokes). Verified at those call sites. ----
const COLOR_DARK: Theme = {
  bg: 0x111111, panel: 0x222222, inset: 0x000000, border: 0xcccccc,
  text: 0xffffff, textDim: 0xaaaaaa, mutedDot: 0x888888,
  accent: 0xff8822, node: 0xbb55bb, nodeGlyph: 0x111111, // Apple purple dot, dark glyph
  iota: 0xffbb22, iotaGlyph: 0x111111, fnEdge: 0xee4444, argEdge: 0x33aadd, // Apple yellow / red / blue
  root: 0x66cc44, select: 0x333344, backdrop: 0x000000, backdropAlpha: 0.72, // Apple green
};
const COLOR_LIGHT: Theme = {
  bg: 0xffffee, panel: 0xeeeedd, inset: 0xddddcc, border: 0x222222, // warm Mac paper, black ink
  text: 0x000000, textDim: 0x555555, mutedDot: 0x999999,
  accent: 0x0099dd, node: 0x994499, nodeGlyph: 0xffffff, // Apple purple dot, white glyph
  iota: 0x995500, iotaGlyph: 0xffffff, fnEdge: 0xcc3333, argEdge: 0x0077cc, // deep gold (heading-safe) / red / blue
  root: 0x006622, select: 0xdddddd, backdrop: 0x000000, backdropAlpha: 0.45, // deep green (tick-safe)
};

// ---- 1-bit mode (default): paper / ink, + the three reserved colours. ----
const MONO_DARK: Theme = {
  bg: 0x07090d, panel: 0x07090d, inset: 0x0d1117, border: 0xf0f3f6,
  text: 0xf0f3f6, textDim: 0x9aa3ad, mutedDot: 0x6e7681,
  accent: 0xf0b72f, node: 0xf0f3f6, nodeGlyph: 0x07090d,
  iota: 0xf0b72f, iotaGlyph: 0x07090d, fnEdge: 0xfe9a2d, argEdge: 0xd3abff,
  root: 0xf0f3f6, select: 0x21262d, backdrop: 0x000000, backdropAlpha: 0.72,
};
const MONO_LIGHT: Theme = {
  bg: 0xffffff, panel: 0xffffff, inset: 0xf2f2f2, border: 0x000000,
  text: 0x000000, textDim: 0x5a5a5a, mutedDot: 0x8a8a8a,
  // a darker gold so it passes contrast both as the ι dot (white glyph) and as
  // foreground text on white panels (Zoo tab/heading accents).
  accent: 0x8a6300, node: 0x000000, nodeGlyph: 0xffffff,
  iota: 0x8a6300, iotaGlyph: 0xffffff, fnEdge: 0x702c00, argEdge: 0x5e2bb4,
  root: 0x000000, select: 0xdcdcdc, backdrop: 0x000000, backdropAlpha: 0.45,
};

export type Mode = "light" | "dark";

/** The live theme — mutated in place so existing references stay valid. */
export const theme: Theme = { ...MONO_DARK };

let mode: Mode = "dark";
let colorMode = false; // false = 1-bit mono (default); true = the 4096-colour palette
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

/** Snap one colour to the nearest 12-bit value (4 bits per channel → 4096 total). */
function q4(c: number): number {
  const r = Math.round(((c >> 16) & 0xff) / 17) * 17;
  const g = Math.round(((c >> 8) & 0xff) / 17) * 17;
  const b = Math.round((c & 0xff) / 17) * 17;
  return (r << 16) | (g << 8) | b;
}
function quantize(p: Theme): Theme {
  const out = { ...p };
  for (const k of Object.keys(out) as (keyof Theme)[]) {
    if (k !== "backdropAlpha") (out[k] as number) = q4(out[k]);
  }
  return out;
}

function apply(): void {
  const colour = mode === "dark" ? COLOR_DARK : COLOR_LIGHT;
  const monochrome = mode === "dark" ? MONO_DARK : MONO_LIGHT;
  Object.assign(theme, colorMode ? quantize(colour) : monochrome);
  for (const l of listeners) l();
}

/** Switch mode explicitly (a manual toggle pins the choice over OS changes). */
export function setMode(m: Mode): void {
  userOverride = true;
  mode = m;
  apply();
}
export function toggleMode(): void {
  setMode(mode === "dark" ? "light" : "dark");
}

/** Toggle the 4096-colour palette on/off (off = 1-bit mono). */
export function toggleColor(): void {
  colorMode = !colorMode;
  apply();
}
export function colorOn(): boolean {
  return colorMode;
}

/** Initialise from the OS and follow OS changes until the user toggles manually. */
export function initTheme(): void {
  mode = systemMode();
  apply();
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (!userOverride) {
      mode = systemMode();
      apply();
    }
  });
}

/** Register a callback to run after every theme change (for a full re-render). */
export function onThemeChange(cb: () => void): void {
  listeners.push(cb);
}

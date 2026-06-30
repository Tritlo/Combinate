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
  iota: 0xffbb22, iotaGlyph: 0x111111, fnEdge: 0xa07c54, argEdge: 0x7e9cc0, // muted warm brown / cool blue-grey (visible on the dark canvas)
  root: 0x66cc44, select: 0x333344, backdrop: 0x000000, backdropAlpha: 0.72, // Apple green
};
const COLOR_LIGHT: Theme = {
  bg: 0xffffff, panel: 0xeeeeee, inset: 0xdddddd, border: 0x222222, // white canvas, black ink
  text: 0x000000, textDim: 0x555555, mutedDot: 0x999999,
  accent: 0x0099dd, node: 0x994499, nodeGlyph: 0xffffff, // Apple purple dot, white glyph
  iota: 0x995500, iotaGlyph: 0xffffff, fnEdge: 0x33241a, argEdge: 0x7d97b3, // dark brown (almost black) / light blue (almost grey)
  root: 0x006622, select: 0xdddddd, backdrop: 0x000000, backdropAlpha: 0.45, // deep green (tick-safe)
};

// ---- 1-bit mode (default): paper / ink + the gold ι (the one reserved colour).
// Edges are grayscale — function = ink, argument = dim — and told apart by solid
// vs dashed (so mono stays truly colourless beyond the brand ι). ----
const MONO_DARK: Theme = {
  bg: 0x07090d, panel: 0x07090d, inset: 0x0d1117, border: 0xf0f3f6,
  text: 0xf0f3f6, textDim: 0x9aa3ad, mutedDot: 0x6e7681,
  accent: 0xf0b72f, node: 0xf0f3f6, nodeGlyph: 0x07090d,
  iota: 0xf0b72f, iotaGlyph: 0x07090d, fnEdge: 0xf0f3f6, argEdge: 0x9aa3ad,
  root: 0xf0f3f6, select: 0x21262d, backdrop: 0x000000, backdropAlpha: 0.72,
};
const MONO_LIGHT: Theme = {
  bg: 0xffffff, panel: 0xffffff, inset: 0xf2f2f2, border: 0x000000,
  text: 0x000000, textDim: 0x5a5a5a, mutedDot: 0x8a8a8a,
  // a darker gold so it passes contrast both as the ι dot (white glyph) and as
  // foreground text on white panels (Zoo tab/heading accents).
  accent: 0x8a6300, node: 0x000000, nodeGlyph: 0xffffff,
  iota: 0x8a6300, iotaGlyph: 0xffffff, fnEdge: 0x000000, argEdge: 0x5a5a5a,
  root: 0x000000, select: 0xdcdcdc, backdrop: 0x000000, backdropAlpha: 0.45,
};

export type Mode = "light" | "dark";

/** The live theme — mutated in place so existing references stay valid. */
export const theme: Theme = { ...MONO_DARK };

let mode: Mode = "dark";
let colorMode = false; // false = 1-bit mono (default); true = the 4096-colour palette
let userOverride = false;
const listeners: Array<() => void> = [];

// Edge TIER colour (red/black-tree style): edges alternate colour by depth, so a node's parent-edge
// is always the OPPOSITE colour of its child-edges — that's what lets you trace parent→child
// direction (and tell "a's argument" from "b's argument") in a busy 2D/3D tree. Pairs with the
// solid(fn)/dashed(arg) STYLE, which encodes left vs right. Even tiers = ink, odd tiers = red. The
// red is a fixed hue applied directly (not the quantised palette), so it shows in 1-bit mode too.
const EDGE_RED: Record<Mode, number> = { dark: 0xee4444, light: 0xcc2222 };
export function edgeTierColor(depth: number): number {
  return depth % 2 === 0 ? theme.text : EDGE_RED[mode];
}

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

// ---- Per-combinator dot colours (Colour mode only). The most common birds get
// pinned hues — like sound.ts's FUNDAMENTAL — and the rest are hashed onto the
// wheel, the way pitchFor hashes them onto the pentatonic scale. Mono keeps ink
// dots. Saturation/lightness are fixed per mode so the glyph always contrasts. ----
const COMB_HUE: Record<string, number> = {
  S: 145, K: 280, I: 215, B: 30, C: 95, W: 325, M: 0, T: 60, A: 185, O: 255,
};
function hueOf(sym: string): number {
  const pinned = COMB_HUE[sym];
  if (pinned !== undefined) return pinned;
  let x = 0;
  for (let i = 0; i < sym.length; i++) x = (x * 31 + sym.charCodeAt(i)) >>> 0;
  return (x * 137.508) % 360; // golden angle → an even spread around the wheel
}
function hsl(h: number, s: number, l: number): number {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number): number => Math.round((v + m) * 255);
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

/** A combinator's dot colour: hued in Colour mode (common birds pinned, others
 *  hashed), ink in 1-bit mono. */
export function combinatorColor(sym: string): number {
  if (!colorMode) return theme.node; // 1-bit: ink dots
  const l = mode === "dark" ? 0.6 : 0.42;
  const s = mode === "dark" ? 0.7 : 0.62;
  return q4(hsl(hueOf(sym), s, l));
}

/** A near-white or near-black glyph, whichever has the higher WCAG contrast with
 *  `color` (so a dot of any hue stays legible — a luminance threshold mis-picks
 *  mid-tone hues like yellow). */
export function glyphOn(color: number): number {
  const chan = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c: number): number => 0.2126 * chan((c >> 16) & 0xff) + 0.7152 * chan((c >> 8) & 0xff) + 0.0722 * chan(c & 0xff);
  const L = lum(color);
  return 1.05 / (L + 0.05) >= (L + 0.05) / (lum(0x111111) + 0.05) ? 0xffffff : 0x111111;
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

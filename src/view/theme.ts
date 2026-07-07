/**
 * Light / dark theming with a **tricolor (red / black / white)** Macintosh-ish default and an opt-in
 * **Color** mode. By default the canvas + panels are paper (white) + ink (black), with two reserved
 * accents that carry meaning: the gold ι (the single generator / brand) and a **red** used to tier
 * tree edges by depth (red/black alternating, so a parent-edge differs from its child-edges — see
 * {@link edgeTierColor}). So: red, black, white, plus the gold ι. The View ▸ Color toggle swaps in
 * the full palette, restricted to 4096 colors (12-bit, RGB444) like an early color Mac.
 *
 * The `theme` object is mutated in place and every view reads `theme.*` at render
 * time, so a re-render (hotbar/zoo/tree refresh) repaints in the active scheme.
 */
import { vendorUrl } from "../vendorUrl";

export interface Theme {
  bg: number; // canvas (paper)
  panel: number; // cards, slots, toast
  inset: number; // deep panels (the Zoo picture box)
  border: number; // outlines, separators (ink)
  text: number;
  textDim: number;
  mutedDot: number; // application nodes, small markers
  node: number; // combinator dot fill (ink in mono, blue in color)
  iota: number; // the brand accent (tricolor red) — titles, active states. Historically the gold ι (now a gray node).
  root: number; // highlight ring on a tree's root (the snap anchor)
  select: number; // selected Zoo / challenge row (a quiet gray under unchanged text)
  backdrop: number;
  backdropAlpha: number;
}

// ---- Color mode: the classic 1977–1999 Apple six-color logo (green/yellow/
// orange/red/purple/blue) — the macOS heritage palette, six widely-separated hues
// — mapped to roles: ι = yellow/gold, combinator node = purple, root = green,
// accent = orange/blue. (Tree edges are the red/black depth tiers — see
// edgeTierColor — in every mode, not a per-role hue.) Quantized to RGB444 at
// apply() (channels near 0x11 multiples survive); this is the opt-in over the
// tricolor default. Lightness is tuned per mode for contrast: the vivid logo hues
// on dark, deepened on white where a token doubles as text. ----
const COLOR_DARK: Theme = {
  bg: 0x111111, panel: 0x222222, inset: 0x000000, border: 0xcccccc,
  text: 0xffffff, textDim: 0xaaaaaa, mutedDot: 0x888888,
  node: 0xbb55bb, // Apple purple dot, dark glyph
  iota: 0xee4444, // the brand accent — red (the gold was dropped)
  root: 0x66cc44, select: 0x333344, backdrop: 0x000000, backdropAlpha: 0.72, // Apple green
};
const COLOR_LIGHT: Theme = {
  bg: 0xffffff, panel: 0xeeeeee, inset: 0xdddddd, border: 0x222222, // white canvas, black ink
  text: 0x000000, textDim: 0x555555, mutedDot: 0x999999,
  node: 0x994499, // Apple purple dot, white glyph
  iota: 0xcc2222, // the brand accent — red (the gold was dropped)
  root: 0x006622, select: 0xdddddd, backdrop: 0x000000, backdropAlpha: 0.45, // deep green (tick-safe)
};

// ---- Tricolor mode (default): red / black / white. Paper (white) + ink (black) + red. Tree edges
// alternate ink/red by depth tier (the red/black-tree cue; see edgeTierColor) and fn/arg are told
// apart by solid vs dashed; the UI accent (titles, active states — `iota`) is the same red.
// No gold, no other hues; the six-color palette is the opt-in. ----
const MONO_DARK: Theme = {
  bg: 0x07090d, panel: 0x07090d, inset: 0x0d1117, border: 0xf0f3f6,
  text: 0xf0f3f6, textDim: 0x9aa3ad, mutedDot: 0x6e7681,
  node: 0xf0f3f6,
  iota: 0xee4444,
  root: 0xf0f3f6, select: 0x21262d, backdrop: 0x000000, backdropAlpha: 0.72,
};
const MONO_LIGHT: Theme = {
  bg: 0xffffff, panel: 0xffffff, inset: 0xf2f2f2, border: 0x000000,
  text: 0x000000, textDim: 0x5a5a5a, mutedDot: 0x8a8a8a,
  node: 0x000000,
  iota: 0xcc2222,
  root: 0x000000, select: 0xdcdcdc, backdrop: 0x000000, backdropAlpha: 0.45,
};

export type Mode = "light" | "dark";

/** The live theme — mutated in place so existing references stay valid. */
export const theme: Theme = { ...MONO_DARK };

/** A fixed theme for an offline render; unlike {@link theme}, this never tracks the live app. */
export function themeForMode(m: Mode, color = false): Theme {
  const palette = color ? (m === "dark" ? COLOR_DARK : COLOR_LIGHT) : m === "dark" ? MONO_DARK : MONO_LIGHT;
  return color ? quantize(palette) : { ...palette };
}

/** Edge tier color under a fixed theme. */
export function edgeTierColorForMode(depth: number, m: Mode, colors = themeForMode(m)): number {
  return depth % 2 === 0 ? colors.text : EDGE_RED[m];
}

let mode: Mode = "dark";
let colorMode = false; // false = 1-bit mono (default); true = the 4096-color palette
let userOverride = false;
const listeners: Array<() => void> = [];

// Edge TIER color (red/black-tree style): edges alternate color by depth, so a node's parent-edge
// is always the OPPOSITE color of its child-edges — that's what lets you trace parent→child
// direction (and tell "a's argument" from "b's argument") in a busy 2D/3D tree. Pairs with the
// solid(fn)/dashed(arg) STYLE, which encodes left vs right. Even tiers = ink, odd tiers = red — the
// red of the tricolor (red/black/white) identity, a fixed hue applied directly in every mode.
const EDGE_RED: Record<Mode, number> = { dark: 0xee4444, light: 0xcc2222 };
export function edgeTierColor(depth: number): number {
  return depth % 2 === 0 ? theme.text : EDGE_RED[mode];
}

/** The OS preference, defaulting to dark when unavailable. */
function systemMode(): Mode {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The live mode (light/dark), for DOM views that paint their own palette. */
export function currentMode(): Mode {
  return mode;
}

/** Snap one color to the nearest 12-bit value (4 bits per channel → 4096 total). */
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

// ---- Per-combinator dot colors (Color mode only). The most common birds get
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

/** A combinator's dot color: hued in Color mode (common birds pinned, others
 *  hashed), ink in 1-bit mono. */
export function combinatorColor(sym: string): number {
  if (!colorMode) return theme.node; // 1-bit: ink dots
  return combinatorColorForMode(sym, mode);
}

/** A combinator's Color-4096 dot color under a fixed mode, independent of the live color toggle. */
export function combinatorColorForMode(sym: string, m: Mode): number {
  const l = m === "dark" ? 0.6 : 0.42;
  const s = m === "dark" ? 0.7 : 0.62;
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
  const color = mode === "dark" ? COLOR_DARK : COLOR_LIGHT;
  const monochrome = mode === "dark" ? MONO_DARK : MONO_LIGHT;
  Object.assign(theme, colorMode ? quantize(color) : monochrome);
  for (const l of listeners) l();
}

/** Switch mode explicitly (a manual toggle pins the choice over OS changes). */
function setMode(m: Mode): void {
  userOverride = true;
  mode = m;
  apply();
}
export function toggleMode(): void {
  setMode(mode === "dark" ? "light" : "dark");
}

/** Toggle the 4096-color palette on/off (off = 1-bit mono). */
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

// ---- Shared DOM/Pixi chrome: the mono font stack, the once-injected IoskeleyMono @font-face, and
// the tricolor paper/ink pair, which every System-1 overlay (menu bar, modals, quest, hotbar, …)
// used to redeclare on its own. The pair is fixed mono chrome — independent of Color mode, unlike
// theme.bg/theme.border above. ----
export const MONO = "'IoskeleyMono', ui-monospace, SFMono-Regular, Menlo, monospace";

/** The tricolor paper/ink pair as CSS hex strings, for a DOM overlay's own palette record. */
export const PAPER: Record<Mode, string> = { light: "#ffffff", dark: "#07090d" };
export const INK: Record<Mode, string> = { light: "#000000", dark: "#f0f3f6" };

/** {@link PAPER}/{@link INK} as 24-bit ints, for Pixi chrome that's always mono regardless of
 *  Color mode (the hotbar / hint-bar tooltip). */
export function paperInk(): { paper: number; ink: number } {
  return mode === "dark" ? { paper: 0x07090d, ink: 0xf0f3f6 } : { paper: 0xffffff, ink: 0x000000 };
}

let fontInjected = false;
/** Inject the IoskeleyMono `@font-face` once (idempotent) — call from any overlay's own
 *  once-injected stylesheet before using {@link MONO}. */
export function ensureFont(): void {
  if (fontInjected) return;
  fontInjected = true;
  const style = document.createElement("style");
  style.textContent = `@font-face { font-family: 'IoskeleyMono'; src: url('${vendorUrl("vendor/fonts/IoskeleyMono-Regular.woff2")}') format('woff2'); font-display: swap; }`;
  document.head.appendChild(style);
}

/** Resolve once IoskeleyMono has actually finished loading at `px` (kicks {@link ensureFont} first).
 *  DOM text repaints itself for free when a `font-display: swap` webfont swaps in, but canvas text
 *  (Pixi's `Text`) rasterizes to a bitmap once at creation time — a caller drawing glyphs with
 *  {@link MONO} must re-rasterize anything drawn before this resolves. */
export function monoFontReady(px: number): Promise<void> {
  ensureFont();
  return document.fonts.load(`${px}px IoskeleyMono`).then(() => undefined);
}

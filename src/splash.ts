/**
 * Boot splash (the user's request): a centered "Combinate" wordmark over the
 * term `(+) 1 1` fully ι-expanded, laid out as an H-tree (matching the share
 * card), a progress bar, and a "Loading n/total" line. The shell (background,
 * wordmark, bar) lives in index.html so it paints before this module loads; here
 * we fill in the art (the same H-tree layout the canvas uses) and drive the bar
 * from mountApp's startup steps, fading the overlay out once the scene is ready.
 *
 * The art matches the app's mono look and the share card: red ι leaves, edges
 * tiered ink/red by depth (the red/black-tree cue), function edges solid and
 * argument edges dashed — via CSS variables (set per prefers-color-scheme in
 * index.html), so it matches the theme without depending on theme JS.
 */
import { layoutHTree } from "./core/layout";
import { named, expandDisplay } from "./core/catalog";
import { app, type Node } from "./core/term";

/** `(+) 1 1`, fully ι-expanded — a real term (Peano 1 + 1) as a dense ι fractal. */
const heroTerm = (): Node => expandDisplay(app(app(named("(+)"), named("1")), named("1")), { expandAll: true, isDiscovered: () => true });

/** Handle returned to main.ts: advance the bar per startup step, then fade out. */
export interface Splash {
  /** Advance to the next step, updating the bar and the "Loading n/total" line. */
  next(label?: string): void;
  /** Fade the overlay out and remove it (the scene is ready). */
  done(): void;
}

/** Render the hero term as an inline SVG H-tree, in the app's mono look: red ι
 *  leaves, edges tiered ink/red by depth (`--sp-ink` even, `--sp-red` odd — the
 *  red/black-tree cue), function edges solid and argument edges dashed. Nodes,
 *  edge widths, and dashes follow the layout's per-node scale with NO floor —
 *  the deep fringe tapers away exactly as the app draws it. */
function htreeArtSvg(): string {
  const root = heroTerm();
  const { pos, scale, minX, minY, width, height } = layoutHTree(root);

  // Fit the layout into a square box, preserving aspect.
  const BOX = 260;
  const s = (BOX - 24) / (Math.max(width, height) || 1); // leave a 12-unit margin all round
  const tx = (x: number): number => (x - minX) * s + (BOX - width * s) / 2;
  const ty = (yy: number): number => (yy - minY) * s + (BOX - height * s) / 2;

  const at = (n: Node): { x: number; y: number } => {
    const p = pos.get(n.id)!;
    return { x: tx(p.x), y: ty(p.y) };
  };
  const sc = (n: Node): number => scale?.get(n.id) ?? 1;
  // Edge tier colour by depth parity (matches theme.edgeTierColor): even → ink, odd → red.
  const tier = (depth: number): string => (depth % 2 === 0 ? "var(--sp-ink)" : "var(--sp-red)");
  const edges: string[] = [];
  const dots: string[] = [];
  const walk = (n: Node, depth: number): void => {
    const p = at(n);
    if (n.kind === "app") {
      const f = at(n.fn);
      const a = at(n.arg);
      const col = tier(depth);
      const sw = 0.9 * sc(n); // no floor: edges thin out with their arms (the app's taper)
      edges.push(`<line x1="${p.x}" y1="${p.y}" x2="${f.x}" y2="${f.y}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`);
      edges.push(`<line x1="${p.x}" y1="${p.y}" x2="${a.x}" y2="${a.y}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${3.5 * sc(n)} ${2.5 * sc(n)}"/>`);
      dots.push(`<circle cx="${p.x}" cy="${p.y}" r="${0.9 * sc(n)}" fill="var(--sp-dim)"/>`);
      walk(n.fn, depth + 1);
      walk(n.arg, depth + 1);
    } else {
      dots.push(`<circle cx="${p.x}" cy="${p.y}" r="${2 * sc(n)}" fill="var(--sp-red)"/>`);
    }
  };
  walk(root, 0);

  return `<svg viewBox="0 0 ${BOX} ${BOX}" preserveAspectRatio="xMidYMid meet">${edges.join("")}${dots.join("")}</svg>`;
}

/** Mount the splash driver over the index.html shell. `total` is the number of
 *  startup steps (so the line can read "Loading n/total"). A no-op if the shell
 *  isn't present (e.g. a non-browser test harness). */
export function mountSplash(total: number): Splash {
  const el = document.getElementById("splash");
  const fill = document.getElementById("splash-fill");
  const msg = document.getElementById("splash-msg");
  const art = document.getElementById("splash-art");
  if (art) art.innerHTML = htreeArtSvg();

  let n = 0;
  const noop: Splash = { next: () => {}, done: () => {} };
  if (!el || !fill || !msg) return noop;

  return {
    next(label?: string): void {
      n = Math.min(n + 1, total);
      fill.style.width = `${(n / total) * 100}%`;
      msg.textContent = label ? `Loading ${n}/${total} · ${label}` : `Loading ${n}/${total}`;
    },
    done(): void {
      fill.style.width = "100%";
      el.classList.add("done");
      // Remove after the fade so it can't trap pointer events; the 500ms matches
      // the CSS opacity transition.
      window.setTimeout(() => el.remove(), 550);
    },
  };
}

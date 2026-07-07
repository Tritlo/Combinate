/**
 * Boot splash (the user's request): a centered "Combinate" wordmark over the Y
 * combinator's SKI tree, a progress bar, and a "Loading n/total" line. The shell
 * (background, wordmark, bar) lives in index.html so it paints before this module
 * loads; here we fill in the Y art — computed from the catalog's Y definition and
 * the same radial layout the canvas uses — and drive the bar from mountApp's
 * startup steps, fading the overlay out once the scene is ready.
 *
 * The art is the Y combinator in SKI form (its `def`, not the fully-expanded
 * ι-tree): legibly "Y" with ~24 labelled S/K/I leaves rather than a bloom of
 * identical ι dots. Colors come from CSS variables (set per prefers-color-scheme
 * in index.html), so the art matches the theme without depending on theme JS.
 */
import { CATALOG } from "./core/catalog";
import { layoutRadial } from "./core/layout";
import type { Node } from "./core/term";

/** Handle returned to main.ts: advance the bar per startup step, then fade out. */
export interface Splash {
  /** Advance to the next step, updating the bar and the "Loading n/total" line. */
  next(label?: string): void;
  /** Fade the overlay out and remove it (the scene is ready). */
  done(): void;
}

/** Render the Y combinator's SKI tree as an inline SVG (radial layout, the app's
 *  function/argument edge colors; S/K/I leaves carry their letter). The raw
 *  layout spans depth×RING units (Y's SKI form is deep), so we normalise it into a
 *  fixed BOX with fixed node sizes — keeping the leaf letters legible regardless
 *  of the tree's spread. */
function yArtSvg(): string {
  const y = CATALOG.find((l) => l.sym === "Y");
  if (!y?.def) return "";
  const root = y.def();
  const { pos, minX, minY, width, height } = layoutRadial(root);

  // Fit the (possibly wide/asymmetric) layout into a square box, preserving aspect.
  const BOX = 260;
  const span = Math.max(width, height) || 1;
  const s = (BOX - 36) / span; // leave an 18-unit margin all round
  const tx = (x: number): number => (x - minX) * s + (BOX - width * s) / 2;
  const ty = (yy: number): number => (yy - minY) * s + (BOX - height * s) / 2;

  const at = (n: Node): { x: number; y: number } => {
    const p = pos.get(n.id)!;
    return { x: tx(p.x), y: ty(p.y) };
  };
  const edges: string[] = [];
  const dots: string[] = [];
  const walk = (n: Node): void => {
    const p = at(n);
    if (n.kind === "app") {
      const f = at(n.fn);
      const a = at(n.arg);
      edges.push(`<line x1="${p.x}" y1="${p.y}" x2="${f.x}" y2="${f.y}" stroke="var(--sp-fn)" stroke-width="2" stroke-linecap="round"/>`);
      edges.push(`<line x1="${p.x}" y1="${p.y}" x2="${a.x}" y2="${a.y}" stroke="var(--sp-arg)" stroke-width="2" stroke-linecap="round"/>`);
      dots.push(`<circle cx="${p.x}" cy="${p.y}" r="2.6" fill="var(--sp-dim)"/>`);
      walk(n.fn);
      walk(n.arg);
    } else {
      const sym = n.kind === "comb" ? n.sym : n.kind === "free" ? n.name : "ι";
      dots.push(`<circle cx="${p.x}" cy="${p.y}" r="9" fill="var(--sp-node)"/>`);
      dots.push(`<text x="${p.x}" y="${p.y}" fill="#fff" font-size="11" font-family="ui-monospace, monospace" text-anchor="middle" dominant-baseline="central">${sym}</text>`);
    }
  };
  walk(root);

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
  if (art) art.innerHTML = yArtSvg();

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

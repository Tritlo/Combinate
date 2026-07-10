/**
 * Regenerate the OpenGraph share card (public/og.png, 1200×630).
 *
 * The hero is a balanced combinator tree laid out as an H-tree — the app's own
 * layout and mono "tricolor" look: red ι leaves, edges tiered ink/red by depth
 * (the red/black-tree cue), function edges solid and argument edges dashed.
 * Rendered off the real core layout so the card can't drift from the app, then
 * screenshot to PNG with the vendored headless Chromium.
 *
 *   npx tsx scripts/gen-og.ts     (needs playwright-core + a chromium build)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { layoutHTree, countNodes } from "../src/core/layouts";
import { named, expandDisplay } from "../src/core/catalog";
import { app, type Node } from "../src/core/term";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../public/og.png");

// ---- mono LIGHT palette (theme.ts MONO_LIGHT) ----
const PAPER = "#ffffff";
const INK = "#111111"; // tree ink (nodes, even-depth edges)
const RED = "#cc2222"; // the red tier / brand accent (odd-depth edges, ι leaves)
const DIM = "#5a5a5a";

/** `(+) 1 1`, fully ι-expanded — a real term (Peano 1 + 1) as a dense, organic
 *  ι fractal, the app's characteristic view. */
const heroTerm = (): Node => expandDisplay(app(app(named("(+)"), named("1")), named("1")), { expandAll: true, isDiscovered: () => true });

const tier = (depth: number): string => (depth % 2 === 0 ? INK : RED);

/** The hero tree as an H-tree SVG fitted to `w`×`h` — nodes, edge widths, and
 *  dashes sized by the layout's per-node scale with NO floor, so the deep fringe
 *  tapers away exactly as the app draws it. */
function treeSvg(w: number, h: number): string {
  const root = heroTerm();
  console.log(`hero: ${countNodes(root)} nodes`);
  const { pos, scale, minX, minY, width, height } = layoutHTree(root);
  const pad = 48;
  const s = Math.min((w - pad) / (width || 1), (h - pad) / (height || 1));
  const tx = (x: number): number => (x - minX) * s + (w - width * s) / 2;
  const ty = (yy: number): number => (yy - minY) * s + (h - height * s) / 2;
  const at = (n: Node): { x: number; y: number } => {
    const p = pos.get(n.id)!;
    return { x: tx(p.x), y: ty(p.y) };
  };
  const sc = (n: Node): number => scale?.get(n.id) ?? 1;
  const edges: string[] = [];
  const nodes: string[] = [];
  const walk = (n: Node, depth: number): void => {
    const p = at(n);
    if (n.kind === "app") {
      const f = at(n.fn);
      const a = at(n.arg);
      const col = tier(depth);
      const sw = 2 * sc(n); // no floor: edges thin out with their arms (the app's taper)
      edges.push(`<line x1="${p.x}" y1="${p.y}" x2="${f.x}" y2="${f.y}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`);
      edges.push(`<line x1="${p.x}" y1="${p.y}" x2="${a.x}" y2="${a.y}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${5 * sc(n)} ${3.5 * sc(n)}"/>`);
      nodes.push(`<circle cx="${p.x}" cy="${p.y}" r="${1.8 * sc(n)}" fill="${DIM}"/>`);
      walk(n.fn, depth + 1);
      walk(n.arg, depth + 1);
    } else {
      nodes.push(`<circle cx="${p.x}" cy="${p.y}" r="${4.6 * sc(n)}" fill="${RED}"/>`);
    }
  };
  walk(root, 0);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${edges.join("")}${nodes.join("")}</svg>`;
}

const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

function pageHtml(): string {
  const tree = treeSvg(600, 560);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1200px; height: 630px; background: ${PAPER}; }
    .card { width: 1200px; height: 630px; display: flex; align-items: center; font-family: ${MONO}; color: ${INK}; }
    .left { width: 600px; flex: 0 0 600px; padding: 0 40px 0 88px; }
    .iota { font-family: Georgia, 'Times New Roman', serif; font-weight: 700; font-size: 72px; color: ${RED}; line-height: 1; }
    h1 { font-size: 64px; font-weight: 700; letter-spacing: 0.005em; margin-top: 12px; white-space: nowrap; }
    .rule { width: 128px; height: 3px; background: ${RED}; margin: 22px 0; }
    .tag { font-size: 24px; color: ${DIM}; line-height: 1.35; max-width: 400px; }
    .do { font-size: 18px; color: ${DIM}; margin-top: 26px; line-height: 1.4; }
    .do b { color: ${INK}; font-weight: 600; }
    .url { font-size: 18px; color: ${RED}; margin-top: 12px; letter-spacing: 0.02em; }
    .right { flex: 1 1 auto; height: 630px; display: flex; align-items: center; justify-content: center; }
  </style></head><body>
    <div class="card">
      <div class="left">
        <div class="iota">&#x3b9;</div>
        <h1>Combinate</h1>
        <div class="rule"></div>
        <div class="tag">an &#x3b9; / SKI combinator-calculus sandbox</div>
        <div class="do">drag <b>&#x3b9;</b> &middot; snap trees &middot; watch them reduce</div>
        <div class="url">combinate.app</div>
      </div>
      <div class="right">${tree}</div>
    </div>
  </body></html>`;
}

const browser = await chromium.launch({ headless: true });
const p = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await p.setContent(pageHtml(), { waitUntil: "load" });
const buf = await p.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } });
writeFileSync(OUT, buf);
await browser.close();
console.log(`wrote ${OUT} (${buf.length} bytes)`);

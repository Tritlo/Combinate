/**
 * View-performance harness: drives a headless Chromium against a running dev server (or any
 * deployed URL) and reports CPU-side render metrics via the `__combinate` dev seam.
 *
 *   npx tsx scripts/bench-view.ts --mode orbit  [--url http://localhost:5173] [--depth 12]
 *   npx tsx scripts/bench-view.ts --mode morph  [--url http://localhost:5173] [--spine 250]
 *
 * Modes:
 *  - orbit: a complete app tree over one free var (irreducible → steady scene; depth 12 ≈ 8k nodes,
 *    quicksort-scale). Measures 2D pan frame times, 3D build cost, and per-draw submit cost while
 *    orbiting (right-drag).
 *  - morph: a deep ι spine reducing with the transport auto-playing in 3D. Measures per-frame morph
 *    advance cost and frame deltas (hitches show up in p95).
 *
 * Headless caveat: SwiftShader rasterizes on the CPU, so ABSOLUTE frame/draw numbers are not your
 * GPU's — use this for A/B comparisons on one machine (e.g. two dev servers on two commits), and
 * verify user-perceived GPU regressions in a real browser.
 */
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { app, iota, freeVar, type Node } from "../src/core/term";
import { encodePermalink } from "../src/core/permalink";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const url = arg("url", "http://localhost:5173");
const mode = arg("mode", "orbit");

const token = ((): string => {
  if (mode === "orbit") {
    const build = (d: number): Node => (d === 0 ? freeVar("x") : app(build(d - 1), build(d - 1)));
    return encodePermalink(build(Number(arg("depth", "12"))), {});
  }
  let spine: Node = iota();
  for (let i = 0; i < Number(arg("spine", "250")); i++) spine = app(iota(), spine);
  return encodePermalink(spine, {});
})();

const cacheDir = `${homedir()}/.cache/ms-playwright`;
const dir = readdirSync(cacheDir)
  .filter((d) => /^chromium-\d+$/.test(d))
  .sort()
  .pop();
const base = `${cacheDir}/${dir}`;
const exe = readdirSync(base).includes("chrome-linux64") ? `${base}/chrome-linux64/chrome` : `${base}/chrome-linux/chrome`;

const stats = (xs: number[]): { n: number; p50: number; p95: number } => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN).toFixed(2);
  return { n: s.length, p50: q(0.5), p95: q(0.95) };
};

const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// tsx (esbuild) wraps inner functions in a `__name` helper that page.evaluate serializes but the
// browser never defines — shim it to identity before any evaluated code runs.
await page.addInitScript(() => {
  (window as never as { __name: (f: unknown) => unknown }).__name = (f: unknown) => f;
});
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));

await page.goto(`${url}/#${token}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as never as { __combinate?: unknown }).__combinate !== undefined, null, { timeout: 60000 });
await page.keyboard.press("Escape"); // first-launch help on a fresh profile
await page.waitForTimeout(mode === "orbit" ? 1500 : 500);

if (mode === "orbit") {
  // 2D: frame times while continuously panning (drawEdges + culling per frame).
  await page.evaluate(() => {
    const w = window as never as { __frames: number[]; __framesOn: boolean };
    w.__frames = [];
    w.__framesOn = true;
    let last = performance.now();
    const loop = (t: number): void => {
      w.__frames.push(t - last);
      last = t;
      if (w.__framesOn) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.mouse.move(400, 360);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) await page.mouse.move(400 + ((i % 2) * 2 - 1) * 120, 360, { steps: 4 });
  await page.mouse.up();
  const frames2d: number[] = await page.evaluate(() => {
    const w = window as never as { __frames: number[]; __framesOn: boolean };
    w.__framesOn = false;
    return w.__frames.slice(5);
  });

  // 3D: build cost, then draw submit cost while orbiting (right-drag).
  const t3d = await page.evaluate(async () => {
    const c = (window as never as { __combinate: { view3d: { toggle: () => void; info: () => { buildMs: number; count: number } } } }).__combinate;
    const t0 = performance.now();
    c.view3d.toggle();
    await new Promise((r) => setTimeout(r, 300));
    return { toggleMs: performance.now() - t0, info: c.view3d.info() };
  });
  // Orbit (the "rotation" scenario): frame deltas are the truth — SwiftShader rasterizes off the
  // submit thread, so drawMs can look flat while frames hitch.
  await page.evaluate(() => {
    const w = window as never as { __frames: number[]; __framesOn: boolean };
    w.__frames = [];
    w.__framesOn = true;
    let last = performance.now();
    const loop = (t: number): void => {
      w.__frames.push(t - last);
      last = t;
      if (w.__framesOn) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const draws: number[] = [];
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: "right" });
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(640 + ((i % 2) * 2 - 1) * 100, 360 + (i % 3) * 20, { steps: 3 });
    draws.push(await page.evaluate(() => (window as never as { __combinate: { view3d: { info: () => { drawMs: number } } } }).__combinate.view3d.info().drawMs));
  }
  await page.mouse.up({ button: "right" });
  const framesOrbit: number[] = await page.evaluate(() => {
    const w = window as never as { __frames: number[]; __framesOn: boolean };
    w.__framesOn = false;
    return w.__frames.slice(5);
  });
  console.log(JSON.stringify({ mode, url, nodes3d: t3d.info.count, buildMs: +t3d.info.buildMs.toFixed(1), toggleMs: +t3d.toggleMs.toFixed(1), drawMs: stats(draws), frameOrbitMs: stats(framesOrbit), frame2dMs: stats(frames2d), errors: errors.length }, null, 1));
} else {
  await page.evaluate(() => (window as never as { __combinate: { view3d: { toggle: () => void } } }).__combinate.view3d.toggle());
  await page.waitForTimeout(500);
  const out = await page.evaluate(async () => {
    const c = (window as never as { __combinate: { view3d: { info: () => { morphMs: number } } } }).__combinate;
    const morphs: number[] = [];
    const frames: number[] = [];
    let last = performance.now();
    let on = true;
    const loop = (t: number): void => {
      frames.push(t - last);
      last = t;
      const m = c.view3d.info().morphMs;
      if (m > 0) morphs.push(m);
      if (on) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    await new Promise((r) => setTimeout(r, 6000));
    on = false;
    return { morphs, frames: frames.slice(5) };
  });
  console.log(JSON.stringify({ mode, url, morphMs: stats(out.morphs), frameMs: stats(out.frames), errors: errors.length }));
}
await browser.close();
process.exit(errors.length ? 1 : 0);

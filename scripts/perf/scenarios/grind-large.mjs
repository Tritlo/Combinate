import { OPTIMIZE_OFF, addEgg, prepareLivePage, waitForStableReduction } from "./_shared.mjs";

export const name = "grind-large";
export const browser = true;
export const optimizeState = OPTIMIZE_OFF;

const term = addEgg(1, 1);

export async function run(page, ctx) {
  await page.goto(ctx.url(), { waitUntil: "domcontentloaded" });
  await prepareLivePage(page, { transport: "max", unlockAll: true });
  await page.evaluate((egg) => {
    const probe = { running: true, maxGap: 0, last: performance.now() };
    globalThis.__combinatePerfFrames = probe;
    const tick = (ts) => {
      if (!probe.running) return;
      probe.maxGap = Math.max(probe.maxGap, ts - probe.last);
      probe.last = ts;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    globalThis.__combinate.spawn(egg);
    globalThis.__combinate.fit();
  }, term);

  const result = await waitForStableReduction(page, {
    timeoutMs: 20_000,
    stableMs: 350,
    minSteps: 20,
  });
  const max_raf_gap_ms = await page.evaluate(() => {
    const probe = globalThis.__combinatePerfFrames;
    if (!probe) return null;
    probe.running = false;
    return probe.maxGap;
  });

  return {
    wall_ms: result.wall_ms,
    steps: result.steps,
    max_raf_gap_ms,
  };
}

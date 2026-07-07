import { OPTIMIZE_RULES, addEgg, prepareLivePage, waitForStableReduction } from "./_shared.mjs";

export const name = "cadence-medium";
export const browser = true;
export const optimizeState = OPTIMIZE_RULES;

const term = addEgg(8, 8);

export async function run(page, ctx) {
  await page.goto(ctx.url(), { waitUntil: "domcontentloaded" });
  await prepareLivePage(page, { transport: "ff", unlockAll: true });
  await page.evaluate((egg) => {
    globalThis.__combinate.spawn(egg);
    globalThis.__combinate.fit();
  }, term);

  const result = await waitForStableReduction(page, {
    timeoutMs: 25_000,
    stableMs: 650,
    minSteps: 20,
    accept: ["(Succ (Succ (Succ (Succ (Succ (Succ (Succ (Succ (Succ (Succ (Succ (Succ (Succ (Succ (Succ (Succ K))))))))))))))))"],
    collectStepTimes: true,
  });

  return {
    nf_ms: result.wall_ms,
    steps: result.steps,
    inter_step_ms: median(result.inter_step_ms),
  };
}

function median(xs) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

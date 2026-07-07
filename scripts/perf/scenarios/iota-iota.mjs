import { OPTIMIZE_OFF, permalinkForEgg, waitForStableReduction } from "./_shared.mjs";

export const name = "iota-iota";
export const browser = true;
export const optimizeState = OPTIMIZE_OFF;

const token = permalinkForEgg("(@ iota iota)", { transport: "play" });

export async function run(page, ctx) {
  await page.goto(ctx.url({ hash: token }), { waitUntil: "domcontentloaded" });
  const result = await waitForStableReduction(page, {
    timeoutMs: 18_000,
    stableMs: 450,
    minSteps: 1,
    accept: ["I"],
  });
  if (result.final !== "I") throw new Error(`expected I-ish normal form, got ${result.final}`);
  return {
    nf_ms: result.wall_ms,
    steps: result.steps,
  };
}

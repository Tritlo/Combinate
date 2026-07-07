export const name = "record-pipeline";
export const browser = true;

export async function run(page, ctx) {
  await page.goto(ctx.url(), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.__combinate, null, { polling: 10, timeout: 30_000 });

  return page.evaluate(async () => {
    const [{ fromEgg }, { precount }, { runRecording }, { probeSupport }] = await Promise.all([
      import("/src/core/refold.ts"),
      import("/src/view/record/precount.ts"),
      import("/src/view/record/driver.ts"),
      import("/src/view/record/encoder.ts"),
    ]);

    const support = await probeSupport();
    if (!support.video) throw new Error("record-pipeline: no supported video encoder");

    const term = fromEgg("(@ (@ (@ S K) K) K)");
    const settings = {
      view: "2d",
      layout: "htree",
      expandIota: false,
      rules: true,
      graph: false,
      native: {},
      width: 320,
      height: 240,
      fps: 30,
      stepMs: 120,
      holdMs: 240,
      baseNote: 48,
      audio: false,
      maxSteps: 200,
      theme: "light",
      color: false,
      spinRevs: 1,
      camera: "hold",
      rotate: false,
      overlayInfo: false,
      overlayStats: false,
    };
    const plan = precount(term, settings);
    if (plan.totalFrames <= 0) throw new Error("record-pipeline: empty frame plan");

    let frames = 0;
    const start = performance.now();
    const blob = await runRecording(term, settings, plan, {
      onFrame: () => {
        frames++;
      },
    });
    const wall_ms = performance.now() - start;

    return {
      wall_ms,
      frames,
      steps: plan.steps,
      ms_per_frame: wall_ms / plan.totalFrames,
      bytes: blob.size,
    };
  });
}

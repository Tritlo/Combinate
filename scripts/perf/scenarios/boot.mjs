import { waitForSeam } from "./_shared.mjs";

export const name = "boot";
export const browser = true;

export async function run(page, ctx) {
  await page.goto(ctx.url(), { waitUntil: "domcontentloaded" });
  const seam_ms = await page
    .waitForFunction(() => (globalThis.__combinate ? performance.now() : false), null, { polling: 10, timeout: 30_000 })
    .then((handle) => handle.jsonValue());
  await waitForSeam(page);
  const paint = await page.evaluate(() => {
    const entries = performance.getEntriesByType("paint");
    const first = entries.find((entry) => entry.name === "first-paint");
    return first?.startTime ?? null;
  });
  return {
    seam_ms,
    first_paint_ms: paint,
  };
}

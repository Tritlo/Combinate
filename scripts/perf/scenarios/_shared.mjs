export const OPTIMIZE_OFF = {
  rules: false,
  graph: false,
  nativeNumbers: false,
  nativeLists: false,
  nativeBooleans: false,
  wasm: false,
};

export const OPTIMIZE_RULES = {
  ...OPTIMIZE_OFF,
  rules: true,
};

export function permalinkForEgg(egg, modes = {}) {
  const json = JSON.stringify({ t: egg, m: modes });
  return `c1${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function natEgg(n) {
  let term = "K";
  for (let i = 0; i < n; i++) term = `(@ Succ ${term})`;
  return term;
}

export function addEgg(a, b) {
  return `(@ (@ add ${natEgg(a)}) ${natEgg(b)})`;
}

export async function waitForSeam(page, timeoutMs = 30_000) {
  await page.waitForFunction(() => globalThis.__combinate, null, { polling: 10, timeout: timeoutMs });
}

export async function waitForStableReduction(page, options = {}) {
  const {
    timeoutMs = 20_000,
    stableMs = 500,
    minSteps = 1,
    accept = [],
    collectStepTimes = false,
  } = options;

  return page.evaluate(
    async ({ timeoutMs, stableMs, minSteps, accept, collectStepTimes }) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline && !globalThis.__combinate) await sleep(10);
      const seam = globalThis.__combinate;
      if (!seam) throw new Error("__combinate seam missing");

      while (performance.now() < deadline && seam.trees.length === 0) await sleep(10);
      if (seam.trees.length === 0) throw new Error("no tree appeared");

      const startMs = performance.now();
      let lastSexp = "";
      let lastSteps = seam.autoSteps();
      let changedAt = startMs;
      const stepTimes = [];

      const accepted = (sexp) => accept.length === 0 || accept.includes(sexp);

      while (performance.now() < deadline) {
        const now = performance.now();
        const sexp = seam.sexps()[0] ?? "";
        const steps = seam.autoSteps();

        if (steps !== lastSteps) {
          if (collectStepTimes) stepTimes.push(now - startMs);
          lastSteps = steps;
          changedAt = now;
        }
        if (sexp !== lastSexp) {
          lastSexp = sexp;
          changedAt = now;
        }

        if (steps >= minSteps && accepted(sexp) && now - changedAt >= stableMs) {
          const intervals = [];
          for (let i = 1; i < stepTimes.length; i++) intervals.push(stepTimes[i] - stepTimes[i - 1]);
          return {
            wall_ms: now - startMs,
            steps,
            final: sexp,
            step_times_ms: stepTimes,
            inter_step_ms: intervals,
          };
        }
        await sleep(25);
      }

      throw new Error(`reduction did not stabilize; last=${JSON.stringify(lastSexp)} steps=${lastSteps}`);
    },
    { timeoutMs, stableMs, minSteps, accept, collectStepTimes },
  );
}

export async function prepareLivePage(page, { transport = "play", unlockAll = false } = {}) {
  await waitForSeam(page);
  await page.evaluate(
    ({ transport, unlockAll }) => {
      const seam = globalThis.__combinate;
      if (seam.sound?.on?.()) seam.sound.toggle();
      if (unlockAll) seam.unlockAll?.();
      seam.transport.set(transport);
    },
    { transport, unlockAll },
  );
}

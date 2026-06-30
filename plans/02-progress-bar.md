# [02] No default optimizations + reduction-count progress bar

## Findings
- The Haskell-compile flow AUTO-ENABLES optimizations: `setOpt("rules",false)`, `nativeNumbers
  true`, `wasm true` (app.ts ~548-550) + toasts "Turbo on" — this is the "confusing" default.
- Otherwise optimizations default OFF. The visible reducer counts `a.steps`; the wasm/turbo
  `Session` exposes `totalSteps` + `isDone` + `stepBudget(n)`; STEP_CAP=2000 (TS), TURBO_CAP=20M.

## Plan
1. **Stop auto-enabling** turbo + native numbers on compile (and anywhere else). Optimizations
   become purely opt-in via the Optimizations menu. (Compile still lays out radial + fits.)
2. **Background reduction-count estimate** — when the focused term begins reducing, kick a
   BACKGROUND wasm/turbo reduction-to-normal-form (off-screen, max speed) to learn the TOTAL
   contraction count quickly; the visible reducer keeps playing at watchable speed.
3. **Progress** = visible steps / estimated total. Show a thin **progress bar over the toolbar**
   (the hotbar), filling as the visible reduction advances.
4. **The math (the crux, for the council)** — the background turbo count ≠ the visible count
   (turbo shares + uses kernels = far fewer steps than raw/optimized TS). Options: (a) run the
   background estimator in the SAME reduction mode as the visible one (exact count, but slower);
   (b) turbo count × a calibration ratio learned per mode; (c) a hybrid: turbo gives the *shape*
   (terminates? how big?), and a cheap projection gives the visible count. Council to pick.

## Council questions
- The estimation approach (a/b/c) — accuracy vs cost; how to handle the mode mismatch.
- Non-terminating / capped reductions — what does the bar show (indeterminate? cap-relative?).
- Bar placement/visuals over the hotbar; what happens for instant reductions (skip the bar).

## Council verdict (consensus) — the user's "turbo + conversion math" is dropped
- **Same-mode exact, no conversion.** Reduction is deterministic, so a background run in the SAME
  mode as the visible reducer gives the EXACT total. Turbo (graph-sharing + kernels) counts a
  fundamentally different number of contractions — converting it to the visible count is non-
  linear + mode-dependent and "dead on arrival". Turbo is used only (a) when the VISIBLE mode is
  turbo (use the Session's `totalSteps` directly), or (b) as a cheap PROBE ("terminates? rough
  scale?") for the huge/raw case where an exact bar is meaningless.
- **A dedicated `ReductionEstimator`** beside the ReductionController, keyed by `{source node id,
  mode tuple, generation}`, cancellable. States: `idle | measuring | exact(total) | capped`. It
  must branch on the SAME mode knobs as the visible schedule (getFast/getNative/getShare/getTurbo)
  — the TS `redexAt` path, or `GraphReducer`, or the wasm `Session` — to count what the visible
  reducer will count.
- **Chunked stepper, not one-shot normalize**: yield on a small time budget (ticker / idle) so even
  borderline few-thousand-step terms can't jank the main thread. No Web Worker needed.
- **UI policy**: a thin progress fill as a child of the **Hotbar** (over the slots), not the
  transport bar. Show only when the reduction will take more than ~10-12 steps; brief "measuring"
  indeterminate strip, then exact `shown/total`. Capped / non-terminating / huge → indeterminate
  ("still reducing") or hidden — NEVER a fake percent. A mode toggle mid-reduction cancels the
  estimator (a stale denominator is worse than no bar).
- Confirmed: **drop the compile auto-on optimizations** (the "confusing" default); opts stay
  opt-in via the menu.

## User refinement
- Optimizations (turbo / native ints / etc.) STAY AVAILABLE as opt-in menu toggles — we're only
  removing the auto-on-by-default. The estimator just FOLLOWS the current settings and counts the
  final reduction total (fast, same-mode background run), then we play it slowly with the bar.

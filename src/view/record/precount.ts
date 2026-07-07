/**
 * Cheap record planning (ADR 24): reduce a snapshot of the term headlessly with
 * the same engine options the recording will use, then apply the deterministic
 * adaptive output schedule. No layout or rendering happens here.
 */
import type { Node } from "../../core/term";
import { firingRule, redexAt, stepWithPatch } from "../../core/reduce";
import { GraphReducer } from "../../core/graph";
import type { NativeOpts } from "../../core/native";
import type { RecordPlan, RecordSettings, ToneEvent } from "./types";

/** Output-time half-life for the adaptive recorder pace. */
export const ACCEL_HALF_LIFE_SEC = 5;
const ACCEL_HALF_LIFE_MS = ACCEL_HALF_LIFE_SEC * 1000;
const MAX_STEPS_PER_FRAME = 1024;
const SCHEDULE_EPS = 1e-7;

interface ScheduleSettings {
  fps: RecordSettings["fps"];
  stepMs: number;
}

/** One batch of reduction steps that lands on the same output frame. */
export interface ScheduledStepGroup {
  step: number;
  timeMs: number;
  durationMs: number;
  stepCount: number;
}

/** Deterministic adaptive schedule cursor shared by planning and rendering. */
export interface ScheduleCursor {
  readonly step: number;
  readonly timeMs: number;
  next: (remainingSteps: number) => ScheduledStepGroup | null;
}

function frameMs(settings: Pick<RecordSettings, "fps">): number {
  return 1000 / settings.fps;
}

function floorHalfIndex(settings: ScheduleSettings): number {
  const ratio = settings.stepMs / frameMs(settings);
  return ratio <= 1 ? 0 : Math.ceil(Math.log2(ratio));
}

function paceAt(outputMs: number, settings: ScheduleSettings): { durationMs: number; stepsPerFrame: number } {
  const frameDurationMs = frameMs(settings);
  const half = Math.max(0, Math.floor((outputMs + SCHEDULE_EPS) / ACCEL_HALF_LIFE_MS));
  const floorHalf = floorHalfIndex(settings);
  if (half < floorHalf) {
    return { durationMs: Math.max(frameDurationMs, settings.stepMs / 2 ** half), stepsPerFrame: 1 };
  }
  const lapseHalf = half - floorHalf;
  return { durationMs: frameDurationMs, stepsPerFrame: Math.min(MAX_STEPS_PER_FRAME, 2 ** lapseHalf) };
}

/** Create the adaptive reduction schedule: step duration halves every 5s of output time, then batches steps per frame. */
export function createScheduleCursor(settings: ScheduleSettings): ScheduleCursor {
  let step = 0;
  let timeMs = 0;
  return {
    get step() {
      return step;
    },
    get timeMs() {
      return timeMs;
    },
    next: (remainingSteps) => {
      const remaining = Math.max(0, Math.floor(remainingSteps));
      if (remaining <= 0) return null;
      const pace = paceAt(timeMs, settings);
      const stepCount = Math.min(remaining, pace.stepsPerFrame);
      const group = { step, timeMs, durationMs: pace.durationMs, stepCount };
      step += stepCount;
      timeMs += pace.durationMs;
      return group;
    },
  };
}

/** The deterministic frame budget for a reduction step count and recording pace. */
export function frameBudget(steps: number, settings: Pick<RecordSettings, "fps" | "stepMs" | "holdMs">): Pick<RecordPlan, "totalFrames" | "durationSec"> {
  const schedule = createScheduleCursor(settings);
  const totalSteps = Math.max(0, Math.floor(steps));
  while (schedule.step < totalSteps) schedule.next(totalSteps - schedule.step);
  const totalMs = Math.max(0, schedule.timeMs + settings.holdMs);
  const totalFrames = Math.ceil((totalMs * settings.fps) / 1000);
  return { totalFrames, durationSec: totalFrames / settings.fps };
}

/** One replayed reduction contraction and the snapshot to render after it. */
export interface ReplayStep {
  node: Node;
  sym: string | null;
}

/** The deterministic reducer replay used by both planning and rendering. */
export interface ReductionReplay {
  readonly steps: number;
  step: () => ReplayStep | null;
  hasRedex: () => boolean;
}

function nativeFor(settings: RecordSettings): NativeOpts | undefined {
  if (settings.graph) return undefined;
  const native = settings.native;
  return native.numbers || native.lists || native.booleans ? native : undefined;
}

/** Create a replay of the live reduction path under record settings. */
export function createReductionReplay(term: Node, settings: RecordSettings): ReductionReplay {
  if (settings.graph) {
    const graph = new GraphReducer(term, settings.rules);
    let current = term;
    return {
      get steps() {
        return graph.steps;
      },
      step: () => {
        if (!graph.step()) return null;
        const sym = firingRule(current, settings.rules);
        current = graph.snapshot();
        return { node: current, sym };
      },
      hasRedex: () => firingRule(current, settings.rules) !== null,
    };
  }

  const native = nativeFor(settings);
  let current = term;
  let steps = 0;
  return {
    get steps() {
      return steps;
    },
    step: () => {
      const patch = stepWithPatch(current, 0, settings.rules, native);
      if (!patch) return null;
      current = patch.root;
      steps++;
      return { node: current, sym: patch.sym };
    },
    hasRedex: () => redexAt(current, settings.rules, native) !== null,
  };
}

/** Count steps / collect tones for `term` under `settings`. Capped by maxSteps. */
export function precount(term: Node, settings: RecordSettings): RecordPlan {
  const replay = createReductionReplay(term, settings);
  const schedule = createScheduleCursor(settings);
  const tones: ToneEvent[] = [];
  let steps = 0;
  while (steps < settings.maxSteps) {
    const group = schedule.next(settings.maxSteps - steps);
    if (!group) break;
    for (let i = 0; i < group.stepCount; i++) {
      const next = replay.step();
      if (!next) {
        const budget = frameBudget(steps, settings);
        return { steps, ...budget, capped: false, tones };
      }
      if (i === 0 && next.sym !== null) tones.push({ sym: next.sym, timeSec: group.timeMs / 1000 });
      steps++;
    }
  }
  const budget = frameBudget(steps, settings);
  return { steps, ...budget, capped: replay.hasRedex(), tones };
}

/**
 * Async twin of {@link precount}: identical replay + frameBudget math, but it
 * yields to the event loop every `yieldEvery` steps (default 512) and aborts
 * cleanly via `signal`, so a 100k-step plan can't freeze the UI thread. Used by
 * the record modal; the sync {@link precount} stays for small-term/off-thread callers.
 */
export async function precountAsync(
  term: Node,
  settings: RecordSettings,
  opts: { yieldEvery?: number; signal?: AbortSignal } = {},
): Promise<RecordPlan> {
  const yieldEvery = Math.max(1, Math.floor(opts.yieldEvery ?? 512));
  const signal = opts.signal;
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException("precount aborted", "AbortError");
  };
  throwIfAborted();
  const replay = createReductionReplay(term, settings);
  const schedule = createScheduleCursor(settings);
  const tones: ToneEvent[] = [];
  let steps = 0;
  let sinceYield = 0;
  while (steps < settings.maxSteps) {
    const group = schedule.next(settings.maxSteps - steps);
    if (!group) break;
    for (let i = 0; i < group.stepCount; i++) {
      const next = replay.step();
      if (!next) {
        const budget = frameBudget(steps, settings);
        return { steps, ...budget, capped: false, tones };
      }
      if (i === 0 && next.sym !== null) tones.push({ sym: next.sym, timeSec: group.timeMs / 1000 });
      steps++;
      if (++sinceYield >= yieldEvery) {
        sinceYield = 0;
        await new Promise((r) => setTimeout(r, 0));
        throwIfAborted();
      }
    }
  }
  const budget = frameBudget(steps, settings);
  return { steps, ...budget, capped: replay.hasRedex(), tones };
}

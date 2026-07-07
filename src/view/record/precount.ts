/**
 * Pre-run pass (ADR 24): reduce a snapshot of the term headlessly with the
 * same engine options the recording will use, to learn the step count, the
 * frame budget, and the tone schedule before any frame is rendered.
 */
import type { Node } from "../../core/term";
import { firingRule, redexAt, stepWithPatch } from "../../core/reduce";
import { GraphReducer } from "../../core/graph";
import type { NativeOpts } from "../../core/native";
import type { RecordPlan, RecordSettings, ToneEvent } from "./types";

/** The deterministic frame budget for a reduction step count and recording pace. */
export function frameBudget(steps: number, settings: Pick<RecordSettings, "fps" | "stepMs" | "holdMs">): Pick<RecordPlan, "totalFrames" | "durationSec"> {
  const totalMs = Math.max(0, steps * settings.stepMs + settings.holdMs);
  const totalFrames = Math.ceil((totalMs * settings.fps) / 1000);
  return { totalFrames, durationSec: totalFrames / settings.fps };
}

/** One replayed reduction contraction and the snapshot to render after it. */
export interface ReplayStep {
  node: Node;
  sym: string | null;
}

/** The deterministic reducer replay used by both the pre-run and the renderer. */
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
  const tones: ToneEvent[] = [];
  let steps = 0;
  while (steps < settings.maxSteps) {
    const next = replay.step();
    if (!next) {
      const budget = frameBudget(steps, settings);
      return { steps, ...budget, capped: false, tones };
    }
    if (next.sym !== null) tones.push({ sym: next.sym, timeSec: (steps * settings.stepMs) / 1000 });
    steps++;
  }
  const budget = frameBudget(steps, settings);
  return { steps, ...budget, capped: replay.hasRedex(), tones };
}

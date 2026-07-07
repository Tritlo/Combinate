/**
 * Pre-run pass (ADR 24): reduce a snapshot of the term headlessly with the
 * same engine options the recording will use, to learn the step count, the
 * frame budget, and the tone schedule before any frame is rendered.
 */
import type { Node } from "../../core/term";
import type { RecordPlan, RecordSettings } from "./types";

/** Count steps / collect tones for `term` under `settings`. Capped by maxSteps. */
export function precount(term: Node, settings: RecordSettings): RecordPlan {
  void term;
  void settings;
  throw new Error("record: precount not implemented yet");
}

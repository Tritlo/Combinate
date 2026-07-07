/**
 * The record-pipeline contract (ADR 24): what the record modal hands the
 * offline driver, what the pre-run pass yields, and the progress shapes.
 * Types only — no Pixi/DOM/WebCodecs imports belong here.
 */
import type { Sym } from "../../core/term";
import type { NativeOpts } from "../../core/native";
import type { LayoutKey } from "../layoutControls";

/** Everything the record modal chooses; prefilled from the live canvas state. */
export interface RecordSettings {
  /** "3d" is reserved — disabled in the UI until the Sphere3D pump seam lands (ADR 24). */
  view: "2d" | "3d";
  layout: LayoutKey;
  expandIota: boolean;
  /** Catalog rewrite rules — the reducer's `fast` flag. */
  rules: boolean;
  /** Call-by-need graph reduction; when on, native opts are ignored (matches live). */
  graph: boolean;
  native: NativeOpts;
  width: number;
  height: number;
  fps: 30 | 60;
  /** Pacing: output-time between reduction step starts, ms (ADR 22: player-chosen). */
  stepMs: number;
  /** Trailing hold on the final frame, ms. */
  holdMs: number;
  /** Root pitch of the tone track as a MIDI note (live sonification is 48 = C3). */
  baseNote: number;
  audio: boolean;
  /** Divergence guard: stop after this many steps (Ω never normalizes). */
  maxSteps: number;
}

/** One scheduled sonification event, in output-time seconds. */
export interface ToneEvent {
  sym: Sym;
  timeSec: number;
}

/** What the pre-run pass learns before any frame is rendered. */
export interface RecordPlan {
  steps: number;
  totalFrames: number;
  /** True when maxSteps was hit before normal form — the recording truncates. */
  capped: boolean;
  tones: ToneEvent[];
  /** Output duration in seconds (totalFrames / fps). */
  durationSec: number;
}

/** Per-frame progress for the preview overlay. */
export interface RecordProgress {
  frame: number;
  totalFrames: number;
}

/** What encoder probing found; a null video codec means recording is unavailable. */
export interface CodecSupport {
  video: string | null;
  audio: "aac" | "opus" | null;
}

/** Hooks the shell passes into a run: preview blitting and cancellation. */
export interface RecordHooks {
  /** Called after each frame is encoded, with the offscreen canvas to blit from. */
  onFrame?: (canvas: HTMLCanvasElement, progress: RecordProgress) => void;
  signal?: AbortSignal;
}

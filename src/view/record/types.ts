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
  /** Record under this theme regardless of the live app's mode. */
  theme: "light" | "dark";
  /** Per-combinator hues (the Colour-4096 look) instead of 1-bit mono. */
  color: boolean;
  /** Turntable speed: revolutions over the whole clip (rotate must be on). */
  spinRevs: number;
  /** Camera: a single initial fit, or re-fit following the tree as it reduces. */
  camera: "fixed" | "follow";
  /** 3D turntable: one full revolution over the clip (ignored in 2D). */
  rotate: boolean;
  /** Burn a System-1 info card (name/law/ι-count) into the frames. */
  overlayInfo: boolean;
  /** Burn a live stats line (step n/total, node count) into the frames. */
  overlayStats: boolean;
  /** What the info overlay prints; the shell fills it from its readout lenses. */
  info?: RecordInfo;
}

/** The info-card content — computed by the shell, drawn by the driver. */
export interface RecordInfo {
  title: string;
  law?: string;
  subtitle?: string;
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

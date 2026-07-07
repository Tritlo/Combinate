/**
 * The offline frame-perfect recording driver (ADR 24): a recorder-owned Pixi
 * pipeline stepped on a manual clock — no wall time, no live controller —
 * rendering each frame at the chosen resolution, encoding as it goes, and
 * handing every frame to the preview hook.
 */
import { Container, Ticker, autoDetectRenderer, type Renderer } from "pixi.js";
import type { Node } from "../../core/term";
import { layoutAuto, layoutHTree, layoutRadial, layoutTopDown, type LayoutFn } from "../../core/layout";
import { TreeView } from "../tree";
import { theme } from "../theme";
import { renderAudio } from "./audio";
import { createRecordingEncoder, type RecordingEncoder } from "./encoder";
import { createReductionReplay, frameBudget } from "./precount";
import type { RecordHooks, RecordPlan, RecordSettings } from "./types";

function layoutFor(settings: RecordSettings): LayoutFn {
  switch (settings.layout) {
    case "auto":
      return layoutAuto;
    case "topdown":
      return layoutTopDown;
    case "radial":
      return layoutRadial;
    case "htree":
      return layoutHTree;
  }
}

function abortError(): Error {
  return new Error("recording cancelled");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function fitStage(stage: Container, tree: TreeView, settings: RecordSettings): void {
  const b = tree.worldBounds();
  const margin = 0.82;
  const scale = Math.max(0.04, Math.min(2.5, Math.min((settings.width * margin) / Math.max(b.w, 1), (settings.height * margin) / Math.max(b.h, 1))));
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  stage.scale.set(scale);
  stage.position.set(settings.width / 2 - cx * scale, settings.height / 2 - cy * scale);
}

/**
 * Render just the first frame (the term as laid out, no reduction) at the
 * chosen resolution — the modal's "layout feel" preview thumbnail.
 */
export async function renderFirstFrame(term: Node, settings: RecordSettings): Promise<HTMLCanvasElement> {
  void term;
  void settings;
  throw new Error("record: renderFirstFrame not implemented yet");
}

/**
 * Render `term`'s reduction to an MP4 blob under `settings`/`plan`.
 * Rejects on cancellation (AbortSignal), unsupported codecs, or driver errors.
 */
export async function runRecording(
  term: Node,
  settings: RecordSettings,
  plan: RecordPlan,
  hooks: RecordHooks = {},
): Promise<Blob> {
  if (settings.view !== "2d") throw new Error("record: 3D recording is not implemented yet");
  const budget = frameBudget(plan.steps, settings);
  if (budget.totalFrames !== plan.totalFrames) {
    throw new Error(`record: frame budget drifted (${budget.totalFrames} !== ${plan.totalFrames})`);
  }
  if (plan.totalFrames <= 0) throw new Error("record: no frames to encode");

  let renderer: Renderer | null = null;
  let stage: Container | null = null;
  let ticker: Ticker | null = null;
  let tree: TreeView | null = null;
  let encoder: RecordingEncoder | null = null;
  let finalized = false;

  try {
    throwIfAborted(hooks.signal);
    const canvas = document.createElement("canvas");
    canvas.width = settings.width;
    canvas.height = settings.height;
    renderer = await autoDetectRenderer({
      canvas,
      width: settings.width,
      height: settings.height,
      resolution: 1,
      autoDensity: false,
      background: theme.bg,
      antialias: true,
      preference: ["webgl", "canvas"],
    });
    stage = new Container();
    ticker = new Ticker();
    ticker.autoStart = false;
    ticker.maxFPS = 0;
    ticker.lastTime = 0;

    tree = new TreeView(term, 0, 0, ticker, () => true, layoutFor(settings), () => settings.expandIota, null, (sym) => sym, { deterministicEdges: true });
    stage.addChild(tree.container);
    fitStage(stage, tree, settings);
    renderer.render(stage);

    const audioBuffer = settings.audio && plan.tones.length > 0 ? await renderAudio(plan, settings) : null;
    encoder = await createRecordingEncoder(canvas, settings, plan, audioBuffer);

    const replay = createReductionReplay(term, settings);
    const frameDurationSec = 1 / settings.fps;
    const frameDurationMs = 1000 / settings.fps;
    let clockMs = 0;
    let nextStep = 0;
    let encodedFrames = 0;

    const advanceTo = (targetMs: number): void => {
      while (nextStep < plan.steps) {
        const stepStartMs = nextStep * settings.stepMs;
        if (stepStartMs > targetMs + 1e-7) break;
        if (stepStartMs > clockMs) {
          ticker!.update(stepStartMs);
          clockMs = stepStartMs;
        }
        const step = replay.step();
        if (!step) throw new Error(`record: replay ended after ${nextStep} of ${plan.steps} planned steps`);
        tree!.animateTo(step.node, settings.stepMs, () => {});
        nextStep++;
      }
      if (targetMs > clockMs) {
        ticker!.update(targetMs);
        clockMs = targetMs;
      }
    };

    for (let frame = 0; frame < plan.totalFrames; frame++) {
      throwIfAborted(hooks.signal);
      advanceTo(frame * frameDurationMs);
      renderer.render(stage);
      await encoder.addFrame(frame * frameDurationSec, frameDurationSec);
      encodedFrames++;
      hooks.onFrame?.(canvas, { frame: frame + 1, totalFrames: plan.totalFrames });
    }

    if (encodedFrames !== plan.totalFrames) {
      throw new Error(`record: encoded frame drift (${encodedFrames} !== ${plan.totalFrames})`);
    }
    const blob = await encoder.finalize();
    finalized = true;
    return blob;
  } catch (err) {
    if (encoder && !finalized) await encoder.cancel().catch(() => {});
    if (hooks.signal?.aborted) throw abortError();
    throw err;
  } finally {
    if (stage && tree) stage.removeChild(tree.container);
    tree?.destroy();
    stage?.destroy({ children: true });
    ticker?.destroy();
    renderer?.destroy({ removeView: true });
  }
}

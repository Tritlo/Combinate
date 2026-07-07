/**
 * The offline frame-perfect recording driver (ADR 24): a recorder-owned Pixi
 * pipeline stepped on a manual clock — no wall time, no live controller —
 * rendering each frame at the chosen resolution, encoding as it goes, and
 * handing every frame to the preview hook.
 */
import { Container, Ticker, autoDetectRenderer } from "pixi.js";
import { expandDisplay } from "../../core/catalog";
import { layoutAuto, layoutHTree, layoutRadial, layoutTopDown, type LayoutFn } from "../../core/layout";
import { layoutHTree3D, layoutSphere, type Layout3Fn } from "../../core/layout3d";
import { exceedsNodes, type Node } from "../../core/term";
import { Sphere3D, NODE_CAP } from "../sphere3d";
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

function layout3For(settings: RecordSettings): Layout3Fn {
  return settings.layout === "radial" ? layoutSphere : layoutHTree3D;
}

function displayTerm(term: Node, settings: RecordSettings): Node {
  return expandDisplay(term, { expandAll: settings.expandIota, isDiscovered: () => true });
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

interface RecordingPipeline {
  readonly canvas: HTMLCanvasElement;
  stepTo: (node: Node, durationMS: number) => void;
  advanceTo: (timeMS: number) => void;
  render: () => void;
  destroy: () => void;
}

async function setup2DPipeline(term: Node, settings: RecordSettings): Promise<RecordingPipeline> {
  const canvas = document.createElement("canvas");
  canvas.width = settings.width;
  canvas.height = settings.height;
  const renderer = await autoDetectRenderer({
    canvas,
    width: settings.width,
    height: settings.height,
    resolution: 1,
    autoDensity: false,
    background: theme.bg,
    antialias: true,
    preserveDrawingBuffer: true,
    preference: ["webgl", "canvas"],
  });
  const stage = new Container();
  const ticker = new Ticker();
  let tree: TreeView | null = null;
  try {
    ticker.autoStart = false;
    ticker.maxFPS = 0;
    ticker.lastTime = 0;

    tree = new TreeView(term, 0, 0, ticker, () => true, layoutFor(settings), () => settings.expandIota, null, (sym) => sym, { deterministicEdges: true });
    stage.addChild(tree.container);
    fitStage(stage, tree, settings);
    renderer.render(stage);
  } catch (err) {
    tree?.destroy();
    stage.destroy({ children: true });
    ticker.destroy();
    renderer.destroy({ removeView: true });
    throw err;
  }
  const view = tree;

  return {
    canvas,
    stepTo: (node, durationMS) => view.animateTo(node, durationMS, () => {}),
    advanceTo: (timeMS) => ticker.update(timeMS),
    render: () => renderer.render(stage),
    destroy: () => {
      stage.removeChild(view.container);
      view.destroy();
      stage.destroy({ children: true });
      ticker.destroy();
      renderer.destroy({ removeView: true });
    },
  };
}

async function setup3DPipeline(term: Node, settings: RecordSettings): Promise<RecordingPipeline> {
  const sphere = new Sphere3D({ now: () => 0, pixelRatio: 1, preserveDrawingBuffer: true, failOnMorphSnap: true });
  try {
    sphere.setLayout3(layout3For(settings));
    const first = displayTerm(term, settings);
    if (exceedsNodes(first, NODE_CAP)) throw new Error(`record: tree too large for 3D (over ${NODE_CAP} nodes)`);
    await sphere.show(first, settings.width, settings.height);
    if (sphere.lastCapped) throw new Error(`record: tree too large for 3D (over ${NODE_CAP} nodes)`);
  } catch (err) {
    sphere.destroy();
    throw err;
  }
  let clockMS = 0;

  return {
    canvas: sphere.canvas,
    stepTo: (node, durationMS) => {
      const next = displayTerm(node, settings);
      if (exceedsNodes(next, NODE_CAP)) throw new Error(`record: tree too large for 3D (over ${NODE_CAP} nodes)`);
      sphere.animateTo(next, durationMS);
    },
    advanceTo: (timeMS) => {
      const dt = timeMS - clockMS;
      if (dt > 0) sphere.advanceMorph(dt);
      clockMS = timeMS;
    },
    render: () => {},
    destroy: () => sphere.destroy(),
  };
}

async function setupPipeline(term: Node, settings: RecordSettings): Promise<RecordingPipeline> {
  return settings.view === "3d" ? setup3DPipeline(term, settings) : setup2DPipeline(term, settings);
}

function copyCanvas(source: HTMLCanvasElement, settings: RecordSettings): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = settings.width;
  out.height = settings.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("record: unable to create preview canvas");
  ctx.drawImage(source, 0, 0, settings.width, settings.height);
  return out;
}

/**
 * Render just the first frame (the term as laid out, no reduction) at the
 * chosen resolution — the modal's "layout feel" preview thumbnail.
 */
export async function renderFirstFrame(term: Node, settings: RecordSettings): Promise<HTMLCanvasElement> {
  const pipeline = await setupPipeline(term, settings);
  try {
    pipeline.render();
    return copyCanvas(pipeline.canvas, settings);
  } finally {
    pipeline.destroy();
  }
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
  const budget = frameBudget(plan.steps, settings);
  if (budget.totalFrames !== plan.totalFrames) {
    throw new Error(`record: frame budget drifted (${budget.totalFrames} !== ${plan.totalFrames})`);
  }
  if (plan.totalFrames <= 0) throw new Error("record: no frames to encode");

  let pipeline: RecordingPipeline | null = null;
  let encoder: RecordingEncoder | null = null;
  let finalized = false;

  try {
    throwIfAborted(hooks.signal);
    pipeline = await setupPipeline(term, settings);

    const audioBuffer = settings.audio && plan.tones.length > 0 ? await renderAudio(plan, settings) : null;
    encoder = await createRecordingEncoder(pipeline.canvas, settings, plan, audioBuffer);

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
          pipeline!.advanceTo(stepStartMs);
          clockMs = stepStartMs;
        }
        const step = replay.step();
        if (!step) throw new Error(`record: replay ended after ${nextStep} of ${plan.steps} planned steps`);
        pipeline!.stepTo(step.node, settings.stepMs);
        nextStep++;
      }
      if (targetMs > clockMs) {
        pipeline!.advanceTo(targetMs);
        clockMs = targetMs;
      }
    };

    for (let frame = 0; frame < plan.totalFrames; frame++) {
      throwIfAborted(hooks.signal);
      advanceTo(frame * frameDurationMs);
      pipeline.render();
      await encoder.addFrame(frame * frameDurationSec, frameDurationSec);
      encodedFrames++;
      hooks.onFrame?.(pipeline.canvas, { frame: frame + 1, totalFrames: plan.totalFrames });
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
    pipeline?.destroy();
  }
}

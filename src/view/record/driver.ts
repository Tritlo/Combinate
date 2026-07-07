/**
 * The offline frame-perfect recording driver (ADR 24): a recorder-owned Pixi
 * pipeline stepped on a manual clock — no wall time, no live controller —
 * rendering each frame at the chosen resolution, encoding as it goes, and
 * handing every frame to the preview hook.
 */
import { Container, Ticker, autoDetectRenderer } from "pixi.js";
import { expandDisplay, sugar } from "../../core/catalog";
import { countNodes, layoutAuto, layoutHTree, layoutRadial, layoutTopDown, type LayoutFn } from "../../core/layout";
import { layoutHTree3D, layoutSphere, type Layout3Fn } from "../../core/layout3d";
import { exceedsNodes, type Node } from "../../core/term";
import { redexAt } from "../../core/reduce";
import { behavioralRefolder } from "../../core/refold";
import { read, render, type Ty } from "../../core/types";
import { Sphere3D } from "../sphere3d";
import { TreeView } from "../tree";
import { ensureFont, monoFontReady, MONO, themeForMode, type Theme } from "../theme";
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

const FOLLOW_TAU_MS = 180;
const READOUT_PROBE_MAX = 3000;
const READOUT_TEXT_MAX = 512;

interface StageFit {
  x: number;
  y: number;
  scale: number;
}

interface RenderRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FrameStats {
  step: number;
  totalSteps: number;
  nodes: number;
  expression: string;
}

interface HeaderOverlayMetrics {
  inlineLaw: boolean;
  reservedTop: number;
}

interface OverlayMetrics {
  pad: number;
  gap: number;
  titlePx: number;
  lawPx: number;
  exprPx: number;
  statsPx: number;
  topCap: number;
  header: HeaderOverlayMetrics | null;
  reservedBottom: number;
}

function abortError(): Error {
  return new Error("recording cancelled");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function lineHeight(px: number): number {
  return Math.round(px * 1.22);
}

let overlayMeasureCtx: CanvasRenderingContext2D | null = null;

function measureOverlayText(text: string, font: string): number {
  if (!overlayMeasureCtx) {
    const canvas = document.createElement("canvas");
    overlayMeasureCtx = canvas.getContext("2d");
  }
  if (!overlayMeasureCtx) return text.length * 8;
  overlayMeasureCtx.font = font;
  return overlayMeasureCtx.measureText(text).width;
}

function overlayMetrics(settings: RecordSettings): OverlayMetrics {
  const h = settings.height;
  const pad = Math.max(8, Math.round(h * 0.012));
  const gap = Math.max(3, Math.round(h * 0.004));
  const titlePx = Math.max(15, Math.round(h * 0.023));
  const lawPx = Math.max(11, Math.round(h * 0.014));
  const exprPx = Math.max(12, Math.round(h * 0.017));
  const statsPx = Math.max(12, Math.round(h * 0.016));
  const topCap = Math.max(40, settings.width - pad * 2);
  let header: HeaderOverlayMetrics | null = null;
  if (settings.overlayInfo && settings.info) {
    const law = settings.info.law;
    let inlineLaw = true;
    if (law) {
      const inlineW =
        measureOverlayText(settings.info.title, overlayFont(titlePx, 700)) +
        measureOverlayText(" · ", overlayFont(lawPx)) +
        measureOverlayText(law, overlayFont(lawPx));
      inlineLaw = inlineW <= topCap;
    }
    const textH = lineHeight(titlePx) + (law && !inlineLaw ? gap + lineHeight(lawPx) : 0);
    header = { inlineLaw, reservedTop: pad + textH + gap };
  }
  const bottomPx = Math.max(settings.overlayInfo ? exprPx : 0, settings.overlayStats ? statsPx : 0);
  const reservedBottom = bottomPx > 0 ? gap + lineHeight(bottomPx) + pad : 0;
  return { pad, gap, titlePx, lawPx, exprPx, statsPx, topCap, header, reservedBottom };
}

function renderRect(settings: RecordSettings): RenderRect {
  const metrics = overlayMetrics(settings);
  const top = metrics.header?.reservedTop ?? 0;
  const bottom = metrics.reservedBottom;
  return { x: 0, y: top, w: settings.width, h: Math.max(1, settings.height - top - bottom) };
}

function stageFitFor(tree: TreeView, settings: RecordSettings): StageFit {
  const b = tree.worldBounds();
  const root = tree.layoutRootWorld;
  const rect = renderRect(settings);
  const margin = 0.82;
  const halfW = Math.max(1, Math.max(Math.abs(root.x - b.x), Math.abs(b.x + b.w - root.x)));
  const halfH = Math.max(1, Math.max(Math.abs(root.y - b.y), Math.abs(b.y + b.h - root.y)));
  const scale = Math.max(0.04, Math.min(2.5, Math.min((rect.w * margin) / (2 * halfW), (rect.h * margin) / (2 * halfH))));
  return { x: rect.x + rect.w / 2 - root.x * scale, y: rect.y + rect.h / 2 - root.y * scale, scale };
}

function applyStageFit(stage: Container, fit: StageFit): void {
  stage.scale.set(fit.scale);
  stage.position.set(fit.x, fit.y);
}

function followAlpha(deltaMS: number): number {
  return deltaMS <= 0 ? 0 : 1 - Math.exp(-deltaMS / FOLLOW_TAU_MS);
}

function followStage(stage: Container, target: StageFit, deltaMS: number): void {
  const a = followAlpha(deltaMS);
  if (a === 0) return;
  const scale = stage.scale.x + (target.scale - stage.scale.x) * a;
  stage.scale.set(scale);
  stage.position.set(stage.position.x + (target.x - stage.position.x) * a, stage.position.y + (target.y - stage.position.y) * a);
}

function fitStage(stage: Container, tree: TreeView, settings: RecordSettings): void {
  applyStageFit(stage, stageFitFor(tree, settings));
}

function nativeReadMode(settings: RecordSettings): Ty | undefined {
  const modes: Ty[] = [];
  if (settings.native.numbers) modes.push("Int");
  if (settings.native.lists) modes.push("List");
  if (settings.native.booleans) modes.push("Bool");
  return modes.length === 1 ? modes[0] : undefined;
}

function boundedSexp(root: Node, maxChars = READOUT_TEXT_MAX): string {
  let out = "";
  let truncated = false;
  const emit = (s: string): void => {
    if (truncated) return;
    const room = maxChars - out.length;
    if (s.length > room) {
      out += s.slice(0, Math.max(0, room));
      truncated = true;
    } else out += s;
  };
  const stack: Array<Node | string> = [root];
  while (stack.length && !truncated) {
    const item = stack.pop()!;
    if (typeof item === "string") {
      emit(item);
      continue;
    }
    switch (item.kind) {
      case "iota":
        emit("ι");
        break;
      case "comb":
        emit(item.sym);
        break;
      case "free":
        emit(item.name);
        break;
      case "app":
        stack.push(")", item.arg, " ", item.fn, "(");
        break;
    }
  }
  return truncated ? out + "…" : out;
}

function readoutExpression(node: Node, settings: RecordSettings): string {
  const mode = nativeReadMode(settings);
  const opts = { isDiscovered: () => true, mode };
  if (exceedsNodes(node, READOUT_PROBE_MAX)) return boundedSexp(node);
  if (redexAt(node) === null) {
    const value = read(node, mode ?? null);
    if (value) return render(value);
    return sugar(behavioralRefolder(node) ?? node, opts, READOUT_TEXT_MAX);
  }
  return sugar(node, opts, READOUT_TEXT_MAX);
}

interface RecordingPipeline {
  readonly canvas: HTMLCanvasElement;
  stepTo: (node: Node, durationMS: number) => void;
  advanceTo: (timeMS: number) => void;
  render: () => void;
  nodeCount: () => number;
  expression: () => string;
  destroy: () => void;
}

async function setup2DPipeline(term: Node, settings: RecordSettings): Promise<RecordingPipeline> {
  const colors = themeForMode(settings.theme, settings.color);
  const canvas = document.createElement("canvas");
  canvas.width = settings.width;
  canvas.height = settings.height;
  const renderer = await autoDetectRenderer({
    canvas,
    width: settings.width,
    height: settings.height,
    resolution: 1,
    autoDensity: false,
    background: colors.bg,
    antialias: true,
    preserveDrawingBuffer: true,
    preference: ["webgl", "canvas"],
  });
  const stage = new Container();
  const ticker = new Ticker();
  let tree: TreeView | null = null;
  let displayCount = countNodes(displayTerm(term, settings));
  let expression = readoutExpression(term, settings);
  let clockMS = 0;
  try {
    ticker.autoStart = false;
    ticker.maxFPS = 0;
    ticker.lastTime = 0;

    tree = new TreeView(term, 0, 0, ticker, () => true, layoutFor(settings), () => settings.expandIota, null, (sym) => sym, {
      deterministicEdges: true,
      themeMode: settings.theme,
      color: settings.color,
    });
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
    stepTo: (node, durationMS) => {
      displayCount = countNodes(displayTerm(node, settings));
      expression = readoutExpression(node, settings);
      view.animateTo(node, durationMS, () => {});
    },
    advanceTo: (timeMS) => {
      const dt = timeMS - clockMS;
      ticker.update(timeMS);
      if (settings.camera === "follow") followStage(stage, stageFitFor(view, settings), dt);
      clockMS = timeMS;
    },
    render: () => renderer.render(stage),
    nodeCount: () => displayCount,
    expression: () => expression,
    destroy: () => {
      stage.removeChild(view.container);
      view.destroy();
      stage.destroy({ children: true });
      ticker.destroy();
      renderer.destroy({ removeView: true });
    },
  };
}

async function setup3DPipeline(term: Node, settings: RecordSettings, durationSec = 0): Promise<RecordingPipeline> {
  const sphere = new Sphere3D({
    now: () => 0,
    pixelRatio: 1,
    preserveDrawingBuffer: true,
    failOnMorphSnap: true,
    unlimited: true,
    themeMode: settings.theme,
    color: settings.color,
  });
  let displayCount = countNodes(displayTerm(term, settings));
  let expression = readoutExpression(term, settings);
  try {
    sphere.setLayout3(layout3For(settings));
    const first = displayTerm(term, settings);
    await sphere.show(first, settings.width, settings.height);
  } catch (err) {
    sphere.destroy();
    throw err;
  }
  let clockMS = 0;

  return {
    canvas: sphere.canvas,
    stepTo: (node, durationMS) => {
      const next = displayTerm(node, settings);
      displayCount = countNodes(next);
      expression = readoutExpression(node, settings);
      sphere.animateTo(next, durationMS);
    },
    advanceTo: (timeMS) => {
      const dt = timeMS - clockMS;
      if (dt > 0) sphere.advanceMorph(dt);
      if (settings.rotate && durationSec > 0 && dt > 0) sphere.rotateBy((settings.spinRevs * dt * Math.PI * 2) / 1000 / durationSec);
      if (settings.camera === "follow") sphere.followFrame(followAlpha(dt));
      clockMS = timeMS;
    },
    render: () => {},
    nodeCount: () => displayCount,
    expression: () => expression,
    destroy: () => sphere.destroy(),
  };
}

async function setupPipeline(term: Node, settings: RecordSettings, durationSec = 0): Promise<RecordingPipeline> {
  return settings.view === "3d" ? setup3DPipeline(term, settings, durationSec) : setup2DPipeline(term, settings);
}

function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function overlayFont(size: number, weight = 400): string {
  return `${weight} ${size}px ${MONO}`;
}

function needsOverlay(settings: RecordSettings): boolean {
  return settings.overlayInfo || settings.overlayStats;
}

async function prepareOverlayFont(settings: RecordSettings): Promise<void> {
  if (!needsOverlay(settings)) return;
  ensureFont();
  const px = Math.max(12, Math.round(settings.height * 0.026));
  await monoFontReady(px).catch(() => {});
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  if (ctx.measureText(ellipsis).width > maxWidth) return "";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

function drawCenteredText(ctx: CanvasRenderingContext2D, text: string, font: string, color: string, centerX: number, y: number, maxWidth: number): void {
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  const fitted = fitText(ctx, text, maxWidth);
  if (!fitted) return;
  const width = ctx.measureText(fitted).width;
  ctx.fillText(fitted, centerX - width / 2, y);
}

function drawCenteredRuns(
  ctx: CanvasRenderingContext2D,
  runs: Array<{ text: string; font: string; color: string }>,
  centerX: number,
  y: number,
  linePx: number,
): void {
  const widths = runs.map((run) => {
    ctx.font = run.font;
    return ctx.measureText(run.text).width;
  });
  let x = centerX - widths.reduce((sum, width) => sum + width, 0) / 2;
  ctx.textBaseline = "middle";
  const midY = y + lineHeight(linePx) / 2;
  runs.forEach((run, i) => {
    ctx.font = run.font;
    ctx.fillStyle = run.color;
    ctx.fillText(run.text, x, midY);
    x += widths[i];
  });
}

function drawInfoOverlay(ctx: CanvasRenderingContext2D, settings: RecordSettings, colors: Theme): void {
  const metrics = overlayMetrics(settings);
  if (!metrics.header || !settings.info) return;
  const centerX = settings.width / 2;
  const y = metrics.pad;
  const titleFont = overlayFont(metrics.titlePx, 700);
  const lawFont = overlayFont(metrics.lawPx);
  const text = cssColor(colors.text);
  const dim = cssColor(colors.textDim);
  const law = settings.info.law;
  if (law && metrics.header.inlineLaw) {
    drawCenteredRuns(
      ctx,
      [
        { text: settings.info.title, font: titleFont, color: text },
        { text: " · ", font: lawFont, color: dim },
        { text: law, font: lawFont, color: dim },
      ],
      centerX,
      y,
      metrics.titlePx,
    );
    return;
  }
  drawCenteredText(ctx, settings.info.title, titleFont, text, centerX, y, metrics.topCap);
  if (law) drawCenteredText(ctx, law, lawFont, dim, centerX, y + lineHeight(metrics.titlePx) + metrics.gap, metrics.topCap);
}

function drawBottomOverlay(ctx: CanvasRenderingContext2D, settings: RecordSettings, stats: FrameStats, colors: Theme): void {
  if (!settings.overlayInfo && !settings.overlayStats) return;
  const metrics = overlayMetrics(settings);
  ctx.textBaseline = "alphabetic";
  const text = cssColor(colors.text);
  const baseline = settings.height - metrics.pad;
  let statsLeft = settings.width - metrics.pad;

  if (settings.overlayStats) {
    const statsText = `step ${stats.step}/${stats.totalSteps} · nodes ${stats.nodes}`;
    ctx.font = overlayFont(metrics.statsPx);
    const statsW = ctx.measureText(statsText).width;
    statsLeft = Math.max(metrics.pad, settings.width - metrics.pad - statsW);
    ctx.fillStyle = text;
    ctx.fillText(statsText, statsLeft, baseline, settings.width - metrics.pad * 2);
  }

  if (!settings.overlayInfo) return;
  const gap = metrics.gap * 2;
  const left = metrics.pad;
  const right = settings.overlayStats ? Math.max(left, statsLeft - gap) : settings.width - metrics.pad;
  const fullCap = settings.width - metrics.pad * 2;
  const centeredCap = Math.min(fullCap, Math.max(0, 2 * (right - settings.width / 2)));
  const useFrameCenter = centeredCap >= Math.min(160, settings.width * 0.28);
  const centerX = useFrameCenter ? settings.width / 2 : left + Math.max(0, right - left) / 2;
  const maxWidth = useFrameCenter ? centeredCap : Math.max(0, right - left);
  ctx.font = overlayFont(metrics.exprPx);
  const expr = fitText(ctx, stats.expression, maxWidth);
  if (!expr) return;
  const exprW = ctx.measureText(expr).width;
  ctx.fillStyle = text;
  ctx.fillText(expr, centerX - exprW / 2, baseline, maxWidth);
}

interface Compositor {
  readonly canvas: HTMLCanvasElement;
  compose: (source: HTMLCanvasElement, stats: FrameStats) => HTMLCanvasElement;
}

function drawSourceCanvas(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, settings: RecordSettings): void {
  const rect = renderRect(settings);
  if (settings.view !== "3d" || (rect.y === 0 && rect.h === settings.height)) {
    ctx.drawImage(source, 0, 0, settings.width, settings.height);
    return;
  }
  const scale = Math.min(rect.w / settings.width, rect.h / settings.height);
  const w = settings.width * scale;
  const h = settings.height * scale;
  ctx.drawImage(source, rect.x + (rect.w - w) / 2, rect.y + (rect.h - h) / 2, w, h);
}

function createCompositor(settings: RecordSettings): Compositor {
  const canvas = document.createElement("canvas");
  canvas.width = settings.width;
  canvas.height = settings.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("record: unable to create compositor canvas");
  const colors = themeForMode(settings.theme, settings.color);
  return {
    canvas,
    compose: (source, stats) => {
      ctx.fillStyle = cssColor(colors.bg);
      ctx.fillRect(0, 0, settings.width, settings.height);
      drawSourceCanvas(ctx, source, settings);
      drawInfoOverlay(ctx, settings, colors);
      drawBottomOverlay(ctx, settings, stats, colors);
      return canvas;
    },
  };
}

/**
 * Render just the first frame (the term as laid out, no reduction) at the
 * chosen resolution — the modal's "layout feel" preview thumbnail.
 */
export async function renderFirstFrame(term: Node, settings: RecordSettings): Promise<HTMLCanvasElement> {
  await prepareOverlayFont(settings);
  const pipeline = await setupPipeline(term, settings);
  const compositor = createCompositor(settings);
  try {
    pipeline.render();
    return compositor.compose(pipeline.canvas, { step: 0, totalSteps: 0, nodes: pipeline.nodeCount(), expression: pipeline.expression() });
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
    await prepareOverlayFont(settings);
    throwIfAborted(hooks.signal);
    pipeline = await setupPipeline(term, settings, plan.durationSec);
    const compositor = createCompositor(settings);

    const audioBuffer = settings.audio && plan.tones.length > 0 ? await renderAudio(plan, settings) : null;
    encoder = await createRecordingEncoder(compositor.canvas, settings, plan, audioBuffer);

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
      const frameCanvas = compositor.compose(pipeline.canvas, { step: nextStep, totalSteps: plan.steps, nodes: pipeline.nodeCount(), expression: pipeline.expression() });
      await encoder.addFrame(frame * frameDurationSec, frameDurationSec);
      encodedFrames++;
      hooks.onFrame?.(frameCanvas, { frame: frame + 1, totalFrames: plan.totalFrames });
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

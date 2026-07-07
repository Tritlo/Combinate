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
const FIT_MARGIN = 0.82;
const MIN_SCALE = 0.04;
const MAX_SCALE = 2.5;

interface StageFit {
  x: number;
  y: number;
  scale: number;
}

interface RootExtents {
  halfW: number;
  halfH: number;
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

interface OverlayState {
  title: string;
  cardW: number | null;
}

interface CardOverlayMetrics {
  inlineLaw: boolean;
  cardPadX: number;
  cardPadY: number;
  contentCap: number;
  cardW: number;
  cardH: number;
  shadow: number;
  reservedTop: number;
}

interface OverlayMetrics {
  pad: number;
  gap: number;
  titlePx: number;
  lawPx: number;
  exprPx: number;
  statsPx: number;
  card: CardOverlayMetrics | null;
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

function defaultOverlayTitle(settings: RecordSettings): string {
  return settings.info?.title ?? "";
}

function overlayTitle(overlay: OverlayState | undefined, settings: RecordSettings): string {
  return overlay?.title || defaultOverlayTitle(settings);
}

function cardWidthBounds(settings: RecordSettings, pad: number, shadow: number): { floor: number; ceiling: number } {
  const ceiling = Math.max(40, Math.min(settings.width * 0.86, settings.width - pad * 2 - shadow));
  return {
    floor: Math.min(ceiling, Math.max(40, settings.width * 0.3)),
    ceiling,
  };
}

function overlayMetrics(settings: RecordSettings, overlay?: OverlayState): OverlayMetrics {
  const h = settings.height;
  const pad = Math.max(8, Math.round(h * 0.012));
  const gap = Math.max(3, Math.round(h * 0.004));
  const titlePx = Math.max(15, Math.round(h * 0.023));
  const lawPx = Math.max(11, Math.round(h * 0.014));
  const exprPx = Math.max(12, Math.round(h * 0.017));
  const statsPx = Math.max(11, Math.round(h * 0.014));
  const cardPadX = Math.max(10, Math.round(h * 0.015));
  const cardPadY = Math.max(8, Math.round(h * 0.012));
  const shadow = Math.max(2, Math.round(h * 0.004));
  const bounds = cardWidthBounds(settings, pad, shadow);
  const cardW = overlay?.cardW != null ? Math.max(bounds.floor, Math.min(bounds.ceiling, overlay.cardW)) : bounds.ceiling;
  const topCap = Math.max(24, cardW - cardPadX * 2);
  let card: CardOverlayMetrics | null = null;
  if (settings.overlayInfo || settings.overlayStats) {
    const law = settings.info?.law;
    const title = overlayTitle(overlay, settings);
    const titleW = title ? measureOverlayText(title, overlayFont(titlePx, 700)) : 0;
    const lawW = law ? measureOverlayText(law, overlayFont(lawPx)) : 0;
    let inlineLaw = true;
    if (settings.overlayInfo && title && law) {
      const inlineW = titleW + measureOverlayText(" · ", overlayFont(lawPx)) + lawW;
      inlineLaw = inlineW <= topCap;
    }
    const linePxs: number[] = [];
    if (settings.overlayInfo && (title || law)) {
      linePxs.push(titlePx);
      if (law && !inlineLaw) linePxs.push(lawPx);
    }
    if (settings.overlayInfo) linePxs.push(exprPx);
    if (settings.overlayStats) linePxs.push(statsPx);
    const textH = linePxs.reduce((sum, px, i) => sum + lineHeight(px) + (i === 0 ? 0 : gap), 0);
    const cardH = textH + cardPadY * 2;
    card = {
      inlineLaw,
      cardPadX,
      cardPadY,
      contentCap: topCap,
      cardW,
      cardH,
      shadow,
      reservedTop: pad + cardH + shadow + gap,
    };
  }
  return { pad, gap, titlePx, lawPx, exprPx, statsPx, card };
}

function renderRect(settings: RecordSettings, overlay?: OverlayState): RenderRect {
  const metrics = overlayMetrics(settings, overlay);
  const top = metrics.card?.reservedTop ?? 0;
  return { x: 0, y: top, w: settings.width, h: Math.max(1, settings.height - top) };
}

function fitScaleForExtents(extents: RootExtents, rect: RenderRect): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min((rect.w * FIT_MARGIN) / (2 * extents.halfW), (rect.h * FIT_MARGIN) / (2 * extents.halfH))));
}

function stageFitFromExtents(root: { x: number; y: number }, extents: RootExtents, settings: RecordSettings, overlay?: OverlayState): StageFit {
  const rect = renderRect(settings, overlay);
  const scale = fitScaleForExtents(extents, rect);
  return { x: rect.x + rect.w / 2 - root.x * scale, y: rect.y + rect.h / 2 - root.y * scale, scale };
}

function rootExtents(minX: number, maxX: number, minY: number, maxY: number, root: { x: number; y: number }): RootExtents {
  return {
    halfW: Math.max(1, Math.max(Math.abs(root.x - minX), Math.abs(maxX - root.x))),
    halfH: Math.max(1, Math.max(Math.abs(root.y - minY), Math.abs(maxY - root.y))),
  };
}

function stageFitFor(tree: TreeView, settings: RecordSettings, extents?: RootExtents, overlay?: OverlayState): StageFit {
  const b = tree.worldBounds();
  const root = tree.layoutRootWorld;
  return stageFitFromExtents(root, extents ?? rootExtents(b.x, b.x + b.w, b.y, b.y + b.h, root), settings, overlay);
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

function fitStage(stage: Container, tree: TreeView, settings: RecordSettings, extents?: RootExtents, overlay?: OverlayState): void {
  applyStageFit(stage, stageFitFor(tree, settings, extents, overlay));
}

function layoutRootExtents(term: Node, settings: RecordSettings, layout: LayoutFn, frozen?: { l0?: number }): { extents: RootExtents; l0?: number } {
  const display = displayTerm(term, settings);
  const lay = layout(display, frozen);
  const root = lay.pos.get(display.id) ?? { x: 0, y: 0 };
  return { extents: rootExtents(lay.minX, lay.maxX, lay.minY, lay.maxY, root), l0: lay.l0 };
}

function holdExtentsFor(term: Node, settings: RecordSettings, steps: number): RootExtents {
  const layout = layoutFor(settings);
  const first = layoutRootExtents(term, settings, layout);
  const frozen = { l0: first.l0 };
  const best = { ...first.extents };
  const replay = createReductionReplay(term, settings);
  for (let i = 0; i < steps; i++) {
    const next = replay.step();
    if (!next) break;
    const e = layoutRootExtents(next.node, settings, layout, frozen).extents;
    best.halfW = Math.max(best.halfW, e.halfW);
    best.halfH = Math.max(best.halfH, e.halfH);
  }
  return best;
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

function initialOverlayTitle(term: Node, settings: RecordSettings): string {
  try {
    const title = readoutExpression(term, settings).trim();
    return title || defaultOverlayTitle(settings);
  } catch {
    return defaultOverlayTitle(settings);
  }
}

function overlayCardWidthFromExtents(settings: RecordSettings, title: string, extents: RootExtents): number | null {
  if (!needsOverlay(settings)) return null;
  let cardW: number | null = null;
  for (let i = 0; i < 4; i++) {
    const overlay: OverlayState = { title, cardW };
    const metrics = overlayMetrics(settings, overlay);
    if (!metrics.card) return null;
    const treeW = 2 * extents.halfW * fitScaleForExtents(extents, renderRect(settings, overlay));
    const bounds = cardWidthBounds(settings, metrics.pad, metrics.card.shadow);
    cardW = Math.max(bounds.floor, Math.min(bounds.ceiling, treeW));
  }
  return cardW;
}

function overlayStateFor(term: Node, settings: RecordSettings, extents?: RootExtents): OverlayState {
  const title = initialOverlayTitle(term, settings);
  return { title, cardW: extents ? overlayCardWidthFromExtents(settings, title, extents) : null };
}

interface RecordingPipeline {
  readonly canvas: HTMLCanvasElement;
  readonly overlay: OverlayState;
  stepTo: (node: Node, durationMS: number) => void;
  advanceTo: (timeMS: number) => void;
  render: () => void;
  nodeCount: () => number;
  expression: () => string;
  destroy: () => void;
}

async function setup2DPipeline(term: Node, settings: RecordSettings, holdSteps = 0): Promise<RecordingPipeline> {
  const colors = themeForMode(settings.theme, settings.color);
  const holdExtents = settings.camera === "hold" ? holdExtentsFor(term, settings, holdSteps) : undefined;
  const initialExtents = holdExtents ?? layoutRootExtents(term, settings, layoutFor(settings)).extents;
  const overlay = overlayStateFor(term, settings, initialExtents);
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
    fitStage(stage, tree, settings, holdExtents, overlay);
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
    overlay,
    stepTo: (node, durationMS) => {
      displayCount = countNodes(displayTerm(node, settings));
      expression = readoutExpression(node, settings);
      view.animateTo(node, durationMS, () => {});
    },
    advanceTo: (timeMS) => {
      const dt = timeMS - clockMS;
      ticker.update(timeMS);
      if (settings.camera === "follow") followStage(stage, stageFitFor(view, settings, undefined, overlay), dt);
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
  const overlay = overlayStateFor(term, settings);
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
    overlay,
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

async function setupPipeline(term: Node, settings: RecordSettings, plan?: Pick<RecordPlan, "durationSec" | "steps">): Promise<RecordingPipeline> {
  return settings.view === "3d" ? setup3DPipeline(term, settings, plan?.durationSec ?? 0) : setup2DPipeline(term, settings, plan?.steps ?? 0);
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

function drawInfoOverlay(ctx: CanvasRenderingContext2D, settings: RecordSettings, overlay: OverlayState, stats: FrameStats, colors: Theme): void {
  const metrics = overlayMetrics(settings, overlay);
  if (!metrics.card) return;
  const centerX = settings.width / 2;
  const text = cssColor(colors.text);
  const dim = cssColor(colors.textDim);
  const title = overlayTitle(overlay, settings);
  const lines: Array<{ px: number; width: number; draw: (y: number) => void }> = [];
  const textLine = (value: string, font: string, color: string, px: number): void => {
    ctx.font = font;
    const fitted = fitText(ctx, value, metrics.card!.contentCap);
    const width = fitted ? ctx.measureText(fitted).width : 0;
    lines.push({
      px,
      width,
      draw: (y) => {
        if (!fitted) return;
        ctx.font = font;
        ctx.textBaseline = "top";
        ctx.fillStyle = color;
        ctx.fillText(fitted, centerX - width / 2, y);
      },
    });
  };

  if (settings.overlayInfo && (title || settings.info?.law)) {
    const titleFont = overlayFont(metrics.titlePx, 700);
    const lawFont = overlayFont(metrics.lawPx);
    const law = settings.info?.law;
    if (title && law && metrics.card.inlineLaw) {
      const runs = [
        { text: title, font: titleFont, color: text },
        { text: " · ", font: lawFont, color: dim },
        { text: law, font: lawFont, color: dim },
      ];
      const width = runs.reduce((sum, run) => {
        ctx.font = run.font;
        return sum + ctx.measureText(run.text).width;
      }, 0);
      lines.push({ px: metrics.titlePx, width, draw: (y) => drawCenteredRuns(ctx, runs, centerX, y, metrics.titlePx) });
    } else {
      if (title) textLine(title, titleFont, text, metrics.titlePx);
      if (law) textLine(law, lawFont, dim, metrics.lawPx);
    }
  }
  if (settings.overlayInfo) textLine(stats.expression, overlayFont(metrics.exprPx), text, metrics.exprPx);
  if (settings.overlayStats) textLine(`step ${stats.step}/${stats.totalSteps} · nodes ${stats.nodes}`, overlayFont(metrics.statsPx), dim, metrics.statsPx);
  if (lines.length === 0) return;

  const cardW = Math.ceil(metrics.card.cardW);
  const cardX = Math.round((settings.width - cardW) / 2);
  const cardY = metrics.pad;

  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(cardX + metrics.card.shadow, cardY + metrics.card.shadow, cardW, metrics.card.cardH);
  ctx.fillStyle = cssColor(colors.panel);
  ctx.fillRect(cardX, cardY, cardW, metrics.card.cardH);
  ctx.strokeStyle = cssColor(colors.border);
  ctx.lineWidth = 1;
  ctx.strokeRect(cardX + 0.5, cardY + 0.5, cardW - 1, metrics.card.cardH - 1);

  let y = cardY + metrics.card.cardPadY;
  for (const line of lines) {
    line.draw(y);
    y += lineHeight(line.px) + metrics.gap;
  }
}

interface Compositor {
  readonly canvas: HTMLCanvasElement;
  compose: (source: HTMLCanvasElement, stats: FrameStats) => HTMLCanvasElement;
}

/** A quiet grey watermark in the bottom-right corner — drawn on every frame. */
function drawAttribution(ctx: CanvasRenderingContext2D, settings: RecordSettings, colors: Theme): void {
  const px = Math.max(10, Math.round(settings.height * 0.018));
  const pad = Math.max(6, Math.round(settings.height * 0.012));
  ctx.font = overlayFont(px);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = cssColor(colors.textDim);
  const text = "https://combinate.app";
  ctx.fillText(text, settings.width - pad - ctx.measureText(text).width, settings.height - pad);
}

function drawSourceCanvas(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, settings: RecordSettings, overlay: OverlayState): void {
  const rect = renderRect(settings, overlay);
  if (settings.view !== "3d" || (rect.y === 0 && rect.h === settings.height)) {
    ctx.drawImage(source, 0, 0, settings.width, settings.height);
    return;
  }
  const scale = Math.min(rect.w / settings.width, rect.h / settings.height);
  const w = settings.width * scale;
  const h = settings.height * scale;
  ctx.drawImage(source, rect.x + (rect.w - w) / 2, rect.y + (rect.h - h) / 2, w, h);
}

function createCompositor(settings: RecordSettings, overlay: OverlayState): Compositor {
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
      drawSourceCanvas(ctx, source, settings, overlay);
      drawInfoOverlay(ctx, settings, overlay, stats, colors);
      drawAttribution(ctx, settings, colors);
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
  const compositor = createCompositor(settings, pipeline.overlay);
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
    pipeline = await setupPipeline(term, settings, plan);
    const compositor = createCompositor(settings, pipeline.overlay);

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

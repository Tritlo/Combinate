/**
 * The offline frame-perfect recording driver (ADR 24): a recorder-owned Pixi
 * pipeline stepped on a manual clock — no wall time, no live controller —
 * rendering each frame at the chosen resolution, encoding as it goes, and
 * handing every frame to the preview hook.
 */
import { Container, Ticker, autoDetectRenderer } from "pixi.js";
import { expandDisplay, sugar } from "../../core/catalog";
import { countNodes, layoutAuto, layoutHTree, layoutRadial, layoutTopDown, layoutBotanical, layoutMobile, layoutHyperbolic, type LayoutFn } from "../../core/layouts";
import { layoutHTree3D, layoutSphere, layoutBotanical3D, layoutMobile3D, type Layout3Fn } from "../../core/layouts";
import { exceedsNodes, type Node } from "../../core/term";
import { redexAt } from "../../core/reduce";
import { behavioralRefolder } from "../../core/refold";
import { read, render, type Ty } from "../../core/types";
import { Sphere3D } from "../sphere3d";
import { TreeView } from "../tree";
import { ensureFont, monoFontReady, MONO, themeForMode, type Theme } from "../theme";
import { renderAudio } from "./audio";
import { createRecordingEncoder, type RecordingEncoder } from "./encoder";
import { createReductionReplay, createScheduleCursor, frameBudget } from "./precount";
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
    case "botanical":
      return layoutBotanical;
    case "mobile":
      return layoutMobile;
    case "hyperbolic":
      return layoutHyperbolic;
  }
}

function layout3For(settings: RecordSettings): Layout3Fn {
  switch (settings.layout) {
    case "radial":
    case "hyperbolic":
      return layoutSphere;
    case "botanical":
      return layoutBotanical3D;
    case "mobile":
      return layoutMobile3D;
    default:
      return layoutHTree3D;
  }
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
/** Wall-clock gap between paint yields in the encode loop — lets the browser
 *  repaint the preview's progress bar/ETA without materially slowing encoding. */
const YIELD_INTERVAL_MS = 250;

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
  cardPadX: number;
  cardPadY: number;
  titleBarH: number;
  titleCap: number;
  dot: number;
  dotGap: number;
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
  return new Error("recording canceled");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function lineHeight(px: number): number {
  return Math.round(px * 1.22);
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
  const titlePadY = Math.max(4, Math.round(h * 0.006));
  const dot = Math.max(7, Math.round(h * 0.013));
  const dotGap = Math.max(7, Math.round(h * 0.012));
  const shadow = Math.max(2, Math.round(h * 0.004));
  const bounds = cardWidthBounds(settings, pad, shadow);
  const cardW = overlay?.cardW != null ? Math.max(bounds.floor, Math.min(bounds.ceiling, overlay.cardW)) : bounds.ceiling;
  const contentCap = Math.max(24, cardW - cardPadX * 2);
  const titleBarH = lineHeight(titlePx) + titlePadY * 2;
  const titleCap = Math.max(12, cardW - cardPadX * 2 - dot - dotGap);
  let card: CardOverlayMetrics | null = null;
  if (settings.overlayInfo || settings.overlayStats) {
    const law = settings.info?.law;
    const linePxs: number[] = [];
    if (settings.overlayInfo && law) linePxs.push(lawPx);
    if (settings.overlayInfo) linePxs.push(exprPx);
    if (settings.overlayStats) linePxs.push(statsPx);
    const textH = linePxs.reduce((sum, px, i) => sum + lineHeight(px) + (i === 0 ? 0 : gap), 0);
    const bodyH = linePxs.length > 0 ? textH + cardPadY * 2 : 0;
    const cardH = titleBarH + bodyH;
    card = {
      cardPadX,
      cardPadY,
      titleBarH,
      titleCap,
      dot,
      dotGap,
      contentCap,
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

/** Root extents straight from a built tree's layout — no re-expanding the term
 *  (the tree already laid out every node). */
function treeRootExtents(tree: TreeView): RootExtents {
  const b = tree.worldBounds();
  const root = tree.layoutRootWorld;
  return rootExtents(b.x, b.x + b.w, b.y, b.y + b.h, root);
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
  const source = settings.info?.source?.trim();
  if (source) return source; // authoritative source expression (e.g. compiled Haskell) wins over the lens
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

async function setup2DPipeline(term: Node, settings: RecordSettings, onPhase?: (label: string) => void): Promise<RecordingPipeline> {
  const colors = themeForMode(settings.theme, settings.color);
  const canvas = document.createElement("canvas");
  canvas.width = settings.width;
  canvas.height = settings.height;
  onPhase?.("Starting renderer…");
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
  // Derived from the built tree below — the term is expanded/laid out exactly
  // once (by TreeView), not three times (extents + count + tree).
  let holdExtents!: RootExtents;
  let overlay!: OverlayState;
  let displayCount = 0;
  let expression = "";
  let clockMS = 0;
  try {
    ticker.autoStart = false;
    ticker.maxFPS = 0;
    ticker.lastTime = 0;

    onPhase?.("Building scene…");
    tree = new TreeView(term, 0, 0, ticker, () => true, layoutFor(settings), () => settings.expandIota, null, (sym) => sym, {
      deterministicEdges: true,
      themeMode: settings.theme,
      color: settings.color,
    });
    stage.addChild(tree.container);
    onPhase?.("Fitting camera…");
    holdExtents = treeRootExtents(tree);
    overlay = overlayStateFor(term, settings, holdExtents);
    displayCount = tree.nodeCount();
    expression = readoutExpression(term, settings);
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
  const zoomOutToHoldExtents = (): void => {
    const b = view.worldBounds();
    const root = view.layoutRootWorld;
    const next = rootExtents(b.x, b.x + b.w, b.y, b.y + b.h, root);
    if (next.halfW <= holdExtents.halfW && next.halfH <= holdExtents.halfH) return;
    holdExtents = {
      halfW: Math.max(holdExtents.halfW, next.halfW),
      halfH: Math.max(holdExtents.halfH, next.halfH),
    };
    applyStageFit(stage, stageFitFor(view, settings, holdExtents, overlay));
  };

  return {
    canvas,
    overlay,
    stepTo: (node, durationMS) => {
      view.animateTo(node, durationMS, () => {});
      if (durationMS <= 0) view.stopAnimation();
      // Read the count off the tree we just laid out — no second expansion.
      displayCount = view.nodeCount();
      expression = readoutExpression(node, settings);
      if (settings.camera === "hold") zoomOutToHoldExtents();
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

async function setup3DPipeline(term: Node, settings: RecordSettings, durationSec = 0, onPhase?: (label: string) => void): Promise<RecordingPipeline> {
  const overlay = overlayStateFor(term, settings);
  const sphere = new Sphere3D({
    now: () => 0,
    pixelRatio: 1,
    preserveDrawingBuffer: true,
    themeMode: settings.theme,
    color: settings.color,
  });
  let displayCount = countNodes(displayTerm(term, settings));
  let expression = readoutExpression(term, settings);
  try {
    sphere.setLayout3(layout3For(settings));
    onPhase?.("Building scene…");
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
      if (durationMS <= 0) sphere.settleMorph();
      if (settings.camera === "hold") sphere.zoomOutToFrame();
    },
    advanceTo: (timeMS) => {
      const dt = timeMS - clockMS;
      if (dt > 0) sphere.advanceMorph(dt);
      // Whole revolutions only — the turn must complete exactly at the clip's end.
      const revs = Math.max(1, Math.round(settings.spinRevs));
      if (settings.rotate && durationSec > 0 && dt > 0) sphere.rotateBy((revs * dt * Math.PI * 2) / 1000 / durationSec);
      if (settings.camera === "follow") sphere.followFrame(followAlpha(dt));
      clockMS = timeMS;
    },
    render: () => {},
    nodeCount: () => displayCount,
    expression: () => expression,
    destroy: () => sphere.destroy(),
  };
}

async function setupPipeline(
  term: Node,
  settings: RecordSettings,
  plan?: Pick<RecordPlan, "durationSec">,
  onPhase?: (label: string) => void,
): Promise<RecordingPipeline> {
  return settings.view === "3d" ? setup3DPipeline(term, settings, plan?.durationSec ?? 0, onPhase) : setup2DPipeline(term, settings, onPhase);
}

function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

interface OverlayChrome {
  paper: string;
  ink: string;
  dim: string;
  shadow: string;
  red: string;
}

function overlayChrome(mode: RecordSettings["theme"]): OverlayChrome {
  return mode === "dark"
    ? { paper: "#07090d", ink: "#f0f3f6", dim: "rgba(240,246,252,0.62)", shadow: "rgba(0,0,0,0.85)", red: "#ff6b5f" }
    : { paper: "#ffffff", ink: "#000000", dim: "rgba(27,31,36,0.62)", shadow: "rgba(0,0,0,0.65)", red: "#b42318" };
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

function drawInfoOverlay(ctx: CanvasRenderingContext2D, settings: RecordSettings, overlay: OverlayState, stats: FrameStats): void {
  const metrics = overlayMetrics(settings, overlay);
  if (!metrics.card) return;
  const chrome = overlayChrome(settings.theme);
  const title = overlayTitle(overlay, settings);
  const cardW = Math.ceil(metrics.card.cardW);
  const cardX = Math.round((settings.width - cardW) / 2);
  const cardY = metrics.pad;

  ctx.fillStyle = chrome.shadow;
  ctx.fillRect(cardX + metrics.card.shadow, cardY + metrics.card.shadow, cardW, metrics.card.cardH);
  ctx.fillStyle = chrome.paper;
  ctx.fillRect(cardX, cardY, cardW, metrics.card.cardH);
  ctx.fillStyle = chrome.ink;
  ctx.fillRect(cardX, cardY, cardW, metrics.card.titleBarH);

  const titleMidY = cardY + metrics.card.titleBarH / 2;
  const dotX = cardX + metrics.card.cardPadX + metrics.card.dot / 2;
  ctx.beginPath();
  ctx.arc(dotX, titleMidY, metrics.card.dot / 2, 0, Math.PI * 2);
  ctx.fillStyle = chrome.red;
  ctx.fill();

  ctx.font = overlayFont(metrics.titlePx, 700);
  ctx.textBaseline = "middle";
  ctx.fillStyle = chrome.paper;
  const titleX = cardX + metrics.card.cardPadX + metrics.card.dot + metrics.card.dotGap;
  ctx.fillText(fitText(ctx, title, metrics.card.titleCap), titleX, titleMidY);

  ctx.strokeStyle = chrome.ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(cardX + 0.5, cardY + 0.5, cardW - 1, metrics.card.cardH - 1);

  const drawLine = (value: string, font: string, color: string, px: number): void => {
    ctx.font = font;
    ctx.textBaseline = "top";
    ctx.fillStyle = color;
    ctx.fillText(fitText(ctx, value, metrics.card!.contentCap), cardX + metrics.card!.cardPadX, y);
    y += lineHeight(px) + metrics.gap;
  };
  let y = cardY + metrics.card.titleBarH + metrics.card.cardPadY;
  if (settings.overlayInfo && settings.info?.law) drawLine(settings.info.law, overlayFont(metrics.lawPx), chrome.dim, metrics.lawPx);
  if (settings.overlayInfo) drawLine(stats.expression, overlayFont(metrics.exprPx), chrome.ink, metrics.exprPx);
  if (settings.overlayStats) drawLine(`step ${stats.step}/${stats.totalSteps} · nodes ${stats.nodes}`, overlayFont(metrics.statsPx), chrome.dim, metrics.statsPx);
}

interface Compositor {
  readonly canvas: HTMLCanvasElement;
  compose: (source: HTMLCanvasElement, stats: FrameStats) => HTMLCanvasElement;
}

/** A quiet gray watermark in the bottom-right corner — drawn on every frame. */
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
      drawInfoOverlay(ctx, settings, overlay, stats);
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
    hooks.onPhase?.("Preparing…");
    await prepareOverlayFont(settings);
    throwIfAborted(hooks.signal);
    pipeline = await setupPipeline(term, settings, plan, hooks.onPhase);
    const compositor = createCompositor(settings, pipeline.overlay);

    if (settings.audio && plan.tones.length > 0) hooks.onPhase?.("Rendering audio…");
    const audioBuffer = settings.audio && plan.tones.length > 0 ? await renderAudio(plan, settings) : null;
    hooks.onPhase?.("Starting encoder…");
    encoder = await createRecordingEncoder(compositor.canvas, settings, plan, audioBuffer);

    hooks.onPhase?.("Rendering…");
    const replay = createReductionReplay(term, settings);
    const schedule = createScheduleCursor(settings);
    const frameDurationSec = 1 / settings.fps;
    const frameDurationMs = 1000 / settings.fps;
    let clockMs = 0;
    let nextStep = 0;
    let nextGroup = schedule.next(plan.steps);
    let encodedFrames = 0;

    const advanceTo = (targetMs: number): void => {
      while (nextGroup) {
        if (nextGroup.timeMs > targetMs + 1e-7) break;
        if (nextGroup.timeMs > clockMs) {
          pipeline!.advanceTo(nextGroup.timeMs);
          clockMs = nextGroup.timeMs;
        }
        let node: Node | null = null;
        for (let i = 0; i < nextGroup.stepCount; i++) {
          const step = replay.step();
          if (!step) throw new Error(`record: replay ended after ${nextStep} of ${plan.steps} planned steps`);
          node = step.node;
          nextStep++;
        }
        if (node) {
          const durationMs = nextGroup.stepCount === 1 && nextGroup.durationMs > frameDurationMs + 1e-7 ? nextGroup.durationMs : 0;
          pipeline!.stepTo(node, durationMs);
        }
        nextGroup = schedule.next(plan.steps - nextStep);
      }
      if (targetMs > clockMs) {
        pipeline!.advanceTo(targetMs);
        clockMs = targetMs;
      }
    };

    let lastYieldMs = performance.now();
    for (let frame = 0; frame < plan.totalFrames; frame++) {
      throwIfAborted(hooks.signal);
      advanceTo(frame * frameDurationMs);
      pipeline.render();
      const frameCanvas = compositor.compose(pipeline.canvas, { step: nextStep, totalSteps: plan.steps, nodes: pipeline.nodeCount(), expression: pipeline.expression() });
      await encoder.addFrame(frame * frameDurationSec, frameDurationSec);
      encodedFrames++;
      hooks.onFrame?.(frameCanvas, { frame: frame + 1, totalFrames: plan.totalFrames });
      // Mediabunny's backpressure `await` isn't a paint boundary, so hand the
      // browser a real macrotask every ~250ms to repaint the progress bar/ETA.
      const nowMs = performance.now();
      if (nowMs - lastYieldMs >= YIELD_INTERVAL_MS) {
        lastYieldMs = nowMs;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        throwIfAborted(hooks.signal);
      }
    }

    if (encodedFrames !== plan.totalFrames) {
      throw new Error(`record: encoded frame drift (${encodedFrames} !== ${plan.totalFrames})`);
    }
    if (nextStep !== plan.steps) {
      throw new Error(`record: replay frame budget missed ${plan.steps - nextStep} planned steps`);
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

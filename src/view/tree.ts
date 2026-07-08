import { CanvasTextMetrics, Container, Graphics, ParticleContainer, Particle, Rectangle, Text, TextStyle, Texture, type Ticker } from "pixi.js";
import { type Node, type NodeId, IOTA_ID_SPAN } from "../core/term";
import { expandDisplay } from "../core/catalog";
import { type Layout, type LayoutFn, layoutHTreeSubtree } from "../core/layout";
import { type StepPatch } from "../core/reduce";
import { theme, combinatorColor, combinatorColorForMode, currentMode, glyphOn, edgeTierColor, MONO, monoFontReady, themeForMode, edgeTierColorForMode, type Mode, type Theme } from "./theme";
import { EdgeBuffer, edgeKey } from "./edgeBuffer";
import { tween, easeInOut } from "./anim";

const LAYOUT_MS = 360; // duration of the layout-toggle reflow
// Above this node count we drop the per-node text glyphs (you can't read them at
// that density anyway) and render dots only — the expensive `Text` objects are
// what cost the most. Tune to taste; the particle nodes/edges scale far past it.
const GLYPH_MAX = 300;
// Above this many displayed nodes we stop animating reduction steps: each step
// jump-cuts to its settled layout (no per-frame tween, no per-frame edge redraw)
// and argument edges draw solid WHILE STEPPING (dashing multiplies edge geometry, and a heavy
// reduction redraws every few ms). Below it, small trees keep the nice tween + dashed edges. A big
// tree upgrades to dashed once it SETTLES (see SETTLE_DASH_MS) so an expanded ι-tree shows its dashes.
const HEAVY = 600;
// A big tree's edges go from solid to dashed once they've not been redrawn for this long — i.e. the
// reduction stopped / the tree is being inspected (the Expand ι-tree view). Keeps fac-scale playback
// fast (solid while stepping) without permanently dropping the function/argument dash cue.
const SETTLE_DASH_MS = 200;
// At/above this node count an H-tree tree reduces through the incremental applyPatch path (retained
// edge buffer + O(changed) reflow) rather than the full-recompute animateTo. Matches the jump-cut
// threshold, so any tree big enough to jump-cut also updates incrementally when it is an H-tree.
const INCR_MIN = 600;
// Radius of the shared white circle texture all node particles are drawn from; a
// node of radius r renders at scale r / TEX_R, tinted by its kind.
const TEX_R = 32;
// Text glyphs rasterize at fontSize 15 (the comb glyph size — see visSpec); every live TreeView
// re-rasterizes its glyphs (a `refresh()`, the same repaint a theme change triggers) once the
// webfont actually loads, since a glyph drawn before then is stuck on the fallback face.
const liveViews = new Set<TreeView>();
void monoFontReady(15).then(() => {
  for (const v of liveViews) v.refresh();
});

// Node/edge colors come from the active theme (theme.ts). Edges encode two things: STYLE =
// function (left, solid) vs argument (right, dashed), and COLOUR = depth tier (edgeTierColor:
// red/black alternating), so a node's parent-edge differs from its child-edges and `(ι X)` vs
// `(X ι)` read differently.

let nodeTex: Texture | null = null;
/** The white node-particle disc (tinted per kind), built once from a 2D canvas. */
function nodeTexture(): Texture {
  if (nodeTex) return nodeTex;
  const s = TEX_R * 2;
  const canvas = document.createElement("canvas");
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(TEX_R, TEX_R, TEX_R - 1, 0, Math.PI * 2); // -1px of AA breathing room
  ctx.fill();
  nodeTex = new Texture({ source: Texture.from(canvas).source, frame: new Rectangle(0, 0, s, s) });
  return nodeTex;
}

/** The disc radius per node kind — the one source of truth {@link visSpec} and {@link radiusOf} share. */
const RADIUS: Record<Node["kind"], number> = { iota: 7, comb: 15, free: 13, app: 5 };
const iotaDot = (mode: Mode): number => (mode === "light" ? 0x000000 : 0xffffff);

// A combinator sym this long or longer overflows the comb disc: IoskeleyMono at fontSize 15 (the comb
// glyph size) is a 9px/char monospace, and the 30px disc (2×RADIUS.comb) only comfortably fits 3
// characters (27px) — a 4-char sym (36px) already overflows by more than its own side-bearing
// (measured against the live webfont; matches the reported "compare" → "ompar" clipping). Boxed nodes
// render as a pill instead of the shared disc texture — see makePill.
const PILL_MIN_LEN = 4;
const COMB_GLYPH_STYLE = new TextStyle({ fontFamily: MONO, fontSize: 15 });

/** The disc radius, tint, and (optional) text glyph for each node kind; `boxed` marks a comb node
 *  whose DISPLAYED name is too long for the disc (see {@link PILL_MIN_LEN}) — it renders as a pill
 *  instead. `labelFor` resolves a comb node's glyph text (ADR 23: context-sensitive on the hotbar's
 *  open page, e.g. `K` reads "[]" with Lists open) — `n.sym` stays the tint/identity key, only the
 *  glyph text and (transitively) the boxed measurement follow the resolved label. */
function visSpec(
  n: Node,
  labelFor: (sym: string) => string,
  palette: { mode: Mode; color: boolean; colors: Theme } | null,
): { radius: number; tint: number; glyph: { text: string; color: number; size: number } | null; boxed: boolean } {
  const colors = palette?.colors ?? theme;
  switch (n.kind) {
    case "iota":
      return { radius: RADIUS.iota, tint: iotaDot(palette?.mode ?? currentMode()), glyph: null, boxed: false };
    case "comb": {
      const tint = palette ? (palette.color ? combinatorColorForMode(n.sym, palette.mode) : colors.node) : combinatorColor(n.sym); // per-combinator hue in Color mode, ink in mono
      const text = labelFor(n.sym);
      return { radius: RADIUS.comb, tint, glyph: { text, color: glyphOn(tint), size: 15 }, boxed: text.length >= PILL_MIN_LEN };
    }
    case "free":
      // a free var sits on a muted (gray) dot, so its glyph is ink (text), not
      // paper — paper-on-gray is too low-contrast.
      return { radius: RADIUS.free, tint: colors.mutedDot, glyph: { text: n.name, color: colors.text, size: 14 }, boxed: false };
    default:
      return { radius: RADIUS.app, tint: colors.mutedDot, glyph: null, boxed: false }; // app junction dot
  }
}
const radiusOf = (kind: Node["kind"]): number => RADIUS[kind];

/** A per-node pill (stadium shape) sized to `text`, for a comb node too long for the shared disc
 *  texture. Drawn white and tinted like the disc (see {@link nodeTexture}) so a pill's fill and its
 *  glyph color follow the exact same {@link combinatorColor}/{@link glyphOn} logic as a circle node. */
function makePill(text: string, tint: number): Graphics {
  const w = CanvasTextMetrics.measureText(text, COMB_GLYPH_STYLE).width + 10; // 5px breathing room each side
  const h = RADIUS.comb * 2;
  const g = new Graphics().roundRect(-w / 2, -h / 2, w, h, h / 2).fill(0xffffff);
  g.tint = tint;
  return g;
}

// A glyph's canvas bitmap is rasterized once at Text-creation time; the camera then scales the whole
// tree as a transform, which smears a bitmap rasterized for 1×. So each glyph's `resolution` tracks
// the camera zoom, quantized to (at most) 4 discrete levels — both to avoid re-rasterizing every
// frame of a live zoom AND as a hard cap now that deep zoom reaches 1e7× (an uncapped resolution
// would try to rasterize gigapixel glyphs; past 4× a deep-zoomed glyph's on-screen size is governed
// by its tiny node scale anyway, so 4× density suffices).
const MAX_GLYPH_RES = 4;
/** The `Text.resolution` for a glyph drawn at camera zoom `zoom` (quantized, see above). Exported so
 *  the drag-snap ghost preview label can match a tree's node glyphs instead of staying fixed at 1×. */
export function glyphResLevel(zoom: number): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.min(MAX_GLYPH_RES, Math.ceil(dpr * zoom)));
}

/** One rendered node: an instanced particle (the disc), the scale that maps the
 *  shared texture to this kind's radius, and a lazily-created text glyph (only
 *  present below {@link GLYPH_MAX}). `boxed` nodes additionally get a `pill` (in
 *  lockstep with the glyph) and their particle disc is hidden while it's shown. */
interface NodeVis {
  id: NodeId;
  particle: Particle;
  baseScale: number;
  glyphSpec: { text: string; color: number; size: number } | null;
  glyph: Text | null;
  boxed: boolean;
  pill: Graphics | null;
}

interface Anim {
  id: NodeId;
  vis: NodeVis;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromA: number;
  toA: number;
  fromS: number; // tween scale multiplier (the particle's actual scale is baseScale × this)
  toS: number;
  remove: boolean;
}

/** Extra rendering knobs for non-live TreeView owners such as the recorder. */
export interface TreeViewOptions {
  /** Draw settled edge styles synchronously without `performance.now`/`setTimeout`. */
  deterministicEdges?: boolean;
  /** Fixed theme mode for recorder-owned views; omitted views follow the live theme. */
  themeMode?: Mode;
  /** Use Color-4096 combinator hues under `themeMode`. */
  color?: boolean;
}

/**
 * Renders one connected term tree into a draggable Pixi container (§5.3). Nodes
 * are drawn as a single instanced {@link ParticleContainer} (one particle per
 * node, tinted/scaled by kind) keyed by id, so a reduction step can tween: nodes
 * that persist glide to their new position, fresh nodes grow in, dropped nodes
 * fade out (§6.3). Text glyphs are a separate layer, dropped past {@link
 * GLYPH_MAX} nodes (LOD) — so a thousand-node tree stays one batched draw call.
 */
export class TreeView {
  readonly container = new Container();
  private readonly edges = new Graphics();
  private readonly rootMark = new Graphics(); // halo on the root (snap anchor)
  private readonly sharedMarks = new Graphics(); // red halos on graph-shared nodes (ink = root)
  // All node discs in one GPU-instanced batch; glyphs in a thin layer on top.
  // Only position (movement) + color (tint + alpha fades) change per frame;
  // vertices/uvs/rotation stay static (no per-dot scale/rotation animation — the
  // grow-in is the Text glyph scaling + the dot alpha-fading). `scale` isn't a real
  // Pixi v8 particle property, so it was a no-op before.
  private readonly particles = new ParticleContainer({ dynamicProperties: { position: true, color: true } });
  // Per-node pill backgrounds for boxed (long-named) comb nodes — plain Graphics, not instanced (rare
  // enough that a shared/instanced batch isn't worth the complexity; see makePill). Sits above the
  // particle batch (whose disc a boxed node hides) and below the glyphs.
  private readonly pills = new Container();
  private readonly glyphs = new Container();
  node: Node; // the logical term (used for reduction)
  /** Source expression this term was compiled from (e.g. `qs [3, 1, 2]`), for the recorder
   *  title. Provenance — survives reduction morphs; cleared on a user structural edit. */
  sourceTitle?: string;
  private display: Node; // node with undiscovered S/K/I expanded to their ι-trees
  private lay: Layout;
  // The H-tree arm scale, frozen while the tree reduces so a max-depth change doesn't rescale every node
  // (undefined for non-H-tree layouts). Re-fit on a fresh tree / layout switch / discovery.
  private frozenL0: number | undefined;
  private readonly objs = new Map<NodeId, NodeVis>();
  // Recycled particle pool. Pixi's ParticleContainer.removeParticle is O(n) (indexOf + splice), which
  // is death on the incremental path (many small removals over a big tree). So a removed node's
  // particle is parked (alpha 0, off-screen) and reused for the next fresh node — removal is O(1) and
  // the batch never shrinks below its high-water mark. Cleared whenever the container is bulk-reset.
  private readonly recycled: Particle[] = [];
  // Parent→child edges with the resolved NodeVis of each endpoint cached at index
  // time, so the per-frame edge draw is pure array iteration — no `objs` Map lookups
  // (3 per edge per frame on the animation hot path).
  private edgeList: Array<{ pv: NodeVis; lv: NodeVis; rv: NodeVis; depth: number }> = [];
  private sharedMarkKinds: Map<NodeId, Node["kind"]> | null = null;

  private anims: Anim[] = [];
  private elapsed = 0;
  private duration = 0;
  private onDone: (() => void) | null = null;
  private lastEdgeDrawAt = 0; // perf clock of the last drawEdges — distinguishes a rapid reduction redraw from a settled one
  private settleDashTimer = 0; // one-shot: dash a big tree's edges once it stops being redrawn (settled)
  private ticking = false;
  private cancelPop: (() => void) | null = null; // the pop-in tween's canceller — stopped on destroy so it can't tick a freed container
  private readonly tick = (t: Ticker): void => this.advance(t.deltaMS);
  private readonly recordTheme: { mode: Mode; color: boolean; colors: Theme } | null;
  // The glyph resolution level (see glyphResLevel) currently baked into every live glyph's bitmap.
  // Checked every frame — cheap (one comparison) — but only re-rasterizes glyphs on the rare frame
  // the quantized level actually changes, so a pan/zoom on an otherwise-settled tree still sharpens
  // its text without a per-frame reflow.
  private glyphRes = 1;
  private readonly syncGlyphRes = (): void => {
    const cam = this.getCamera?.();
    if (!cam) return;
    const level = glyphResLevel(cam.scale);
    if (level === this.glyphRes) return;
    this.glyphRes = level;
    for (const vis of this.objs.values()) if (vis.glyph) vis.glyph.resolution = level;
  };
  // Heavy incremental H-tree renderer (deeper-perf, ADR 18): resident edge geometry + an O(changed)
  // applyPatch. Active only for a big H-tree tree reducing on the raw/optimize path; small trees, non-H
  // layouts, graph/DAG, and any display-expansion change stay on the Graphics animateTo path.
  private edgeBuffer: EdgeBuffer | null = null;
  private incMode = false;

  constructor(
    node: Node,
    worldX: number,
    worldY: number,
    private readonly ticker: Ticker,
    /** Whether a combinator symbol has been discovered yet — undiscovered S/K/I
     * are rendered as their full ι-tree, not their letter, until discovered. */
    private readonly isDiscovered: (sym: string) => boolean,
    private layoutFn: LayoutFn,
    /** "Expand" view: render *every* combinator as its full ι-tree, not its name. */
    private readonly expandAll: () => boolean = () => false,
    /** The camera (world container) transform, so edges can be viewport-culled
     *  while animating a huge tree. Null → no culling (all edges drawn). */
    private readonly getCamera: (() => { x: number; y: number; scale: number }) | null = null,
    /** Resolve a comb node's DISPLAYED glyph text (ADR 23) — defaults to the raw sym. `n.sym` stays
     *  the semantic identifier everywhere else (edges, tint, hit-testing); only the glyph text (and,
     *  transitively, the pill/circle sizing) follows this. Call {@link refresh} after it would return
     *  a different answer (e.g. the hotbar's open page changed) to re-render with the new labels. */
    private readonly labelFor: (sym: string) => string = (sym) => sym,
    private readonly options: TreeViewOptions = {},
  ) {
    this.recordTheme = options.themeMode ? { mode: options.themeMode, color: !!options.color, colors: themeForMode(options.themeMode, !!options.color) } : null;
    this.node = node;
    this.display = this.expand(node);
    this.lay = this.layoutFn(this.display);
    this.frozenL0 = this.lay.l0; // (re-)fit the H-tree arm scale
    this.glyphRes = glyphResLevel(this.getCamera?.().scale ?? 1);
    this.particles.eventMode = "none";
    this.pills.eventMode = "none";
    this.glyphs.eventMode = "none";
    this.sharedMarks.eventMode = "none";
    this.container.addChild(this.edges, this.rootMark, this.sharedMarks, this.particles, this.pills, this.glyphs);
    this.container.position.set(worldX, worldY);
    this.container.eventMode = "static";
    this.container.cursor = "grab";
    this.rebuild();
    liveViews.add(this);
    this.ticker.add(this.syncGlyphRes);
  }

  get rootWorld(): { x: number; y: number } {
    // The ROOT NODE's world position (snap anchor, fn/arg ordering). Not the container origin:
    // after a floating-origin {@link rebase} the root's local position is no longer (0,0).
    return this.layoutRootWorld;
  }

  /** The current layout root position, in the same world-container coordinates as {@link worldBounds}. */
  get layoutRootWorld(): { x: number; y: number } {
    const p = this.lay.pos.get(this.display.id);
    return { x: this.container.position.x + (p?.x ?? 0), y: this.container.position.y + (p?.y ?? 0) };
  }

  /** The tree's world-space bounding box (from the layout — animation-independent), for
   *  zoom-to-fit. */
  worldBounds(): { x: number; y: number; w: number; h: number } {
    return { x: this.container.position.x + this.lay.minX, y: this.container.position.y + this.lay.minY, w: this.lay.width, h: this.lay.height };
  }

  /** Node count of the currently displayed (expansion-applied) tree — the layout
   *  positions every node exactly once, so this equals `countNodes(displayTerm)`
   *  without re-expanding. Lets the recorder read the stat straight off the tree. */
  nodeCount(): number {
    return this.lay.pos.size;
  }

  /** Cumulative local-origin shift (floating origin, deep zoom). Pristine layouts put the root at
   *  (0,0); {@link rebase} offsets the local frame, so every FRESH layout result is re-expressed in
   *  the current frame via {@link shiftLay} before use. */
  private readonly originShift = { x: 0, y: 0 };

  /** Express a freshly-computed layout in the current (possibly rebased) local frame. In place. */
  private shiftLay(lay: Layout): Layout {
    const { x, y } = this.originShift;
    if (x === 0 && y === 0) return lay;
    for (const p of lay.pos.values()) {
      p.x -= x;
      p.y -= y;
    }
    lay.minX -= x;
    lay.maxX -= x;
    lay.minY -= y;
    lay.maxY -= y;
    return lay;
  }

  /** Floating origin (deep zoom): move the local origin to the local point (px,py) — every local
   *  coordinate shrinks by the pivot while the container advances by it, so world positions are
   *  unchanged but the float32 magnitudes the GPU sees near the viewport stay small (uploaded
   *  matrices/vertices jitter past ~1e7 px). O(nodes) — the shell calls this on threshold
   *  crossings only (see the camera.onChange hook in app.ts). */
  rebase(px: number, py: number): void {
    if (px === 0 && py === 0) return;
    this.originShift.x += px;
    this.originShift.y += py;
    for (const vis of this.objs.values()) {
      vis.particle.x -= px;
      vis.particle.y -= py;
      if (vis.glyph) vis.glyph.position.set(vis.glyph.position.x - px, vis.glyph.position.y - py);
      if (vis.pill) vis.pill.position.set(vis.pill.position.x - px, vis.pill.position.y - py);
    }
    for (const p of this.lay.pos.values()) {
      p.x -= px;
      p.y -= py;
    }
    this.lay.minX -= px;
    this.lay.maxX -= px;
    this.lay.minY -= py;
    this.lay.maxY -= py;
    for (const a of this.anims) {
      a.fromX -= px;
      a.toX -= px;
      a.fromY -= py;
      a.toY -= py;
    }
    this.container.position.set(this.container.position.x + px, this.container.position.y + py);
    if (this.incMode && this.edgeBuffer) {
      this.rebuildEdgeBuffer(); // the retained buffer stores absolute locals — reload in the new frame
      this.edgeBuffer.commit();
      this.placeRootMark();
      this.placeSharedMarks();
    } else {
      this.drawEdges(); // redraws from the (shifted) live particles, incl. the root/shared marks
    }
    this.updateHitArea();
  }

  private colors(): Theme {
    return this.recordTheme?.colors ?? theme;
  }

  private edgeTierColor(depth: number): number {
    return this.recordTheme ? edgeTierColorForMode(depth, this.recordTheme.mode, this.recordTheme.colors) : edgeTierColor(depth);
  }

  destroy(): void {
    this.cancelPop?.(); // a pop-in tween could still be mid-flight (rapid game-mode spawn→apply)
    this.cancelPop = null;
    clearTimeout(this.settleDashTimer); // a pending settle-dash redraw must not touch a freed container
    this.stopTicker();
    this.ticker.remove(this.syncGlyphRes);
    liveViews.delete(this);
    this.edgeBuffer?.destroy();
    this.container.destroy({ children: true });
  }

  /** Rebuild the display — call after a discovery so newly-known combinators
   * reveal their symbol (and stop being shown as their ι-tree). */
  refresh(): void {
    this.exitIncremental(); // display expansion may change (discovery / Expand toggle) → full recompute
    if (this.ticking) this.finish();
    this.display = this.expand(this.node);
    this.lay = this.shiftLay(this.layoutFn(this.display));
    this.frozenL0 = this.lay.l0; // (re-)fit the H-tree arm scale
    this.rebuild();
  }

  /** Switch the layout algorithm, animating every node to its new position. */
  setLayout(fn: LayoutFn): void {
    this.exitIncremental(); // a layout switch re-fits everything → back to the Graphics path
    this.layoutFn = fn;
    this.onDone = null;
    this.finish();
    const newLay = this.shiftLay(fn(this.display));
    this.frozenL0 = newLay.l0; // layout switch → re-fit the arm scale
    this.anims = [];
    for (const [id, vis] of this.objs) {
      const target = newLay.pos.get(id)!;
      this.anims.push(mkAnim(id, vis, vis.particle.x, vis.particle.y, target.x, target.y, 1, 1, 1, 1));
    }
    this.lay = newLay;
    this.indexEdges(); // an incremental reduction may have changed the topology without touching edgeList — rebuild for the Graphics path
    this.updateHitArea();
    this.elapsed = 0;
    this.duration = LAYOUT_MS;
    this.onDone = () => {};
    this.drawEdges();
    this.startTicker();
  }

  /** The id of the node nearest a global point (within a small radius), for
   * picking a node to act on (e.g. right-click delete). Null if none is close. */
  pickNode(global: { x: number; y: number }): NodeId | null {
    const p = this.container.toLocal(global);
    let best: NodeId | null = null;
    let bestDist = Infinity;
    for (const [id, vis] of this.objs) {
      const dx = vis.particle.x - p.x;
      const dy = vis.particle.y - p.y;
      const d = dx * dx + dy * dy;
      // Hit disc shrinks with the node (the H-tree scales deep nodes with their arm), floored so
      // a deep tip stays pickable once zoomed in — without the shrink, a click near a deep
      // spiral's center would grab a near-invisible node over the visible one beside it.
      const r = 26 * Math.max(0.3, this.lay.scale?.get(id) ?? 1);
      if (d < r * r && d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    if (best === null) return null;
    // expansion nodes have negative ids derived from their source comb — map a
    // pick inside an expanded ι-tree back to that combinator in the logical term.
    return best < 0 ? Math.floor((-best - 1) / IOTA_ID_SPAN) : best;
  }

  /** Each node's current position in world-container coordinates (tree anchor +
   * local offset). Used to animate a merge continuously from the source trees. */
  nodeWorldPositions(): Map<NodeId, { x: number; y: number }> {
    const base = this.container.position;
    const m = new Map<NodeId, { x: number; y: number }>();
    for (const [id, vis] of this.objs) m.set(id, { x: base.x + vis.particle.x, y: base.y + vis.particle.y });
    return m;
  }

  /** Dim every node NOT in `keep` (its disc + glyph) to `alpha`, leaving the kept nodes bright — used
   *  by the build preview to gray only the newly-attached part while the already-placed tree stays at
   *  full opacity. The preview tree is static (not animating) so this override sticks. */
  dimExcept(keep: Set<NodeId>, alpha: number): void {
    for (const [id, vis] of this.objs) {
      const a = keep.has(id) ? 1 : alpha;
      vis.particle.alpha = vis.pill ? 0 : a; // a boxed node's disc stays hidden — the pill carries the dim
      if (vis.glyph) vis.glyph.alpha = a;
      if (vis.pill) vis.pill.alpha = a;
    }
  }

  /** Animate this freshly-built tree into place from the source trees' node
   * positions (§6.2): shared subtrees glide from where they were, the new
   * application node grows in. Coordinates are world-container space. */
  animateAttachFrom(fromWorld: Map<NodeId, { x: number; y: number }>, duration: number): void {
    this.exitIncremental();
    this.onDone = null;
    this.finish();
    const base = this.container.position;
    this.anims = [];
    for (const [id, vis] of this.objs) {
      const target = this.lay.pos.get(id)!;
      const fw = fromWorld.get(id);
      if (fw) {
        const sx = fw.x - base.x;
        const sy = fw.y - base.y;
        this.place(vis, sx, sy, 1, 1);
        this.anims.push(mkAnim(id, vis, sx, sy, target.x, target.y, 1, 1, 1, 1));
      } else {
        this.place(vis, target.x, target.y, 0, 0.3);
        this.anims.push(mkAnim(id, vis, target.x, target.y, target.x, target.y, 0, 1, 0.3, 1));
      }
    }
    this.elapsed = 0;
    this.duration = duration;
    this.onDone = () => {};
    this.drawEdges();
    this.startTicker();
  }

  /** Animate a one-step reduction to `node`; `onDone` fires on natural finish.
   *  Persisting nodes glide, fresh nodes grow in, dropped nodes fade out. */
  animateTo(node: Node, duration: number, onDone: () => void): void {
    this.exitIncremental(); // full recompute — resyncs from any partial incremental state, back to Graphics
    this.onDone = null;
    this.finish(); // settle any prior tween (without firing its callback)

    const from = new Map<NodeId, { x: number; y: number }>();
    for (const [id, vis] of this.objs) from.set(id, { x: vis.particle.x, y: vis.particle.y });

    const newDisplay = this.expand(node);
    const newLay = this.shiftLay(this.layoutFn(newDisplay, { l0: this.frozenL0 })); // freeze the H-tree arm scale across the step
    const newNodes = collectNodes(newDisplay);
    this.anims = [];

    // entering + persisting nodes
    for (const [id, n] of newNodes) {
      const target = newLay.pos.get(id)!;
      const existing = this.objs.get(id);
      if (existing) {
        const f = from.get(id)!;
        // Diff: a persisting node whose position is unchanged is already placed — skip its anim so a
        // step only touches the nodes that MOVED (a huge term keeps ~93% of its nodes put per step,
        // so this avoids re-placing + re-uploading ~13k unchanged particles every contraction).
        if (f.x !== target.x || f.y !== target.y) this.anims.push(mkAnim(id, existing, f.x, f.y, target.x, target.y, 1, 1, 1, 1));
      } else {
        const vis = this.makeVis(n);
        this.place(vis, target.x, target.y, 0, 0.3);
        this.objs.set(id, vis);
        this.anims.push(mkAnim(id, vis, target.x, target.y, target.x, target.y, 0, 1, 0.3, 1));
      }
    }
    // leaving nodes
    for (const [id, vis] of this.objs) {
      if (!newNodes.has(id)) {
        this.anims.push(mkAnim(id, vis, vis.particle.x, vis.particle.y, vis.particle.x, vis.particle.y, vis.particle.alpha, 0, 1, 0.4, true));
      }
    }

    this.node = node;
    this.display = newDisplay;
    this.indexEdges();
    this.lay = newLay;
    this.applyGlyphLOD();
    this.updateHitArea();
    this.elapsed = 0;
    this.duration = duration;
    this.onDone = onDone;
    if (newNodes.size > HEAVY) {
      this.finish(); // big tree: jump-cut to the settled state — no per-frame tween/edge redraw
    } else {
      this.drawEdges();
      this.startTicker();
    }
  }

  /** Big enough that we jump-cut steps (skip per-step animation)? Lets the shell
   *  run fac-scale playback without paying ~6 tween frames per step. */
  heavy(): boolean {
    return this.objs.size > HEAVY;
  }

  /** Pop the whole tree in — a quick scale-up of the container around its anchor.
   *  The grab/spawn pop; gated by the caller (withMotion). */
  popIn(): void {
    const c = this.container;
    c.scale.set(0.55);
    this.cancelPop?.(); // a prior pop-in could still be running (re-spawn) — drop it first
    this.cancelPop = tween(this.ticker, 240, (e) => {
      if (c.destroyed) return; // destroyed mid-pop — the canceller usually beats this, but guard anyway
      c.scale.set(0.55 + 0.45 * e);
    });
  }

  /** Cancel a running tween, snapping to its settled state (no `onDone`). */
  stopAnimation(): void {
    this.onDone = null;
    this.finish();
  }

  // ---- Heavy incremental H-tree path (deeper-perf, ADR 18) ----

  /** Eligible for the O(changed) incremental path? True only for a big H-tree tree (`l0`/`depth`
   *  set) drawn as a plain tree — small trees and non-H layouts stay on {@link animateTo}; the
   *  controller additionally withholds it in graph/DAG mode (sharing conflicts with path-local
   *  layout). */
  canIncremental(): boolean {
    return this.lay.l0 !== undefined && this.objs.size >= INCR_MIN;
  }

  /** Enter incremental mode, loading the resident edge buffer from the current tree (O(n), once).
   *  No-op if already in it; returns false (staying on the Graphics path) if the tree isn't eligible.
   *  The caller then batches {@link applyPatch} calls and finishes with {@link commitIncremental}. */
  beginIncremental(): boolean {
    if (this.incMode) return true;
    if (!this.canIncremental()) return false;
    this.finish(); // settle any tween; the incremental path jump-cuts each step (no per-frame tween)
    if (!this.edgeBuffer) {
      this.edgeBuffer = new EdgeBuffer();
      this.container.addChildAt(this.edgeBuffer.container, 1); // above the Graphics edges (idx 0), under the nodes
    }
    this.edgeBuffer.refreshTheme();
    this.edges.clear();
    this.edges.visible = false;
    this.edgeBuffer.container.visible = true;
    this.rebuildEdgeBuffer();
    this.incMode = true;
    return true;
  }

  /**
   * Apply one reduction step incrementally: re-place ONLY the replacement subtree from its unchanged
   * anchor + depth, move only the particles that actually moved, and remove/upsert only the incident
   * edges — O(changed), not O(n). Must be inside {@link beginIncremental}; the caller batches several
   * per frame then calls {@link commitIncremental} once. Returns false on a stale cache so the caller
   * can fall back to a full {@link animateTo}.
   */
  applyPatch(patch: StepPatch): boolean {
    if (!this.incMode) return false;
    const l0 = this.frozenL0;
    if (l0 === undefined) return false;
    const oldDisp = this.expand(patch.oldRedex);
    const anchor = this.lay.pos.get(oldDisp.id);
    if (!anchor) return false; // cache miss → let the caller do a full recompute
    const newDisp = this.expand(patch.replacement);
    const anchorDepth = patch.path.length;
    const sub = layoutHTreeSubtree(newDisp, anchor.x, anchor.y, anchorDepth, l0);

    const oldNodes = collectNodes(oldDisp);
    const newNodes = collectNodes(newDisp);
    const pos = this.lay.pos;
    const scale = this.lay.scale!;
    const eb = this.edgeBuffer!;

    // Removed display nodes (in old, gone in new): drop the particle, cache entry, and incident edges.
    for (const [id, n] of oldNodes) {
      if (newNodes.has(id)) continue;
      const vis = this.objs.get(id);
      if (vis) {
        this.objs.delete(id);
        this.recycle(vis);
      }
      pos.delete(id);
      scale.delete(id);
      if (n.kind === "app") {
        eb.remove(edgeKey(id, 0));
        eb.remove(edgeKey(id, 1));
      }
    }
    // New + moved display nodes: refresh the cache and jump-cut the particle to its final place.
    for (const [id, n] of newNodes) {
      const p = sub.pos.get(id)!;
      pos.set(id, p);
      scale.set(id, sub.scale.get(id) ?? 1);
      let vis = this.objs.get(id);
      if (!vis) {
        vis = this.makeVis(n);
        this.objs.set(id, vis);
      }
      this.place(vis, p.x, p.y, 1, 1); // place() reads the scale we just set
      this.extendBounds(p.x, p.y);
    }
    // Upsert the edges of every app node in the new subtree — covers fresh structure AND
    // moved-but-preserved subtrees (whose ids persist but whose positions/tier changed). Tint an app
    // child by its incoming tier, matching indexEdges.
    for (const [id, n] of newNodes) {
      if (n.kind !== "app") continue;
      const p = sub.pos.get(id)!;
      const d = sub.depth.get(id)!;
      const tier = (d % 2) as 0 | 1;
      const fp = pos.get(n.fn.id)!;
      const ap = pos.get(n.arg.id)!;
      eb.set(edgeKey(id, 0), tier, p.x, p.y, fp.x, fp.y);
      eb.set(edgeKey(id, 1), tier, p.x, p.y, ap.x, ap.y);
      const childTint = this.edgeTierColor(d);
      if (n.fn.kind === "app") this.objs.get(n.fn.id)!.particle.tint = childTint;
      if (n.arg.kind === "app") this.objs.get(n.arg.id)!.particle.tint = childTint;
    }
    // The subtree root's own tint follows its incoming (unchanged spine) edge; the whole-tree root has
    // none, so it stays ink. Splice the new subtree into `display` along the (app-only) path so it
    // stays a valid tree for the root mark / picking — O(path), not O(n).
    if (patch.path.length === 0) {
      const rv = this.objs.get(newDisp.id);
      if (rv) rv.particle.tint = this.colors().text;
    } else if (newDisp.kind === "app") {
      const rv = this.objs.get(newDisp.id);
      if (rv) rv.particle.tint = this.edgeTierColor(anchorDepth);
    }
    this.display = spliceDisplay(this.display, patch.path, newDisp);
    this.node = patch.root;
    return true;
  }

  /** DEV/test seam: does the incrementally-maintained layout match a full recompute of the current
   *  term? All zero ⇒ the O(changed) path landed every node exactly where a full relayout would. */
  debugLayoutParity(): { total: number; mismatched: number; missing: number; extra: number } {
    const full = this.shiftLay(this.layoutFn(this.expand(this.node), { l0: this.frozenL0 }));
    let mismatched = 0;
    let missing = 0;
    for (const [id, p] of full.pos) {
      const cur = this.lay.pos.get(id);
      if (!cur) missing++;
      else if (Math.abs(cur.x - p.x) > 0.01 || Math.abs(cur.y - p.y) > 0.01) mismatched++;
    }
    let extra = 0;
    for (const id of this.objs.keys()) if (!full.pos.has(id)) extra++;
    return { total: full.pos.size, mismatched, missing, extra };
  }

  /** Flush a batch of {@link applyPatch} calls: upload the changed edge slots and resync the root mark
   *  + hit area (bounds grew incrementally as patches landed; an exact refit waits for the next full
   *  relayout / settle). */
  commitIncremental(): void {
    if (!this.incMode || !this.edgeBuffer) return;
    this.edgeBuffer.commit();
    this.updateHitArea();
    this.placeRootMark();
  }

  /** Leave incremental mode: hide the edge buffer and hand rendering back to the Graphics path (which
   *  the following full recompute repaints). Called by every full-recompute entry point. */
  private exitIncremental(): void {
    if (!this.incMode) return;
    this.incMode = false;
    this.edges.visible = true;
    if (this.edgeBuffer) this.edgeBuffer.container.visible = false;
  }

  // One O(n) load of the resident edge buffer from the current display topology — on entering
  // incremental mode. Reuses the cached edgeList (endpoints + tier depth) so it is a single pass.
  private rebuildEdgeBuffer(): void {
    const eb = this.edgeBuffer!;
    eb.clear();
    for (const e of this.edgeList) {
      const tier = (e.depth % 2) as 0 | 1;
      const p = e.pv.particle;
      const l = e.lv.particle;
      const r = e.rv.particle;
      eb.set(edgeKey(e.pv.id, 0), tier, p.x, p.y, l.x, l.y);
      eb.set(edgeKey(e.pv.id, 1), tier, p.x, p.y, r.x, r.y);
    }
    eb.commit();
  }

  // Grow the cached layout bounds to include a point (incremental reflow only ever adds points; an
  // exact refit — which also shrinks — happens on the next full relayout).
  private extendBounds(x: number, y: number): void {
    const l = this.lay;
    if (x < l.minX) l.minX = x;
    if (x > l.maxX) l.maxX = x;
    if (y < l.minY) l.minY = y;
    if (y > l.maxY) l.maxY = y;
    l.width = l.maxX - l.minX;
    l.height = l.maxY - l.minY;
  }

  private advance(deltaMS: number): void {
    this.elapsed += deltaMS;
    const t = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1;
    const e = easeInOut(t);
    for (const a of this.anims) {
      const x = a.fromX + (a.toX - a.fromX) * e;
      const y = a.fromY + (a.toY - a.fromY) * e;
      const al = a.fromA + (a.toA - a.fromA) * e;
      const s = a.fromS + (a.toS - a.fromS) * e;
      this.place(a.vis, x, y, al, s);
    }
    this.drawEdges();
    if (t >= 1) this.finish();
  }

  private finish(): void {
    if (!this.ticking && this.anims.length === 0) return;
    for (const a of this.anims) {
      if (a.remove) {
        this.objs.delete(a.id);
        this.recycle(a.vis);
      } else {
        this.place(a.vis, a.toX, a.toY, a.toA, a.toS);
      }
    }
    this.anims = [];
    this.stopTicker();
    this.drawEdges();
    this.updateHitArea();
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  /** Write a node's transform onto its particle (disc), glyph, and (if boxed) pill: position, alpha,
   *  the tween scale `s`, and the layout's optional per-node glyph-scale (H-tree shrinks deep nodes
   *  toward their arm). Disc & glyph both scale by `s × nodeScale`. A boxed node's particle disc stays
   *  fully transparent — its pill is the visible shape — so the two never show at once. */
  private place(vis: NodeVis, x: number, y: number, alpha: number, s: number): void {
    const p = vis.particle;
    const ns = this.lay.scale?.get(vis.id) ?? 1;
    p.x = x;
    p.y = y;
    p.alpha = vis.pill ? 0 : alpha;
    p.scaleX = p.scaleY = vis.baseScale * s * ns;
    if (vis.glyph) {
      vis.glyph.position.set(x, y);
      vis.glyph.alpha = alpha;
      vis.glyph.scale.set(s * ns);
    }
    if (vis.pill) {
      vis.pill.position.set(x, y);
      vis.pill.alpha = alpha;
      vis.pill.scale.set(s * ns);
    }
  }

  private startTicker(): void {
    if (!this.ticking) {
      this.ticker.add(this.tick);
      this.ticking = true;
    }
  }

  private stopTicker(): void {
    if (this.ticking) {
      this.ticker.remove(this.tick);
      this.ticking = false;
    }
  }

  // Expand undiscovered S/K/I into their ι-trees for display; everything else
  // (discovered combinators, ι, apps, free vars) passes through. Expansion ids
  // are derived from the source comb id (negative, so they never clash) so the
  // same combinator tweens stably across reduction steps.
  private expand(root: Node): Node {
    return expandDisplay(root, { expandAll: this.expandAll(), isDiscovered: this.isDiscovered });
  }

  private rebuild(): void {
    this.rootMarkKind = null; // force a root-halo redraw (rebuild runs on theme/display change)
    this.particles.removeParticles();
    this.recycled.length = 0; // the pool's particles were just removed from the batch — drop the stale refs
    for (const g of this.glyphs.removeChildren()) g.destroy();
    for (const g of this.pills.removeChildren()) g.destroy();
    this.objs.clear();
    for (const [id, n] of collectNodes(this.display)) {
      const vis = this.makeVis(n);
      const p = this.lay.pos.get(id)!;
      this.place(vis, p.x, p.y, 1, 1);
      this.objs.set(id, vis);
    }
    this.applyGlyphLOD();
    this.indexEdges();
    this.drawEdges();
    this.updateHitArea();
  }

  // Cache the parent→child edges of the current display topology. Called only
  // when `display` is reassigned (rebuild / animateTo); setLayout and
  // animateAttachFrom keep the same display, so the cache stays valid there.
  private indexEdges(): void {
    this.edgeList = [];
    this.sharedMarkKinds = null;
    this.sharedMarks.clear();
    // Walk each app node once (by id). A shared child (graph mode) is reached from
    // several parents, so it gets several incoming edges but is walked once — the
    // edges converge on its single particle. On a tree no id repeats, so this is
    // identical to the old per-app walk.
    const seen = new Set<NodeId>();
    const incoming = new Set<NodeId>();
    const noteIncoming = (n: Node): void => {
      if (incoming.has(n.id)) (this.sharedMarkKinds ??= new Map()).set(n.id, n.kind);
      else incoming.add(n.id);
    };
    const walk = (n: Node, depth: number): void => {
      if (n.kind !== "app" || seen.has(n.id)) return;
      seen.add(n.id);
      noteIncoming(n.fn);
      noteIncoming(n.arg);
      // All endpoints are in `objs` by now (rebuild/animateTo populate it before
      // indexing); skip the rare edge whose vis is somehow missing.
      const pv = this.objs.get(n.id);
      const lv = this.objs.get(n.fn.id);
      const rv = this.objs.get(n.arg.id);
      if (pv && lv && rv) {
        this.edgeList.push({ pv, lv, rv, depth }); // depth → the red/black tier color
        // an app child takes the color of its incoming edge (the tier edge leaving n at this depth)
        const tier = this.edgeTierColor(depth);
        if (n.fn.kind === "app") lv.particle.tint = tier;
        if (n.arg.kind === "app") rv.particle.tint = tier;
      }
      walk(n.fn, depth + 1);
      walk(n.arg, depth + 1);
    };
    walk(this.display, 0);
    // depth-sorted so drawEdges can stroke one contiguous width/color batch per depth run
    this.edgeList.sort((a, b) => a.depth - b.depth);
    const rootVis = this.display.kind === "app" ? this.objs.get(this.display.id) : null;
    if (rootVis) rootVis.particle.tint = this.colors().text; // root: no incoming edge → ink
  }

  // Edges are drawn from the live particle positions (so they follow tweens),
  // with function (left) edges and argument (right) edges in two distinct
  // strokes. Iterates the cached edge list (no per-frame tree walk). While
  // animating a huge tree, edges whose bounding box is off-screen are culled —
  // bounding per-frame geometry to what's visible (see viewRect).
  private drawEdges(): void {
    this.edges.clear();
    const v = this.viewRect();
    // LOD: skip edges shorter than ~1.4px on screen. A huge tree framed to fit zooms so far out that its
    // deep (geometrically shrinking) arms are sub-pixel — drawing thousands of invisible segments is the
    // dominant per-step cost. `minLen2` is the squared local length threshold at the current zoom; 0 (no
    // camera) draws everything.
    const cam = this.getCamera?.();
    const minLen2 = cam ? (1.4 / (cam.scale || 1)) ** 2 : 0;
    // Style = fn solid, arg dashed. Small trees always dash. A big tree draws SOLID
    // while it's being redrawn rapidly (a running reduction jump-cuts a step every few ms — dashing
    // thousands of edges per step is slow) and DASHED once it settles: this draw follows a quiet gap,
    // or the trailing timer below fired after one. So an expanded / inspected ι-tree shows its dashes.
    let dash = true;
    if (!this.options.deterministicEdges) {
      const now = performance.now();
      const settled = now - this.lastEdgeDrawAt > SETTLE_DASH_MS;
      this.lastEdgeDrawAt = now;
      dash = this.objs.size <= HEAVY || settled;
    }
    // Color = depth TIER (red/black), style = fn solid / arg dashed. A node's parent-edge is the
    // opposite color of its child-edges → you can trace direction even in a dense tree.
    if (!this.lay.scale) {
      // No per-node scale (top-down/radial): the classic 4 strokes, {arg,fn} × {even,odd}.
      for (const parity of [0, 1]) {
        for (const e of this.edgeList) {
          if (e.depth % 2 !== parity) continue;
          const p = e.pv.particle;
          const rp = e.rv.particle;
          const adx = p.x - rp.x, ady = p.y - rp.y;
          if (adx * adx + ady * ady < minLen2) continue; // LOD: sub-pixel edge
          if (!v || overlaps(p, rp, v)) {
            if (dash) dashedSegment(this.edges, p.x, p.y, rp.x, rp.y); // argument edge: dashed
            else this.edges.moveTo(p.x, p.y).lineTo(rp.x, rp.y);
          }
        }
        this.edges.stroke({ width: 2.5, color: this.edgeTierColor(parity) });
      }
      for (const parity of [0, 1]) {
        for (const e of this.edgeList) {
          if (e.depth % 2 !== parity) continue;
          const p = e.pv.particle;
          const lp = e.lv.particle;
          const fdx = p.x - lp.x, fdy = p.y - lp.y;
          if (fdx * fdx + fdy * fdy < minLen2) continue; // LOD: sub-pixel edge
          if (!v || overlaps(p, lp, v)) this.edges.moveTo(p.x, p.y).lineTo(lp.x, lp.y); // function edge: solid
        }
        this.edges.stroke({ width: 3, color: this.edgeTierColor(parity) });
      }
    } else {
      // H-tree: edge width (and the dash pattern) follows the parent's node scale — the edge IS the
      // parent's arm, so lines thin out exactly like the nodes and distances do and a deep spiral
      // fades instead of inking a blob. edgeList is depth-sorted (indexEdges), so each {style,depth}
      // batch is one contiguous run and one stroke.
      for (const pass of [0, 1]) {
        let runDepth = -1;
        let runF = 1;
        let drew = false;
        const flush = (): void => {
          if (drew) this.edges.stroke({ width: (pass === 0 ? 2.5 : 3) * runF, color: this.edgeTierColor(runDepth) });
          drew = false;
        };
        for (const e of this.edgeList) {
          if (e.depth !== runDepth) {
            flush();
            runDepth = e.depth;
            runF = this.lay.scale.get(e.pv.id) ?? 1;
          }
          const p = e.pv.particle;
          const c = pass === 0 ? e.rv.particle : e.lv.particle;
          const dx = p.x - c.x, dy = p.y - c.y;
          if (dx * dx + dy * dy < minLen2) continue; // LOD: sub-pixel edge
          if (v && !overlaps(p, c, v)) continue;
          if (pass === 0 && dash) dashedSegment(this.edges, p.x, p.y, c.x, c.y, 8 * runF, 6 * runF); // argument edge: dashed
          else this.edges.moveTo(p.x, p.y).lineTo(c.x, c.y); // function edge (or rapid-redraw arg): solid
          drew = true;
        }
        flush();
      }
    }
    this.placeRootMark();
    this.placeSharedMarks();
    // Drew a big tree solid because it's being redrawn rapidly (still reducing) → schedule a one-shot
    // dashed redraw for once it goes idle. A later draw (next step) cancels and reschedules it.
    if (this.objs.size > HEAVY && !dash && !this.options.deterministicEdges) {
      clearTimeout(this.settleDashTimer);
      this.settleDashTimer = window.setTimeout(() => {
        if (!this.container.destroyed) this.drawEdges();
      }, SETTLE_DASH_MS + 20);
    }
  }

  // The visible viewport in this tree's local coordinates — but only while
  // animating (when drawEdges runs every frame): a settled tree draws all its
  // edges so panning/zooming reveals them without a redraw. Null → no cull.
  private viewRect(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (!this.ticking || !this.getCamera) return null;
    const cam = this.getCamera();
    const s = cam.scale || 1;
    const cx = this.container.position.x;
    const cy = this.container.position.y;
    const margin = 100 / s; // keep a little slack so edges near the edge aren't clipped early
    return {
      minX: (0 - cam.x) / s - cx - margin,
      maxX: (window.innerWidth - cam.x) / s - cx + margin,
      minY: (0 - cam.y) / s - cy - margin,
      maxY: (window.innerHeight - cam.y) / s - cy + margin,
    };
  }

  private updateHitArea(): void {
    const pad = 22;
    this.container.hitArea = new Rectangle(
      this.lay.minX - pad,
      this.lay.minY - pad,
      this.lay.width + 2 * pad,
      this.lay.height + 2 * pad,
    );
  }

  // Build the render record for one node: an instanced disc particle (added to
  // the batch) plus the glyph spec for the LOD layer. The display term only ever
  // contains discovered combinators (undiscovered S/K/I are expanded to ι-trees).
  private makeVis(n: Node): NodeVis {
    const spec = visSpec(n, this.labelFor, this.recordTheme);
    const particle = this.recycled.pop() ?? this.addParticle();
    particle.tint = spec.tint;
    particle.alpha = 1;
    return { id: n.id, particle, baseScale: spec.radius / TEX_R, glyphSpec: spec.glyph, glyph: null, boxed: spec.boxed, pill: null };
  }

  // A fresh particle added to the instanced batch (all share the one disc texture + center anchor).
  private addParticle(): Particle {
    const particle = new Particle({ texture: nodeTexture(), anchorX: 0.5, anchorY: 0.5 });
    this.particles.addParticle(particle);
    return particle;
  }

  // Retire a node's render record: destroy its glyph + pill and park its particle (invisible,
  // off-screen) in the recycle pool for reuse — never the O(n) removeParticle.
  private recycle(vis: NodeVis): void {
    vis.glyph?.destroy();
    vis.pill?.destroy();
    const p = vis.particle;
    p.alpha = 0;
    p.scaleX = p.scaleY = 0;
    p.x = p.y = -1e6;
    this.recycled.push(p);
  }

  // Show text glyphs only below GLYPH_MAX nodes (LOD): create the ones now needed, tear down the ones
  // we no longer want. Glyphs track their particle's transform. A boxed node additionally gets a pill
  // (its disc hidden — see place()) in lockstep with the glyph: no text to protect from clipping means
  // no need for the pill either, so past GLYPH_MAX a boxed node just falls back to a plain (LOD) dot.
  private applyGlyphLOD(): void {
    const show = this.objs.size <= GLYPH_MAX;
    for (const vis of this.objs.values()) {
      if (show && vis.glyphSpec && !vis.glyph) {
        const g = label(vis.glyphSpec.text, vis.glyphSpec.color, vis.glyphSpec.size, this.glyphRes);
        g.position.set(vis.particle.x, vis.particle.y);
        g.scale.set(vis.particle.scaleX / vis.baseScale);
        g.alpha = vis.particle.alpha;
        vis.glyph = g;
        this.glyphs.addChild(g);
        if (vis.boxed) {
          const pill = makePill(vis.glyphSpec.text, vis.particle.tint);
          pill.position.set(vis.particle.x, vis.particle.y);
          pill.scale.set(vis.particle.scaleX / vis.baseScale);
          pill.alpha = vis.particle.alpha;
          vis.pill = pill;
          this.pills.addChild(pill);
          vis.particle.alpha = 0; // the pill is now this node's visible shape
        }
      } else if (!show && vis.glyph) {
        vis.glyph.destroy();
        vis.glyph = null;
        if (vis.pill) {
          vis.pill.destroy();
          vis.pill = null;
          vis.particle.alpha = 1; // no pill left — the disc becomes visible again
        }
      }
    }
  }

  /** Halo the root (the snap anchor) with a ring so it's easy to spot — most of
   *  all the central node in the radial layout. Tracks the root node's current
   *  position (it follows during a reduction tween, and the root changes across
   *  steps). Called from drawEdges, so it stays in sync on every redraw. */
  // The root halo's circle geometry only changes when the root node's kind changes (a
  // collapse) or the theme flips — but it has to *follow* the root every frame. So draw it
  // once at the origin (redrawRootMark) and just move the Graphics per frame, instead of
  // re-tessellating + re-uploading the circle on every animation frame.
  private rootMarkKind: Node["kind"] | null = null;
  private redrawRootMark(): void {
    this.rootMark.clear();
    this.rootMark.circle(0, 0, radiusOf(this.display.kind) + 6).stroke({ width: 3, color: this.colors().root });
    this.rootMarkKind = this.display.kind;
  }
  private placeRootMark(): void {
    const vis = this.objs.get(this.display.id);
    if (!vis) return;
    if (this.rootMarkKind !== this.display.kind) this.redrawRootMark(); // root kind changed → re-tessellate once
    this.rootMark.position.set(vis.particle.x, vis.particle.y);
  }

  private placeSharedMarks(): void {
    if (!this.sharedMarkKinds) return;
    this.sharedMarks.clear();
    const color = this.colors().iota; // the tricolor red: sharing, vs the ink root halo
    for (const [id, kind] of this.sharedMarkKinds) {
      const vis = this.objs.get(id);
      if (!vis) continue;
      // Match the disc's actual rendered size: the H-tree shrinks deep nodes, so the
      // ring must scale by the same `s × nodeScale` the particle carries (baseScale
      // maps radiusOf→texel, exactly as glyphs/pills recover it) — otherwise a tiny
      // deep node gets a full-size halo. Stroke per-circle so each width scales too.
      const scale = vis.particle.scaleX / vis.baseScale;
      this.sharedMarks.circle(vis.particle.x, vis.particle.y, (radiusOf(kind) + 5) * scale).stroke({ width: 2 * scale, color });
    }
  }
}

/** Emit dashed sub-segments along a→b into the graphics path (caller strokes once).
 *  Dashing the argument edge gives function vs argument a style cue, not just a
 *  color one — the distinction survives 1-bit black-and-white. Exported so the
 *  drag-snap ghost preview can match the committed tree. */
export function dashedSegment(g: Graphics, ax: number, ay: number, bx: number, by: number, dash = 8, gap = 6): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  for (let d = 0; d < len; d += dash + gap) {
    const e = Math.min(d + dash, len);
    g.moveTo(ax + ux * d, ay + uy * d).lineTo(ax + ux * e, ay + uy * e);
  }
}

/** Does the segment a→b's bounding box overlap the view rect? (cheap edge cull) */
function overlaps(
  a: { x: number; y: number },
  b: { x: number; y: number },
  v: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  return !(Math.max(a.x, b.x) < v.minX || Math.min(a.x, b.x) > v.maxX || Math.max(a.y, b.y) < v.minY || Math.min(a.y, b.y) > v.maxY);
}

function mkAnim(
  id: NodeId,
  vis: NodeVis,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  fromA: number,
  toA: number,
  fromS: number,
  toS: number,
  remove = false,
): Anim {
  return { id, vis, fromX, fromY, toX, toY, fromA, toA, fromS, toS, remove };
}

/** Replace the subtree at `path` (`0` = fn, `1` = arg) with `sub`, rebuilding only the spine above it
 *  (which keeps its ids, so its nodes don't move). O(path) — used to keep `display` a valid tree after
 *  an incremental patch without a full O(n) re-expand. The path descends app nodes only. */
function spliceDisplay(root: Node, path: number[], sub: Node, i = 0): Node {
  if (i === path.length) return sub;
  if (root.kind !== "app") return sub; // unreachable: the path only goes through app nodes
  return path[i] === 0 ? { ...root, fn: spliceDisplay(root.fn, path, sub, i + 1) } : { ...root, arg: spliceDisplay(root.arg, path, sub, i + 1) };
}

function collectNodes(n: Node, m = new Map<NodeId, Node>()): Map<NodeId, Node> {
  if (m.has(n.id)) return m; // DAG (graph mode): one record per shared node — a no-op on a tree
  m.set(n.id, n);
  if (n.kind === "app") {
    collectNodes(n.fn, m);
    collectNodes(n.arg, m);
  }
  return m;
}

function label(text: string, color: number, size: number, resolution: number): Text {
  const t = new Text({ text, style: { fontFamily: MONO, fontSize: size, fill: color }, resolution });
  t.anchor.set(0.5);
  return t;
}

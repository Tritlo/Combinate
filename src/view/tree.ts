import { Container, Graphics, ParticleContainer, Particle, Rectangle, Text, Texture, type Ticker } from "pixi.js";
import { type Node, type NodeId, IOTA_ID_SPAN } from "../core/term";
import { expandDisplay } from "../core/catalog";
import { type Layout, type LayoutFn } from "../core/layout";
import { theme, combinatorColor, glyphOn, edgeTierColor } from "./theme";
import { tween } from "./anim";

const LAYOUT_MS = 360; // duration of the layout-toggle reflow
// Above this node count we drop the per-node text glyphs (you can't read them at
// that density anyway) and render dots only — the expensive `Text` objects are
// what cost the most. Tune to taste; the particle nodes/edges scale far past it.
const GLYPH_MAX = 300;
// Above this many displayed nodes we stop animating reduction steps: each step
// jump-cuts to its settled layout (no per-frame tween, no per-frame edge redraw)
// and argument edges drop their dashes (which multiply edge geometry). Below it,
// small trees keep the nice tween + dashed edges. Keeps fac-scale playback fast.
const HEAVY = 600;
// Radius of the shared white circle texture all node particles are drawn from; a
// node of radius r renders at scale r / TEX_R, tinted by its kind.
const TEX_R = 32;

// Node/edge colours come from the active theme (theme.ts). Edges encode two things: STYLE =
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

/** The disc radius and (optional) text glyph for each node kind. */
function visSpec(n: Node): { radius: number; tint: number; glyph: { text: string; color: number; size: number } | null } {
  switch (n.kind) {
    case "iota":
      return { radius: 7, tint: theme.iota, glyph: { text: "ι", color: theme.iotaGlyph, size: 10 } };
    case "comb": {
      const tint = combinatorColor(n.sym); // per-combinator hue in Colour mode, ink in mono
      return { radius: 15, tint, glyph: { text: n.sym, color: glyphOn(tint), size: 15 } };
    }
    case "free":
      // a free var sits on a muted (grey) dot, so its glyph is ink (text), not
      // paper — paper-on-grey is too low-contrast.
      return { radius: 13, tint: theme.mutedDot, glyph: { text: n.name, color: theme.text, size: 14 } };
    default:
      return { radius: 5, tint: theme.mutedDot, glyph: null }; // app junction dot
  }
}
const radiusOf = (kind: Node["kind"]): number => (kind === "comb" ? 15 : kind === "free" ? 13 : kind === "iota" ? 7 : 5);

/** One rendered node: an instanced particle (the disc), the scale that maps the
 *  shared texture to this kind's radius, and a lazily-created text glyph (only
 *  present below {@link GLYPH_MAX}). */
interface NodeVis {
  particle: Particle;
  baseScale: number;
  glyphSpec: { text: string; color: number; size: number } | null;
  glyph: Text | null;
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

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

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
  // All node discs in one GPU-instanced batch; glyphs in a thin layer on top.
  // Only position (movement) + colour (tint + alpha fades) change per frame;
  // vertices/uvs/rotation stay static (no per-dot scale/rotation animation — the
  // grow-in is the Text glyph scaling + the dot alpha-fading). `scale` isn't a real
  // Pixi v8 particle property, so it was a no-op before.
  private readonly particles = new ParticleContainer({ dynamicProperties: { position: true, color: true } });
  private readonly glyphs = new Container();
  node: Node; // the logical term (used for reduction)
  private display: Node; // node with undiscovered S/K/I expanded to their ι-trees
  private lay: Layout;
  private readonly objs = new Map<NodeId, NodeVis>();
  // Parent→child edges with the resolved NodeVis of each endpoint cached at index
  // time, so the per-frame edge draw is pure array iteration — no `objs` Map lookups
  // (3 per edge per frame on the animation hot path).
  private edgeList: Array<{ pv: NodeVis; lv: NodeVis; rv: NodeVis; depth: number }> = [];

  private anims: Anim[] = [];
  private elapsed = 0;
  private duration = 0;
  private onDone: (() => void) | null = null;
  private ticking = false;
  private cancelPop: (() => void) | null = null; // the pop-in tween's canceller — stopped on destroy so it can't tick a freed container
  private readonly tick = (t: Ticker): void => this.advance(t.deltaMS);

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
  ) {
    this.node = node;
    this.display = this.expand(node);
    this.lay = this.layoutFn(this.display);
    this.particles.eventMode = "none";
    this.glyphs.eventMode = "none";
    this.container.addChild(this.edges, this.rootMark, this.particles, this.glyphs);
    this.container.position.set(worldX, worldY);
    this.container.eventMode = "static";
    this.container.cursor = "grab";
    this.rebuild();
  }

  get rootWorld(): { x: number; y: number } {
    return { x: this.container.position.x, y: this.container.position.y };
  }

  /** The tree's world-space bounding box (from the layout — animation-independent), for
   *  zoom-to-fit. */
  worldBounds(): { x: number; y: number; w: number; h: number } {
    return { x: this.container.position.x + this.lay.minX, y: this.container.position.y + this.lay.minY, w: this.lay.width, h: this.lay.height };
  }

  destroy(): void {
    this.cancelPop?.(); // a pop-in tween could still be mid-flight (rapid game-mode spawn→apply)
    this.cancelPop = null;
    this.stopTicker();
    this.container.destroy({ children: true });
  }

  /** Rebuild the display — call after a discovery so newly-known combinators
   * reveal their symbol (and stop being shown as their ι-tree). */
  refresh(): void {
    if (this.ticking) this.finish();
    this.display = this.expand(this.node);
    this.lay = this.layoutFn(this.display);
    this.rebuild();
  }

  /** Switch the layout algorithm, animating every node to its new position. */
  setLayout(fn: LayoutFn): void {
    this.layoutFn = fn;
    this.onDone = null;
    this.finish();
    const newLay = fn(this.display);
    this.anims = [];
    for (const [id, vis] of this.objs) {
      const target = newLay.pos.get(id)!;
      this.anims.push(mkAnim(id, vis, vis.particle.x, vis.particle.y, target.x, target.y, 1, 1, 1, 1));
    }
    this.lay = newLay;
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
    let bestDist = 26 * 26;
    for (const [id, vis] of this.objs) {
      const dx = vis.particle.x - p.x;
      const dy = vis.particle.y - p.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
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

  /** Animate this freshly-built tree into place from the source trees' node
   * positions (§6.2): shared subtrees glide from where they were, the new
   * application node grows in. Coordinates are world-container space. */
  animateAttachFrom(fromWorld: Map<NodeId, { x: number; y: number }>, duration: number): void {
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
    this.onDone = null;
    this.finish(); // settle any prior tween (without firing its callback)

    const from = new Map<NodeId, { x: number; y: number }>();
    for (const [id, vis] of this.objs) from.set(id, { x: vis.particle.x, y: vis.particle.y });

    const newDisplay = this.expand(node);
    const newLay = this.layoutFn(newDisplay);
    const newNodes = collectNodes(newDisplay);
    this.anims = [];

    // entering + persisting nodes
    for (const [id, n] of newNodes) {
      const target = newLay.pos.get(id)!;
      const existing = this.objs.get(id);
      if (existing) {
        const f = from.get(id)!;
        this.anims.push(mkAnim(id, existing, f.x, f.y, target.x, target.y, 1, 1, 1, 1));
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
        this.particles.removeParticle(a.vis.particle);
        a.vis.glyph?.destroy();
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

  /** Write a node's transform onto its particle (disc) and glyph: position, alpha,
   *  and the tween scale `s` (the disc scales by baseScale × s; the glyph by s). */
  private place(vis: NodeVis, x: number, y: number, alpha: number, s: number): void {
    const p = vis.particle;
    p.x = x;
    p.y = y;
    p.alpha = alpha;
    p.scaleX = p.scaleY = vis.baseScale * s;
    if (vis.glyph) {
      vis.glyph.position.set(x, y);
      vis.glyph.alpha = alpha;
      vis.glyph.scale.set(s);
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
    for (const g of this.glyphs.removeChildren()) g.destroy();
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
    // Walk each app node once (by id). A shared child (graph mode) is reached from
    // several parents, so it gets several incoming edges but is walked once — the
    // edges converge on its single particle. On a tree no id repeats, so this is
    // identical to the old per-app walk.
    const seen = new Set<NodeId>();
    const walk = (n: Node, depth: number): void => {
      if (n.kind !== "app" || seen.has(n.id)) return;
      seen.add(n.id);
      // All endpoints are in `objs` by now (rebuild/animateTo populate it before
      // indexing); skip the rare edge whose vis is somehow missing.
      const pv = this.objs.get(n.id);
      const lv = this.objs.get(n.fn.id);
      const rv = this.objs.get(n.arg.id);
      if (pv && lv && rv) this.edgeList.push({ pv, lv, rv, depth }); // depth → the red/black tier colour
      walk(n.fn, depth + 1);
      walk(n.arg, depth + 1);
    };
    walk(this.display, 0);
  }

  // Edges are drawn from the live particle positions (so they follow tweens),
  // with function (left) edges and argument (right) edges in two distinct
  // strokes. Iterates the cached edge list (no per-frame tree walk). While
  // animating a huge tree, edges whose bounding box is off-screen are culled —
  // bounding per-frame geometry to what's visible (see viewRect).
  private drawEdges(): void {
    this.edges.clear();
    const v = this.viewRect();
    const dash = this.objs.size <= HEAVY; // big trees draw solid — dashing multiplies geometry every frame (same threshold as heavy())
    // Colour = depth TIER (red/black), style = fn solid / arg dashed. Each tier is a separate stroke
    // (one colour per Graphics stroke), so 4 strokes: {arg,fn} × {even,odd}. A node's parent-edge is
    // the opposite colour of its child-edges → you can trace direction even in a dense tree.
    for (const parity of [0, 1]) {
      for (const e of this.edgeList) {
        if (e.depth % 2 !== parity) continue;
        const p = e.pv.particle;
        const rp = e.rv.particle;
        if (!v || overlaps(p, rp, v)) {
          if (dash) dashedSegment(this.edges, p.x, p.y, rp.x, rp.y); // argument edge: dashed
          else this.edges.moveTo(p.x, p.y).lineTo(rp.x, rp.y);
        }
      }
      this.edges.stroke({ width: 2.5, color: edgeTierColor(parity) });
    }
    for (const parity of [0, 1]) {
      for (const e of this.edgeList) {
        if (e.depth % 2 !== parity) continue;
        const p = e.pv.particle;
        const lp = e.lv.particle;
        if (!v || overlaps(p, lp, v)) this.edges.moveTo(p.x, p.y).lineTo(lp.x, lp.y); // function edge: solid
      }
      this.edges.stroke({ width: 3, color: edgeTierColor(parity) });
    }
    this.placeRootMark();
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
    const spec = visSpec(n);
    const particle = new Particle({ texture: nodeTexture(), anchorX: 0.5, anchorY: 0.5, tint: spec.tint });
    this.particles.addParticle(particle);
    return { particle, baseScale: spec.radius / TEX_R, glyphSpec: spec.glyph, glyph: null };
  }

  // Show text glyphs only below GLYPH_MAX nodes (LOD): create the ones now needed,
  // tear down the ones we no longer want. Glyphs track their particle's transform.
  private applyGlyphLOD(): void {
    const show = this.objs.size <= GLYPH_MAX;
    for (const vis of this.objs.values()) {
      if (show && vis.glyphSpec && !vis.glyph) {
        const g = label(vis.glyphSpec.text, vis.glyphSpec.color, vis.glyphSpec.size);
        g.position.set(vis.particle.x, vis.particle.y);
        g.scale.set(vis.particle.scaleX / vis.baseScale);
        g.alpha = vis.particle.alpha;
        vis.glyph = g;
        this.glyphs.addChild(g);
      } else if (!show && vis.glyph) {
        vis.glyph.destroy();
        vis.glyph = null;
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
    this.rootMark.circle(0, 0, radiusOf(this.display.kind) + 6).stroke({ width: 3, color: theme.root });
    this.rootMarkKind = this.display.kind;
  }
  private placeRootMark(): void {
    const vis = this.objs.get(this.display.id);
    if (!vis) return;
    if (this.rootMarkKind !== this.display.kind) this.redrawRootMark(); // root kind changed → re-tessellate once
    this.rootMark.position.set(vis.particle.x, vis.particle.y);
  }
}

/** Emit dashed sub-segments along a→b into the graphics path (caller strokes once).
 *  Dashing the argument edge gives function vs argument a style cue, not just a
 *  colour one — the distinction survives 1-bit black-and-white. Exported so the
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

function collectNodes(n: Node, m = new Map<NodeId, Node>()): Map<NodeId, Node> {
  if (m.has(n.id)) return m; // DAG (graph mode): one record per shared node — a no-op on a tree
  m.set(n.id, n);
  if (n.kind === "app") {
    collectNodes(n.fn, m);
    collectNodes(n.arg, m);
  }
  return m;
}

function label(text: string, color: number, size: number): Text {
  const t = new Text({ text, style: { fontFamily: "monospace", fontSize: size, fill: color } });
  t.anchor.set(0.5);
  return t;
}

import { Container, Graphics, Rectangle, Text, type Ticker } from "pixi.js";
import { type Node, type NodeId, iotaTreeFrom, IOTA_ID_SPAN } from "../core/term";
import { IOTA_CODE, IOTA_BITCODE } from "../core/catalog";
import { type Layout, type LayoutFn } from "../core/layout";
import { theme } from "./theme";

const LAYOUT_MS = 360; // duration of the layout-toggle reflow
// Node/edge colours come from the active theme (theme.ts). Edges: function
// (left) = theme.fnEdge (warm), argument (right) = theme.argEdge (cool) — two
// distinct hues so `(ι X)` and `(X ι)` read differently.

interface Anim {
  id: NodeId;
  obj: Container;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromA: number;
  toA: number;
  fromS: number;
  toS: number;
  remove: boolean;
}

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Renders one connected term tree into a draggable Pixi container (§5.3). One
 * display object per node, keyed by id, so a reduction step can tween: nodes
 * that persist glide to their new position, fresh nodes grow in, dropped nodes
 * fade out (§6.3).
 */
export class TreeView {
  readonly container = new Container();
  private readonly edges = new Graphics();
  private readonly nodes = new Container();
  node: Node; // the logical term (used for reduction)
  private display: Node; // node with undiscovered S/K/I expanded to their ι-trees
  private lay: Layout;
  private readonly objs = new Map<NodeId, Container>();

  private anims: Anim[] = [];
  private elapsed = 0;
  private duration = 0;
  private onDone: (() => void) | null = null;
  private ticking = false;
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
  ) {
    this.node = node;
    this.display = this.expand(node);
    this.lay = this.layoutFn(this.display);
    this.container.addChild(this.edges, this.nodes);
    this.container.position.set(worldX, worldY);
    this.container.eventMode = "static";
    this.container.cursor = "grab";
    this.rebuild();
  }

  get rootWorld(): { x: number; y: number } {
    return { x: this.container.position.x, y: this.container.position.y };
  }

  destroy(): void {
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
    for (const [id, obj] of this.objs) {
      const target = newLay.pos.get(id)!;
      this.anims.push(mkAnim(id, obj, obj.position.x, obj.position.y, target.x, target.y, 1, 1, 1, 1));
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
    for (const [id, obj] of this.objs) {
      const dx = obj.position.x - p.x;
      const dy = obj.position.y - p.y;
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
    for (const [id, o] of this.objs) m.set(id, { x: base.x + o.position.x, y: base.y + o.position.y });
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
    for (const [id, obj] of this.objs) {
      const target = this.lay.pos.get(id)!;
      const fw = fromWorld.get(id);
      if (fw) {
        const sx = fw.x - base.x;
        const sy = fw.y - base.y;
        obj.position.set(sx, sy);
        this.anims.push(mkAnim(id, obj, sx, sy, target.x, target.y, 1, 1, 1, 1));
      } else {
        obj.position.set(target.x, target.y);
        obj.alpha = 0;
        obj.scale.set(0.3);
        this.anims.push(mkAnim(id, obj, target.x, target.y, target.x, target.y, 0, 1, 0.3, 1));
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
    for (const [id, o] of this.objs) from.set(id, { x: o.position.x, y: o.position.y });

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
        const obj = this.makeNode(n);
        obj.position.set(target.x, target.y);
        obj.alpha = 0;
        obj.scale.set(0.3);
        this.objs.set(id, obj);
        this.nodes.addChild(obj);
        this.anims.push(mkAnim(id, obj, target.x, target.y, target.x, target.y, 0, 1, 0.3, 1));
      }
    }
    // leaving nodes
    for (const [id, obj] of this.objs) {
      if (!newNodes.has(id)) {
        this.anims.push(mkAnim(id, obj, obj.position.x, obj.position.y, obj.position.x, obj.position.y, obj.alpha, 0, 1, 0.4, true));
      }
    }

    this.node = node;
    this.display = newDisplay;
    this.lay = newLay;
    this.updateHitArea();
    this.elapsed = 0;
    this.duration = duration;
    this.onDone = onDone;
    this.drawEdges();
    this.startTicker();
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
      a.obj.position.set(a.fromX + (a.toX - a.fromX) * e, a.fromY + (a.toY - a.fromY) * e);
      a.obj.alpha = a.fromA + (a.toA - a.fromA) * e;
      a.obj.scale.set(a.fromS + (a.toS - a.fromS) * e);
    }
    this.drawEdges();
    if (t >= 1) this.finish();
  }

  private finish(): void {
    if (!this.ticking && this.anims.length === 0) return;
    for (const a of this.anims) {
      if (a.remove) {
        this.objs.delete(a.id);
        a.obj.destroy({ children: true });
      } else {
        a.obj.position.set(a.toX, a.toY);
        a.obj.alpha = a.toA;
        a.obj.scale.set(a.toS);
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
  private expand(n: Node): Node {
    switch (n.kind) {
      case "comb": {
        // "Expand" view → every combinator's full ι-tree; otherwise only
        // undiscovered S/K/I are shown as ι (the discovery mask).
        const code = this.expandAll() ? IOTA_BITCODE[n.sym] : !this.isDiscovered(n.sym) ? IOTA_CODE[n.sym] : undefined;
        return code ? iotaTreeFrom(code, n.id) : n;
      }
      case "app":
        return { ...n, fn: this.expand(n.fn), arg: this.expand(n.arg) };
      default:
        return n;
    }
  }

  private rebuild(): void {
    for (const o of this.objs.values()) o.destroy({ children: true });
    this.objs.clear();
    for (const [id, n] of collectNodes(this.display)) {
      const obj = this.makeNode(n);
      const p = this.lay.pos.get(id)!;
      obj.position.set(p.x, p.y);
      this.objs.set(id, obj);
      this.nodes.addChild(obj);
    }
    this.drawEdges();
    this.updateHitArea();
  }

  // Edges are drawn from the live object positions (so they follow tweens), with
  // function (left) edges and argument (right) edges in two distinct strokes.
  private drawEdges(): void {
    this.edges.clear();
    const fn: Array<[number, number, number, number]> = [];
    const arg: Array<[number, number, number, number]> = [];
    const walk = (n: Node): void => {
      if (n.kind !== "app") return;
      const p = this.objs.get(n.id)?.position;
      const lp = this.objs.get(n.fn.id)?.position;
      const rp = this.objs.get(n.arg.id)?.position;
      if (p && lp) fn.push([p.x, p.y, lp.x, lp.y]);
      if (p && rp) arg.push([p.x, p.y, rp.x, rp.y]);
      walk(n.fn);
      walk(n.arg);
    };
    walk(this.display);
    for (const [x1, y1, x2, y2] of arg) this.edges.moveTo(x1, y1).lineTo(x2, y2);
    this.edges.stroke({ width: 2.5, color: theme.argEdge });
    for (const [x1, y1, x2, y2] of fn) this.edges.moveTo(x1, y1).lineTo(x2, y2);
    this.edges.stroke({ width: 3, color: theme.fnEdge });
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

  // Build the display object for one node. The display term only ever contains
  // discovered combinators (undiscovered S/K/I have been expanded to ι-trees).
  private makeNode(n: Node): Container {
    const c = new Container();
    if (n.kind === "iota") {
      c.addChild(new Graphics().circle(0, 0, 7).fill(theme.iota));
      c.addChild(label("ι", theme.iotaGlyph, 10));
    } else if (n.kind === "comb") {
      c.addChild(new Graphics().circle(0, 0, 15).fill(theme.node));
      c.addChild(label(n.sym, 0xffffff, 15));
    } else if (n.kind === "free") {
      c.addChild(new Graphics().circle(0, 0, 13).fill(theme.mutedDot));
      c.addChild(label(n.name, 0xffffff, 14));
    } else {
      c.addChild(new Graphics().circle(0, 0, 5).fill(theme.mutedDot));
    }
    return c;
  }
}

function mkAnim(
  id: NodeId,
  obj: Container,
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
  return { id, obj, fromX, fromY, toX, toY, fromA, toA, fromS, toS, remove };
}

function collectNodes(n: Node, m = new Map<NodeId, Node>()): Map<NodeId, Node> {
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
